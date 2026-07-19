/**
 * AgentRunner — `startAgent` over the Claude Agent SDK's `query`.
 *
 * The runner owns one live agent session per task: it assembles the query
 * options, streams the task prompt (plus any steer messages) through an async
 * input generator, folds the SDK message stream into semantic `ArgusEventBody`s,
 * and enforces the scope/pushback policy inside `canUseTool` — the blocking
 * inbox mechanism Spike B validated. Policy *decisions* live in
 * `src/core/guard`; this file is the imperative half that acts on the verdicts.
 *
 * Two Spike B findings are load-bearing here: `allowedTools` must never carry
 * bare entries (they shadow `canUseTool`), so it is not set at all; and
 * AskUserQuestion is answered by returning `updatedInput.answers` keyed by
 * question *text*.
 *
 * Host-only module: imports node builtins and the Agent SDK, never `vscode`.
 * The SDK `query` function is injectable (`AgentRunnerDeps.queryFn`) so the
 * entire policy is unit-testable with a scripted fake — no subprocess spawns.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  HookCallback,
  Options,
  PermissionResult,
  PreToolUseHookInput,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { AGENT_TEXT_CAP } from '../core/types';
import type {
  ArgusEventBody,
  InboxResolution,
  QuestionOption,
  QuestionResolution,
  Scope,
} from '../core/types';
import { checkToolCall } from '../core/guard';
import { buildSystemPromptAppend } from '../core/prompt';
import { normalizePath, toRepoRelative } from '../core/scope';
import type {
  AgentHandle,
  AgentOutcome,
  DecisionRequest,
  StartAgentOptions,
} from './contracts';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface AgentRunnerDeps {
  /** The SDK entry point; injectable so tests drive a scripted fake. */
  queryFn?: typeof query;
  /** Injectable clock (ISO string), reserved for deterministic tests. */
  now?: () => string;
  /** Raw-stream log sink; default is a serialized fs append that swallows
   * errors after one console.warn. */
  appendLog?: (file: string, line: string) => void;
}

/** Spawn an agent for a task. One call per task run. */
export function startAgent(opts: StartAgentOptions, deps: AgentRunnerDeps = {}): AgentHandle {
  const session = new AgentSession(opts, deps);
  return {
    taskId: opts.spec.id,
    steer: (message) => session.steer(message),
    stop: (reason) => session.stop(reason),
    done: session.done,
  };
}

// ---------------------------------------------------------------------------
// Constants & small helpers
// ---------------------------------------------------------------------------

/** Cap on the toolUseID ring that dedupes path-read emissions. */
const READ_ID_CAP = 64;
/** Cap on Bash command text shown in a tool-call detail line. */
const BASH_DETAIL_CAP = 80;
/** Cap on outcome detail strings. */
const DETAIL_CAP = 400;

/** Sentinel: `decide()` rejected — the task is being cancelled. */
class DecideCancelledError extends Error {
  constructor() {
    super('decide() rejected: task is being cancelled');
    this.name = 'DecideCancelledError';
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** file_path / notebook_path / path, defensively (mirrors guard.ts). */
function extractToolPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const o = input as Record<string, unknown>;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 0) {
      return v;
    }
  }
  return null;
}

function extractStringField(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function isAbsolutePathish(p: string): boolean {
  return /^[a-z]:\//i.test(p) || p.startsWith('/');
}

/**
 * Repo-relative form of a tool path: absolute paths resolve against the
 * worktree (null when outside it); relative paths are the agent's cwd-relative
 * form already and normalize as-is.
 */
function toWorktreeRelative(worktreeRoot: string, raw: string): string | null {
  const norm = normalizePath(raw);
  if (isAbsolutePathish(norm)) {
    return toRepoRelative(worktreeRoot, norm);
  }
  return norm;
}

const PATH_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Read']);

/** One human line + extracted repo-relative paths for a tool-call event. */
function summarizeToolCall(
  tool: string,
  input: unknown,
  worktreeRoot: string,
): { detail: string; paths: string[] } {
  if (PATH_TOOLS.has(tool)) {
    const raw = extractToolPath(input);
    if (raw === null) {
      return { detail: tool, paths: [] };
    }
    const rel = toWorktreeRelative(worktreeRoot, raw);
    return {
      detail: `${tool} ${rel !== null && rel !== '' ? rel : normalizePath(raw)}`,
      paths: rel !== null && rel !== '' ? [rel] : [],
    };
  }
  if (tool === 'Bash') {
    const command = extractStringField(input, 'command');
    return {
      detail: command !== null ? `Bash: ${command.slice(0, BASH_DETAIL_CAP)}` : 'Bash',
      paths: [],
    };
  }
  if (tool === 'Glob' || tool === 'Grep') {
    const pattern = extractStringField(input, 'pattern');
    return { detail: pattern !== null ? `${tool} ${pattern}` : tool, paths: [] };
  }
  return { detail: tool, paths: [] };
}

/**
 * The answer string for one question, per the Spike B channel:
 * labels joined for multiSelect, first label for single-select, freeText as
 * fallback, and `label — freeText` when the human chose an option AND typed.
 */
function answerString(resolution: QuestionResolution, multiSelect: boolean): string {
  const labels = Array.isArray(resolution.optionLabels) ? resolution.optionLabels : [];
  const freeText =
    typeof resolution.freeText === 'string' && resolution.freeText.length > 0
      ? resolution.freeText
      : null;
  const labelPart = multiSelect ? labels.join(', ') : labels[0] ?? '';
  if (labels.length === 0) {
    return freeText ?? '';
  }
  if (freeText !== null) {
    return `${labelPart} — ${freeText}`;
  }
  return labelPart;
}

/** Default raw-log sink: serialized append, errors swallowed after one warn. */
function makeDefaultAppendLog(): (file: string, line: string) => void {
  let chain: Promise<void> = Promise.resolve();
  let warned = false;
  const dirsReady = new Set<string>();
  return (file, line) => {
    chain = chain
      .then(async () => {
        const dir = dirname(file);
        if (!dirsReady.has(dir)) {
          await mkdir(dir, { recursive: true });
          dirsReady.add(dir);
        }
        await appendFile(file, line + '\n');
      })
      .catch((err) => {
        if (!warned) {
          warned = true;
          console.warn(`Argus: raw log append failed for ${file}:`, err);
        }
      });
  };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

class AgentSession {
  private readonly opts: StartAgentOptions;
  private readonly appendLogFn: (file: string, line: string) => void;
  private readonly logFile: string;
  private readonly abort = new AbortController();

  /** Mutable: grows via expand-scope escalation resolutions. */
  private currentScope: Scope;

  /** Assistant message ids already counted toward usage (parallel tool calls
   * repeat the same id across several stream messages). */
  private readonly countedMessageIds = new Set<string>();

  /** Ring of toolUseIDs that already emitted path-read (hook + canUseTool can
   * both fire for one Read call). */
  private readonly readIdRing: string[] = [];
  private readonly readIdSet = new Set<string>();

  // Streaming input: the generator yields the task prompt, then parks on this
  // queue. `steer()` enqueues; the message loop wakes it after each `result`.
  private readonly steerQueue: string[] = [];
  private inputEnded = false;
  private inputWaiter: ((next: string | null) => void) | null = null;

  private stopRequested = false;
  private stopReason: string | null = null;
  private lastOutcome: AgentOutcome | null = null;

  private resolveDone!: (outcome: AgentOutcome) => void;
  readonly done: Promise<AgentOutcome>;
  private readonly runPromise: Promise<void>;

  constructor(opts: StartAgentOptions, deps: AgentRunnerDeps) {
    this.opts = opts;
    this.appendLogFn = deps.appendLog ?? makeDefaultAppendLog();
    this.logFile = join(opts.logDir, `${opts.spec.id}.jsonl`);
    this.currentScope = { include: [...opts.spec.scope.include] };
    this.done = new Promise<AgentOutcome>((resolve) => {
      this.resolveDone = resolve;
    });
    const queryFn = deps.queryFn ?? query;
    this.runPromise = this.run(queryFn);
  }

  // -- public handle behavior ----------------------------------------------

  async steer(message: string): Promise<void> {
    if (this.inputEnded || this.stopRequested) {
      throw new Error(`cannot steer task ${this.opts.spec.id}: agent session has ended`);
    }
    this.steerQueue.push(message);
  }

  stop(reason: string | null): Promise<void> {
    if (!this.stopRequested) {
      this.stopRequested = true;
      this.stopReason = reason;
      this.endInput();
      this.abort.abort();
    }
    return this.runPromise;
  }

  // -- options assembly ----------------------------------------------------

  private buildOptions(): Options {
    const { spec, config, worktreePath } = this.opts;

    // Subscription auth must win: strip any API key from the inherited env.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env['ANTHROPIC_API_KEY'];

    const options: Options = {
      cwd: worktreePath,
      model: spec.model,
      effort: spec.effort,
      maxTurns: 200,
      permissionMode: 'default',
      abortController: this.abort,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildSystemPromptAppend(spec, config),
      },
      env,
      // SDK isolation mode: the default loads user AND project settings; an
      // operator's personal ~/.claude config must not leak into fleet agents.
      settingSources: [],
      // NOTE (Spike B): no `allowedTools` / `disallowedTools` — bare entries
      // shadow canUseTool. No `thinking` key — Fable rejects explicit
      // disabled. No `askUserQuestionTimeout` — the default 'never' is what a
      // blocking inbox needs.
      canUseTool: (toolName, input, callOptions) =>
        this.canUseTool(toolName, input, callOptions.toolUseID),
      hooks: {
        PreToolUse: [{ hooks: [this.preToolUse] }],
      },
    };

    const budget = spec.budgetUsd ?? config.perTaskBudgetUsd;
    if (budget !== null && budget !== undefined) {
      options.maxBudgetUsd = budget;
    }
    return options;
  }

  // -- streaming input -----------------------------------------------------

  private userMessage(text: string): SDKUserMessage {
    return {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    };
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    yield this.userMessage(this.opts.spec.prompt);
    for (;;) {
      const next = await this.nextInput();
      if (next === null) {
        return;
      }
      yield this.userMessage(next);
    }
  }

  /** How many queued steer messages the last `result` released for delivery.
   * Steers arriving mid-turn stay parked until the turn's result. */
  private deliverableSteers = 0;

  private nextInput(): Promise<string | null> {
    if (this.deliverableSteers > 0 && this.steerQueue.length > 0) {
      this.deliverableSteers--;
      return Promise.resolve(this.steerQueue.shift() as string);
    }
    if (this.inputEnded) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      this.inputWaiter = resolve;
    });
  }

  /** After a `result`: release the queued steer messages, or end the input
   * stream so the session closes normally. */
  private settleInputAfterResult(): void {
    if (this.steerQueue.length === 0) {
      this.endInput();
      return;
    }
    this.deliverableSteers = this.steerQueue.length;
    if (this.inputWaiter !== null) {
      const waiter = this.inputWaiter;
      this.inputWaiter = null;
      this.deliverableSteers--;
      waiter(this.steerQueue.shift() as string);
    }
    // No waiter parked: the generator drains the released messages on its
    // next nextInput() calls.
  }

  private endInput(): void {
    this.inputEnded = true;
    this.steerQueue.length = 0;
    this.deliverableSteers = 0;
    if (this.inputWaiter !== null) {
      const waiter = this.inputWaiter;
      this.inputWaiter = null;
      waiter(null);
    }
  }

  // -- event plumbing ------------------------------------------------------

  /** Fire-and-forget: a throwing listener must never kill the session. */
  private emit(body: ArgusEventBody): void {
    try {
      this.opts.callbacks.emit(body);
    } catch {
      // Deliberately swallowed.
    }
  }

  private emitPathReadOnce(toolUseID: string | undefined, path: string): void {
    if (toolUseID !== undefined && this.readIdSet.has(toolUseID)) {
      return;
    }
    if (toolUseID !== undefined) {
      this.readIdSet.add(toolUseID);
      this.readIdRing.push(toolUseID);
      if (this.readIdRing.length > READ_ID_CAP) {
        const evicted = this.readIdRing.shift() as string;
        this.readIdSet.delete(evicted);
      }
    }
    this.emit({ type: 'path-read', taskId: this.opts.spec.id, path });
  }

  private async decideOrCancel(request: DecisionRequest): Promise<InboxResolution> {
    try {
      return await this.opts.callbacks.decide(request);
    } catch {
      throw new DecideCancelledError();
    }
  }

  // -- PreToolUse hook -----------------------------------------------------

  private readonly preToolUse: HookCallback = async (input, toolUseID) => {
    try {
      if ((input as { hook_event_name?: string }).hook_event_name !== 'PreToolUse') {
        return { continue: true };
      }
      const hookInput = input as PreToolUseHookInput;
      const tool = hookInput.tool_name;
      const { detail, paths } = summarizeToolCall(tool, hookInput.tool_input, this.opts.worktreePath);
      this.emit({ type: 'tool-call', taskId: this.opts.spec.id, tool, detail, paths });

      // Read may be auto-allowed and never reach canUseTool — record it here.
      if (tool === 'Read') {
        const raw = extractToolPath(hookInput.tool_input);
        const rel = raw !== null ? toWorktreeRelative(this.opts.worktreePath, raw) : null;
        if (rel !== null && rel !== '') {
          this.emitPathReadOnce(toolUseID ?? hookInput.tool_use_id, rel);
        }
      }
    } catch {
      // A hook must never throw into the SDK.
    }
    return { continue: true };
  };

  // -- canUseTool policy ---------------------------------------------------

  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    toolUseID: string | undefined,
  ): Promise<PermissionResult> {
    try {
      if (toolName === 'AskUserQuestion') {
        return await this.handleAskUserQuestion(input);
      }
      const verdict = checkToolCall(
        this.currentScope,
        this.opts.config.pushback,
        this.opts.worktreePath,
        toolName,
        input,
      );
      switch (verdict.kind) {
        case 'allow':
          return { behavior: 'allow', updatedInput: input };
        case 'record-write':
          this.emit({
            type: 'path-write',
            taskId: this.opts.spec.id,
            path: verdict.path,
            tool: verdict.tool,
          });
          return { behavior: 'allow', updatedInput: input };
        case 'record-read':
          this.emitPathReadOnce(toolUseID, verdict.path);
          return { behavior: 'allow', updatedInput: input };
        case 'escalate':
          return await this.handleEscalation(verdict.tool, verdict.path, input);
      }
    } catch (err) {
      if (err instanceof DecideCancelledError) {
        return { behavior: 'deny', message: 'Task cancelled by operator', interrupt: true };
      }
      // Fail closed, but never throw out of canUseTool.
      return { behavior: 'deny', message: `Argus policy error: ${String(err)}` };
    }
  }

  private async handleAskUserQuestion(input: Record<string, unknown>): Promise<PermissionResult> {
    const rawQuestions = Array.isArray(input['questions']) ? (input['questions'] as unknown[]) : [];
    const answers: Record<string, string> = {};
    for (const raw of rawQuestions) {
      if (typeof raw !== 'object' || raw === null) {
        continue;
      }
      const q = raw as Record<string, unknown>;
      if (typeof q['question'] !== 'string' || q['question'].length === 0) {
        continue;
      }
      const question = q['question'];
      const multiSelect = q['multiSelect'] === true;
      const options: QuestionOption[] = (Array.isArray(q['options']) ? q['options'] : [])
        .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
        .map((o) => ({
          label: typeof o['label'] === 'string' ? o['label'] : '',
          description: typeof o['description'] === 'string' ? o['description'] : null,
        }));
      const resolution = await this.decideOrCancel({
        kind: 'question',
        header: typeof q['header'] === 'string' ? q['header'] : null,
        question,
        options,
        multiSelect,
      });
      if (resolution.rkind !== 'question') {
        return { behavior: 'deny', message: 'Argus: mismatched resolution for question' };
      }
      answers[question] = answerString(resolution, multiSelect);
    }
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  private async handleEscalation(
    tool: string,
    path: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    const resolution = await this.decideOrCancel({ kind: 'scope-escalation', tool, path });
    if (resolution.rkind !== 'scope-escalation') {
      return { behavior: 'deny', message: 'Argus: mismatched resolution for scope escalation' };
    }
    switch (resolution.action) {
      case 'allow-once':
        this.emit({ type: 'path-write', taskId: this.opts.spec.id, path, tool });
        return { behavior: 'allow', updatedInput: input };
      case 'expand-scope':
        // The orchestrator separately records the spec change; the runner only
        // widens its own live gate.
        this.currentScope = { include: [...this.currentScope.include, resolution.glob] };
        this.emit({ type: 'path-write', taskId: this.opts.spec.id, path, tool });
        return { behavior: 'allow', updatedInput: input };
      case 'deny':
        // No interrupt — the agent should adjust its approach, not die.
        return { behavior: 'deny', message: resolution.reason };
    }
  }

  // -- message loop --------------------------------------------------------

  private async run(queryFn: typeof query): Promise<void> {
    let outcome: AgentOutcome | null = null;
    try {
      const stream = queryFn({ prompt: this.inputStream(), options: this.buildOptions() });
      for await (const raw of stream) {
        const msg = raw as SDKMessage;
        this.log(msg);
        this.fold(msg);
        if (msg.type === 'result') {
          this.settleInputAfterResult();
        }
      }
      outcome = this.stopRequested
        ? { result: 'aborted', detail: this.stopReason }
        : this.lastOutcome ?? {
            result: 'error',
            detail: 'session ended without a result message',
          };
    } catch (err) {
      outcome =
        this.stopRequested || isAbortError(err)
          ? { result: 'aborted', detail: this.stopReason }
          : { result: 'error', detail: String(err).slice(0, DETAIL_CAP) };
    } finally {
      this.endInput();
      this.resolveDone(outcome ?? { result: 'error', detail: 'agent loop ended unexpectedly' });
    }
  }

  private log(msg: SDKMessage): void {
    let line: string;
    try {
      line = JSON.stringify(msg) ?? '{}';
    } catch {
      line = JSON.stringify({ type: 'unserializable-message' });
    }
    try {
      this.appendLogFn(this.logFile, line);
    } catch {
      // The raw log is best-effort; never let it kill the loop.
    }
  }

  /** Fold one SDK message into semantic events. Must never throw. */
  private fold(msg: SDKMessage): void {
    const taskId = this.opts.spec.id;
    try {
      if (msg.type === 'system' && msg.subtype === 'init') {
        this.emit({ type: 'agent-init', taskId, sessionId: msg.session_id, model: msg.model });
        return;
      }
      if (msg.type === 'assistant') {
        const content: unknown[] = Array.isArray(msg.message.content) ? msg.message.content : [];
        const text = content
          .map((b) => {
            if (typeof b !== 'object' || b === null) {
              return '';
            }
            const block = b as { type?: unknown; text?: unknown };
            return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
          })
          .filter((t) => t.length > 0)
          .join('\n');
        if (text.length > 0) {
          this.emit({ type: 'agent-text', taskId, text: text.slice(0, AGENT_TEXT_CAP) });
        }
        const id = msg.message.id;
        if (typeof id === 'string' && !this.countedMessageIds.has(id)) {
          this.countedMessageIds.add(id);
          const usage = msg.message.usage;
          this.emit({
            type: 'usage',
            taskId,
            costUsdDelta: 0,
            tokensDelta: {
              input: usage?.input_tokens ?? 0,
              output: usage?.output_tokens ?? 0,
              cacheRead: usage?.cache_read_input_tokens ?? 0,
              cacheWrite: usage?.cache_creation_input_tokens ?? 0,
            },
          });
        }
        return;
      }
      if (msg.type === 'result') {
        this.emit({
          type: 'usage',
          taskId,
          costUsdDelta: msg.total_cost_usd ?? 0,
          tokensDelta: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
        if (msg.subtype === 'success') {
          const detail = (msg.result ?? '').slice(0, DETAIL_CAP);
          this.lastOutcome = { result: 'success', detail: detail.length > 0 ? detail : null };
        } else {
          const brief =
            Array.isArray(msg.errors) && msg.errors.length > 0
              ? `: ${msg.errors.join('; ')}`
              : '';
          this.lastOutcome = {
            result: 'error',
            detail: `${msg.subtype}${brief}`.slice(0, DETAIL_CAP),
          };
        }
        return;
      }
    } catch {
      // A malformed message is logged raw already; folding it is best-effort.
    }
  }
}
