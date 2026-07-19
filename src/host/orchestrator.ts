/**
 * The Orchestrator — owns every running agent, the event log, the inbox's
 * held promises, the scheduler, verification gates, and the merge queue. It
 * lives in the extension host and survives any number of webview open/close
 * cycles (design principle 1). The webview is a pure view over `state`.
 *
 * Depends only on `src/core/*` and the contracts in `./contracts` — the
 * concrete EventLog/WorktreeManager/AgentRunner implementations are injected,
 * which is also what makes crash-recovery and Phase 6 failure injection
 * testable.
 */

import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  ArgusConfig,
  ArgusEvent,
  ArgusEventBody,
  FleetState,
  Gate,
  GateResult,
  InboxItem,
  InboxItemId,
  InboxResolution,
  MergeConflictItem,
  QuestionItem,
  ScopeEscalationItem,
  TaskId,
  TaskSpec,
  VerifyFailureItem,
} from '../core/types';
import { initialState, isLivePhase, reduce } from '../core/reducer';
import { pathInScope } from '../core/scope';
import {
  AgentHandle,
  DecisionRequest,
  Disposable,
  EventLog,
  GateRunner,
  StartAgent,
  WorktreeInfo,
  WorktreeManager,
} from './contracts';

export interface OrchestratorDeps {
  /** Absolute path of the target repository root. */
  repoRoot: string;
  /** `<repoRoot>/.argus`. */
  argusDir: string;
  eventLog: EventLog;
  worktrees: WorktreeManager;
  startAgent: StartAgent;
  gates: GateRunner;
  config: ArgusConfig;
  /** Dependency-install command from the repo profile (e.g. `npm install`); null disables. */
  installCommand: string | null;
  /** Optional UI sink for non-state notifications. */
  toast?: (level: 'info' | 'warn' | 'error', text: string) => void;
  /** Injectable git exec for tests; resolves with exitCode instead of throwing. */
  execGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

interface HeldDecision {
  resolve: (r: InboxResolution) => void;
  reject: (e: Error) => void;
  taskId: TaskId;
}

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private fleet: FleetState;
  private readonly listeners = new Set<(e: ArgusEvent, s: FleetState) => void>();
  private readonly handles = new Map<TaskId, AgentHandle>();
  private readonly held = new Map<InboxItemId, HeldDecision>();
  private readonly itemCounters = new Map<TaskId, number>();
  private baseBranch: string | null = null;
  private mergeChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private budgetTripped = false;
  /**
   * Synchronous scheduling reservation. A QUEUED task becomes ineligible only
   * when its `task-started` event folds, which happens after an await — so two
   * pump() calls in the same tick would otherwise both schedule it (observed
   * live: duplicate provision → spurious task failure). Reserved at selection
   * time, released once `task-started` is folded or the run attempt dies.
   */
  private readonly scheduling = new Set<TaskId>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.fleet = initialState(deps.config);
  }

  get state(): FleetState {
    return this.fleet;
  }

  get repoRoot(): string {
    return this.deps.repoRoot;
  }

  onEvent(listener: (e: ArgusEvent, s: FleetState) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * Replay the log, then append `orchestrator-started` — whose reducer
   * semantics mark any task that was live when the previous process died as
   * FAILED (worktree preserved). Returns worktrees left behind by dead tasks.
   */
  async start(version: string): Promise<WorktreeInfo[]> {
    const { events, skippedLines } = await this.deps.eventLog.replay();
    for (const e of events) {
      this.fleet = reduce(this.fleet, e);
    }
    if (skippedLines > 0) {
      this.deps.toast?.('warn', `Event log: skipped ${skippedLines} corrupt line(s) during replay.`);
    }
    // Fold, then persist the restart marker like any other event.
    this.deps.eventLog.onEvent((e) => {
      this.fleet = reduce(this.fleet, e);
      for (const l of [...this.listeners]) {
        try {
          l(e, this.fleet);
        } catch {
          // A bad listener never takes down the orchestrator.
        }
      }
    });
    await this.append({ type: 'orchestrator-started', version, config: this.deps.config });
    this.baseBranch = await this.detectBaseBranch();
    const live = Object.values(this.fleet.tasks)
      .filter((t) => isLivePhase(t.phase) || t.phase === 'MERGING')
      .map((t) => t.spec.id);
    return this.deps.worktrees.findStale(live);
  }

  // -------------------------------------------------------------------------
  // Task lifecycle
  // -------------------------------------------------------------------------

  async createTask(spec: TaskSpec): Promise<void> {
    if (this.fleet.tasks[spec.id] !== undefined) {
      throw new Error(`Task id '${spec.id}' already exists`);
    }
    await this.append({ type: 'task-created', spec });
    await this.append({ type: 'task-queued', taskId: spec.id });
    void this.pump();
  }

  /** Start as many QUEUED tasks as the concurrency cap allows. */
  private async pump(): Promise<void> {
    if (this.disposed || this.budgetTripped) {
      return;
    }
    const tasks = this.fleet.taskOrder.map((id) => this.fleet.tasks[id]);
    const liveCount = tasks.filter((t) => isLivePhase(t.phase)).length + this.scheduling.size;
    const capacity = this.fleet.config.maxConcurrentAgents - liveCount;
    const queued = tasks
      .filter((t) => t.phase === 'QUEUED' && !this.scheduling.has(t.spec.id))
      .slice(0, Math.max(0, capacity));
    for (const t of queued) {
      this.scheduling.add(t.spec.id);
      void this.runTask(t.spec.id)
        .catch(async (err) => {
          await this.append({
            type: 'task-failed',
            taskId: t.spec.id,
            reason: `orchestrator error: ${String(err).slice(0, 300)}`,
          });
        })
        .finally(() => this.scheduling.delete(t.spec.id));
    }
  }

  private async runTask(taskId: TaskId): Promise<void> {
    const spec = this.fleet.tasks[taskId]?.spec;
    if (spec === undefined || this.fleet.tasks[taskId].phase !== 'QUEUED') {
      return;
    }
    const wt = await this.deps.worktrees.provision(taskId);
    await this.append({ type: 'task-started', taskId, worktreePath: wt.path, branch: wt.branch });
    // The fold above made this task live; release the scheduling reservation
    // so it stops double-counting against capacity.
    this.scheduling.delete(taskId);

    if (this.fleet.config.installDepsOnProvision && this.deps.installCommand !== null) {
      await this.append({
        type: 'tool-call',
        taskId,
        tool: 'argus',
        detail: `Provisioning: ${this.deps.installCommand}`,
        paths: [],
      });
      const r = await this.deps.gates.run(wt.path, { name: 'install', command: this.deps.installCommand });
      if (r.exitCode !== 0) {
        await this.append({
          type: 'agent-text',
          taskId,
          text: `Dependency install failed (exit ${r.exitCode}) — continuing; the agent can install what it needs.`,
        });
      }
    }

    const handle = this.deps.startAgent({
      spec,
      worktreePath: wt.path,
      config: this.fleet.config,
      logDir: path.join(this.deps.argusDir, 'logs'),
      callbacks: {
        emit: (body: ArgusEventBody) => {
          void this.append(body).then(() => this.checkBudgets(taskId));
        },
        decide: (request: DecisionRequest) => this.raiseAndWait(taskId, request),
      },
    });
    this.handles.set(taskId, handle);

    const outcome = await handle.done;
    this.handles.delete(taskId);

    if (isTerminal(this.fleet, taskId)) {
      return; // already terminal (stopTask / budget kill)
    }
    if (outcome.result === 'aborted') {
      await this.append({ type: 'task-cancelled', taskId, reason: outcome.detail });
      void this.pump();
      return;
    }
    if (outcome.result === 'error') {
      await this.append({ type: 'task-failed', taskId, reason: outcome.detail });
      void this.pump();
      return;
    }
    await this.verifyTask(taskId, wt.path);
    void this.pump();
  }

  /** Run the task's gates; a failure raises a verify-failure inbox item. */
  private async verifyTask(taskId: TaskId, worktreePath: string): Promise<void> {
    await this.append({ type: 'task-verifying', taskId });
    const spec = this.fleet.tasks[taskId].spec;
    const gates: Gate[] =
      spec.gates.length > 0
        ? spec.gates
        : this.fleet.config.verifyCommand !== null
          ? [{ name: 'verify', command: this.fleet.config.verifyCommand }]
          : [];

    for (const gate of gates) {
      const r = await this.deps.gates.run(worktreePath, gate);
      const result: GateResult = {
        name: gate.name,
        command: gate.command,
        exitCode: r.exitCode,
        outputTail: r.outputTail,
        durationMs: r.durationMs,
        finishedAt: new Date().toISOString(),
      };
      await this.append({ type: 'gate-finished', taskId, result });
      if (r.exitCode !== 0) {
        const resolution = await this.raiseAndWait(taskId, { kind: 'verify-failure', gate: result }).catch(
          () => null,
        );
        if (resolution === null) {
          return; // task cancelled while parked
        }
        if (resolution.rkind === 'verify-failure') {
          if (resolution.action === 'send-back') {
            await this.sendBack(taskId, worktreePath, result, resolution.note);
            return;
          }
          if (resolution.action === 'abandon') {
            await this.append({ type: 'task-failed', taskId, reason: `gate '${gate.name}' failed; abandoned` });
            return;
          }
          // 'override' falls through to the next gate.
        }
      }
    }
    await this.append({ type: 'task-ready', taskId });
    if (this.fleet.config.autoMerge || this.fleet.tasks[taskId].spec.autoMerge) {
      this.enqueueMerge(taskId);
    }
  }

  /** Re-run the agent in its worktree with the gate failure as the prompt. */
  private async sendBack(
    taskId: TaskId,
    worktreePath: string,
    failed: GateResult,
    note: string | null,
  ): Promise<void> {
    const spec = this.fleet.tasks[taskId].spec;
    const fixSpec: TaskSpec = {
      ...spec,
      prompt: [
        `You previously worked on this task in this worktree: ${spec.title}.`,
        `The verify gate '${failed.name}' (\`${failed.command}\`) failed with exit code ${failed.exitCode}.`,
        note !== null && note.length > 0 ? `Operator note: ${note}` : null,
        'Gate output (tail):',
        '```',
        failed.outputTail,
        '```',
        'Fix the failure, keep your previous work intact, commit, and finish.',
      ]
        .filter((l): l is string => l !== null)
        .join('\n'),
    };
    await this.append({ type: 'task-resumed', taskId, itemId: 'send-back' });
    const handle = this.deps.startAgent({
      spec: fixSpec,
      worktreePath,
      config: this.fleet.config,
      logDir: path.join(this.deps.argusDir, 'logs'),
      callbacks: {
        emit: (body) => void this.append(body).then(() => this.checkBudgets(taskId)),
        decide: (request) => this.raiseAndWait(taskId, request),
      },
    });
    this.handles.set(taskId, handle);
    const outcome = await handle.done;
    this.handles.delete(taskId);
    if (isTerminal(this.fleet, taskId)) {
      return;
    }
    if (outcome.result !== 'success') {
      await this.append({
        type: outcome.result === 'aborted' ? 'task-cancelled' : 'task-failed',
        taskId,
        reason: outcome.detail ?? 'send-back run ended',
      });
      return;
    }
    await this.verifyTask(taskId, worktreePath);
  }

  async stopTask(taskId: TaskId, reason: string | null): Promise<void> {
    for (const [itemId, held] of [...this.held]) {
      if (held.taskId === taskId) {
        held.reject(new Error('task stopped'));
        this.held.delete(itemId);
      }
    }
    const handle = this.handles.get(taskId);
    if (handle !== undefined) {
      await handle.stop(reason);
    } else if (this.fleet.tasks[taskId] !== undefined && !isTerminal(this.fleet, taskId)) {
      await this.append({ type: 'task-cancelled', taskId, reason });
    }
    void this.pump();
  }

  async stopAll(reason: string): Promise<void> {
    for (const id of this.fleet.taskOrder) {
      if (!isTerminal(this.fleet, id) && this.fleet.tasks[id].phase !== 'DRAFT') {
        await this.stopTask(id, reason);
      }
    }
  }

  async steer(taskId: TaskId, message: string): Promise<void> {
    const handle = this.handles.get(taskId);
    if (handle === undefined) {
      throw new Error(`No live agent for '${taskId}'`);
    }
    await handle.steer(message);
    await this.append({ type: 'task-steered', taskId, message: message.slice(0, 240) });
  }

  // -------------------------------------------------------------------------
  // Inbox
  // -------------------------------------------------------------------------

  /** Raise an inbox item, mark the task blocked, and hold until answered. */
  private raiseAndWait(taskId: TaskId, request: DecisionRequest | { kind: 'verify-failure'; gate: GateResult } | { kind: 'merge-conflict'; files: string[]; detail: string }): Promise<InboxResolution> {
    const n = (this.itemCounters.get(taskId) ?? this.fleet.inbox.filter((i) => i.taskId === taskId).length) + 1;
    this.itemCounters.set(taskId, n);
    const id: InboxItemId = `${taskId}#${n}`;
    const raisedAt = new Date().toISOString();
    const base = { id, taskId, raisedAt, resolvedAt: null };
    let item: InboxItem;
    switch (request.kind) {
      case 'question':
        item = { ...base, kind: 'question', header: request.header, question: request.question, options: request.options, multiSelect: request.multiSelect, resolution: null } satisfies QuestionItem;
        break;
      case 'scope-escalation':
        item = { ...base, kind: 'scope-escalation', tool: request.tool, path: request.path, overlappingTasks: this.overlapping(taskId, request.path), resolution: null } satisfies ScopeEscalationItem;
        break;
      case 'verify-failure':
        item = { ...base, kind: 'verify-failure', gate: request.gate, resolution: null } satisfies VerifyFailureItem;
        break;
      case 'merge-conflict':
        item = { ...base, kind: 'merge-conflict', files: request.files, detail: request.detail, resolution: null } satisfies MergeConflictItem;
        break;
    }
    return new Promise<InboxResolution>((resolve, reject) => {
      this.held.set(id, { resolve, reject, taskId });
      void this.append({ type: 'inbox-raised', item })
        .then(() => this.append({ type: 'task-blocked', taskId, itemId: id }))
        .catch(reject);
    });
  }

  /** Answer an inbox item from the UI. Resolves the held promise if any. */
  async answer(itemId: InboxItemId, resolution: InboxResolution): Promise<void> {
    const item = this.fleet.inbox.find((i) => i.id === itemId);
    if (item === undefined || item.resolvedAt !== null) {
      throw new Error(`Inbox item '${itemId}' is not pending`);
    }
    if (item.kind !== resolution.rkind) {
      throw new Error(`Resolution kind '${resolution.rkind}' does not match item kind '${item.kind}'`);
    }
    await this.append({ type: 'inbox-resolved', itemId, resolution });
    // Scope expansion amends the task's declared scope in fleet state too —
    // the runner already widened its live copy; this keeps display and the
    // overlap hints truthful.
    if (resolution.rkind === 'scope-escalation' && resolution.action === 'expand-scope') {
      await this.append({ type: 'scope-expanded', taskId: item.taskId, glob: resolution.glob });
    }
    const held = this.held.get(itemId);
    if (held !== undefined) {
      this.held.delete(itemId);
      await this.append({ type: 'task-resumed', taskId: item.taskId, itemId });
      held.resolve(resolution);
    }
  }

  /** Other live tasks whose declared scope covers this path (collision hint). */
  private overlapping(exceptTaskId: TaskId, relPath: string): TaskId[] {
    const hits: TaskId[] = [];
    for (const id of this.fleet.taskOrder) {
      if (id === exceptTaskId) {
        continue;
      }
      const t = this.fleet.tasks[id];
      if (!isLivePhase(t.phase)) {
        continue;
      }
      if (pathInScope(t.spec.scope, relPath)) {
        hits.push(id);
      }
    }
    return hits;
  }

  // -------------------------------------------------------------------------
  // Merge queue — strictly one MERGING task fleet-wide
  // -------------------------------------------------------------------------

  enqueueMerge(taskId: TaskId): void {
    this.mergeChain = this.mergeChain.then(() => this.mergeOne(taskId)).catch(() => undefined);
  }

  private async mergeOne(taskId: TaskId): Promise<void> {
    const t = this.fleet.tasks[taskId];
    if (t === undefined || t.phase !== 'READY' || t.worktreePath === null || t.branch === null) {
      return;
    }
    if (this.baseBranch === null) {
      this.deps.toast?.('error', 'Merge disabled: repository HEAD is detached or unreadable.');
      return;
    }
    await this.append({ type: 'merge-started', taskId });
    const git = this.deps.execGit ?? defaultGit;
    const wt = t.worktreePath;

    // Rebase the task branch onto the (possibly moved) base branch.
    const rebase = await git(['rebase', this.baseBranch], wt);
    if (rebase.exitCode !== 0) {
      const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], wt);
      const files = conflicts.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
      await git(['rebase', '--abort'], wt);
      const resolution = await this.raiseAndWait(taskId, {
        kind: 'merge-conflict',
        files,
        detail: (rebase.stderr || rebase.stdout).slice(-1000),
      }).catch(() => null);
      if (resolution === null || resolution.rkind !== 'merge-conflict') {
        return;
      }
      if (resolution.action === 'abandon') {
        await this.append({ type: 'task-failed', taskId, reason: 'merge conflict; abandoned' });
        return;
      }
      if (resolution.action === 'agent-fix') {
        await this.agentFixConflict(taskId, wt, files);
        return;
      }
      // 'open-editor': hand control back — task returns to READY for a retry.
      await this.append({ type: 'task-ready', taskId });
      return;
    }

    // Verify once more post-rebase — this is what catches semantic conflicts.
    const spec = t.spec;
    const gates: Gate[] =
      spec.gates.length > 0
        ? spec.gates
        : this.fleet.config.verifyCommand !== null
          ? [{ name: 'verify', command: this.fleet.config.verifyCommand }]
          : [];
    for (const gate of gates) {
      const r = await this.deps.gates.run(wt, gate);
      if (r.exitCode !== 0) {
        const result: GateResult = { name: gate.name, command: gate.command, exitCode: r.exitCode, outputTail: r.outputTail, durationMs: r.durationMs, finishedAt: new Date().toISOString() };
        await this.append({ type: 'gate-finished', taskId, result });
        const resolution = await this.raiseAndWait(taskId, { kind: 'verify-failure', gate: result }).catch(() => null);
        if (resolution === null || resolution.rkind !== 'verify-failure' || resolution.action === 'abandon') {
          await this.append({ type: 'task-failed', taskId, reason: `post-rebase gate '${gate.name}' failed` });
          return;
        }
        if (resolution.action === 'send-back') {
          await this.sendBack(taskId, wt, result, null);
          return;
        }
        // override → continue
      }
    }

    // Fast-forward the base branch in the primary checkout.
    const merge = await git(['merge', '--ff-only', t.branch], this.deps.repoRoot);
    if (merge.exitCode !== 0) {
      const resolution = await this.raiseAndWait(taskId, {
        kind: 'merge-conflict',
        files: [],
        detail: `ff-only merge failed in the primary checkout:\n${(merge.stderr || merge.stdout).slice(-800)}`,
      }).catch(() => null);
      if (resolution !== null && resolution.rkind === 'merge-conflict' && resolution.action !== 'abandon') {
        await this.append({ type: 'task-ready', taskId });
      } else {
        await this.append({ type: 'task-failed', taskId, reason: 'merge failed in primary checkout' });
      }
      return;
    }
    const sha = await git(['rev-parse', 'HEAD'], this.deps.repoRoot);
    await this.append({ type: 'merge-finished', taskId, mergeCommit: sha.stdout.trim() });
    // Teardown: agent is gone (merge only runs post-completion), safe to remove.
    try {
      await this.deps.worktrees.remove(taskId, { force: true, deleteBranch: true });
    } catch (err) {
      this.deps.toast?.('warn', `Worktree cleanup for '${taskId}' failed: ${String(err).slice(0, 200)}`);
    }
  }

  /** Spawn a fixer agent in the conflicted worktree. */
  private async agentFixConflict(taskId: TaskId, worktreePath: string, files: string[]): Promise<void> {
    const spec = this.fleet.tasks[taskId].spec;
    const fixSpec: TaskSpec = {
      ...spec,
      // The fixer may touch anything the rebase touches.
      scope: { include: ['**'] },
      prompt: [
        `Your branch for task '${spec.title}' needs to be rebased onto '${this.baseBranch}'.`,
        `Run \`git rebase ${this.baseBranch}\`, resolve every conflict faithfully to BOTH intents (yours and the base's), continue the rebase to completion, and run the project's tests if present.`,
        files.length > 0 ? `Files that conflicted on the last attempt:\n${files.map((f) => `- ${f}`).join('\n')}` : null,
        'Do not force-push, do not switch branches. Finish with a clean `git status`.',
      ]
        .filter((l): l is string => l !== null)
        .join('\n'),
    };
    await this.append({ type: 'task-resumed', taskId, itemId: 'merge-fix' });
    const handle = this.deps.startAgent({
      spec: fixSpec,
      worktreePath,
      config: this.fleet.config,
      logDir: path.join(this.deps.argusDir, 'logs'),
      callbacks: {
        emit: (body) => void this.append(body).then(() => this.checkBudgets(taskId)),
        decide: (request) => this.raiseAndWait(taskId, request),
      },
    });
    this.handles.set(taskId, handle);
    const outcome = await handle.done;
    this.handles.delete(taskId);
    if (outcome.result === 'success') {
      await this.append({ type: 'task-ready', taskId });
      this.enqueueMerge(taskId);
    } else {
      await this.append({ type: 'task-failed', taskId, reason: `conflict fixer: ${outcome.detail ?? outcome.result}` });
    }
  }

  // -------------------------------------------------------------------------
  // Config, budgets, cleanup
  // -------------------------------------------------------------------------

  async setConfig(config: ArgusConfig): Promise<void> {
    await this.append({ type: 'config-changed', config });
    const file = path.join(this.deps.argusDir, 'config.json');
    await fs.mkdir(this.deps.argusDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
    void this.pump();
  }

  private checkBudgets(taskId: TaskId): void {
    const t = this.fleet.tasks[taskId];
    if (t !== undefined) {
      const cap = t.spec.budgetUsd ?? this.fleet.config.perTaskBudgetUsd;
      if (cap !== null && t.costUsd > cap && !isTerminal(this.fleet, taskId)) {
        this.deps.toast?.('warn', `Task '${taskId}' exceeded its $${cap} budget — stopping it.`);
        void this.stopTask(taskId, `budget exceeded ($${t.costUsd.toFixed(2)} > $${cap})`);
      }
    }
    const fleetCap = this.fleet.config.fleetBudgetUsd;
    if (fleetCap !== null && this.fleet.fleetCostUsd > fleetCap && !this.budgetTripped) {
      this.budgetTripped = true;
      this.deps.toast?.('error', `Fleet budget $${fleetCap} exhausted — stopping all tasks.`);
      void this.stopAll(`fleet budget exceeded ($${this.fleet.fleetCostUsd.toFixed(2)} > $${fleetCap})`);
    }
  }

  async cleanupStaleWorktrees(): Promise<number> {
    const live = Object.values(this.fleet.tasks)
      .filter((t) => isLivePhase(t.phase) || t.phase === 'MERGING')
      .map((t) => t.spec.id);
    const stale = await this.deps.worktrees.findStale(live);
    let removed = 0;
    for (const wt of stale) {
      try {
        await this.deps.worktrees.remove(wt.taskId, { force: true, deleteBranch: false });
        removed += 1;
      } catch (err) {
        this.deps.toast?.('warn', `Could not remove stale worktree '${wt.taskId}': ${String(err).slice(0, 200)}`);
      }
    }
    return removed;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [, held] of this.held) {
      held.reject(new Error('orchestrator disposed'));
    }
    this.held.clear();
    for (const [, handle] of [...this.handles]) {
      await handle.stop('extension deactivated');
    }
    await this.deps.eventLog.close();
  }

  // -------------------------------------------------------------------------

  private append(body: ArgusEventBody): Promise<ArgusEvent> {
    return this.deps.eventLog.append(body);
  }

  private async detectBaseBranch(): Promise<string | null> {
    const git = this.deps.execGit ?? defaultGit;
    const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], this.deps.repoRoot);
    const name = r.stdout.trim();
    return r.exitCode === 0 && name.length > 0 && name !== 'HEAD' ? name : null;
  }
}

function isTerminal(s: FleetState, taskId: TaskId): boolean {
  const p = s.tasks[taskId]?.phase;
  return p === 'DONE' || p === 'FAILED' || p === 'CANCELLED';
}

function defaultGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(
      `git ${args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`,
      { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ stdout, stderr, exitCode: err === null ? 0 : (err.code as number | undefined) ?? 1 });
      },
    );
  });
}
