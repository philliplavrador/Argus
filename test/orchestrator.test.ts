import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator, OrchestratorDeps } from '../src/host/orchestrator';
import {
  AgentHandle,
  AgentOutcome,
  EventLog,
  StartAgentOptions,
  WorktreeInfo,
} from '../src/host/contracts';
import { ArgusEvent, ArgusEventBody, DEFAULT_CONFIG, TaskSpec } from '../src/core/types';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class MemoryEventLog implements EventLog {
  private seq = 0;
  readonly events: ArgusEvent[] = [];
  private readonly listeners = new Set<(e: ArgusEvent) => void>();

  append(body: ArgusEventBody): Promise<ArgusEvent> {
    const e: ArgusEvent = { seq: ++this.seq, ts: new Date().toISOString(), ...body };
    this.events.push(e);
    for (const l of [...this.listeners]) {
      l(e);
    }
    return Promise.resolve(e);
  }
  replay(): Promise<{ events: ArgusEvent[]; skippedLines: number }> {
    return Promise.resolve({ events: [...this.events], skippedLines: 0 });
  }
  onEvent(listener: (e: ArgusEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeWorktrees {
  readonly provisioned: string[] = [];
  private readonly live = new Set<string>();

  provision(taskId: string): Promise<WorktreeInfo> {
    if (this.live.has(taskId)) {
      return Promise.reject(new Error(`provision(${taskId}): worktree path already exists`));
    }
    this.live.add(taskId);
    this.provisioned.push(taskId);
    return Promise.resolve({ taskId, path: `/wt/${taskId}`, branch: `argus/${taskId}` });
  }
  remove(taskId: string): Promise<void> {
    this.live.delete(taskId);
    return Promise.resolve();
  }
  list(): Promise<WorktreeInfo[]> {
    return Promise.resolve([...this.live].map((id) => ({ taskId: id, path: `/wt/${id}`, branch: `argus/${id}` })));
  }
  findStale(liveIds: readonly string[]): Promise<WorktreeInfo[]> {
    return Promise.resolve([...this.live].filter((id) => !liveIds.includes(id)).map((id) => ({ taskId: id, path: `/wt/${id}`, branch: `argus/${id}` })));
  }
}

/** startAgent fake: hands the test a resolver per task so it can end agents. */
function makeFakeAgents(): {
  startAgent: (opts: StartAgentOptions) => AgentHandle;
  started: StartAgentOptions[];
  finish: (taskId: string, outcome: AgentOutcome) => void;
} {
  const started: StartAgentOptions[] = [];
  const resolvers = new Map<string, (o: AgentOutcome) => void>();
  return {
    started,
    finish: (taskId, outcome) => {
      const r = resolvers.get(taskId);
      if (r === undefined) {
        throw new Error(`no live fake agent for ${taskId}`);
      }
      resolvers.delete(taskId);
      r(outcome);
    },
    startAgent: (opts) => {
      started.push(opts);
      let resolve!: (o: AgentOutcome) => void;
      const done = new Promise<AgentOutcome>((r) => {
        resolve = r;
      });
      resolvers.set(opts.spec.id, resolve);
      return {
        taskId: opts.spec.id,
        steer: () => Promise.resolve(),
        stop: (reason) => {
          if (resolvers.has(opts.spec.id)) {
            resolvers.delete(opts.spec.id);
            resolve({ result: 'aborted', detail: reason });
          }
          return Promise.resolve();
        },
        done,
      };
    },
  };
}

const noGates = { run: () => Promise.resolve({ exitCode: 0, outputTail: '', durationMs: 1 }) };
const fakeGit = () => Promise.resolve({ stdout: 'main\n', stderr: '', exitCode: 0 });

function spec(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: id,
    prompt: `do ${id}`,
    scope: { include: ['src/**'] },
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    gates: [],
    budgetUsd: null,
    autoMerge: false,
    ...overrides,
  };
}

function makeOrchestrator(maxConcurrent: number): {
  orch: Orchestrator;
  log: MemoryEventLog;
  worktrees: FakeWorktrees;
  agents: ReturnType<typeof makeFakeAgents>;
} {
  const log = new MemoryEventLog();
  const worktrees = new FakeWorktrees();
  const agents = makeFakeAgents();
  const deps: OrchestratorDeps = {
    repoRoot: '/repo',
    argusDir: '/repo/.argus',
    eventLog: log,
    worktrees: worktrees as never,
    startAgent: agents.startAgent,
    gates: noGates,
    config: { ...DEFAULT_CONFIG, maxConcurrentAgents: maxConcurrent, installDepsOnProvision: false },
    installCommand: null,
    execGit: fakeGit,
  };
  return { orch: new Orchestrator(deps), log, worktrees, agents };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

// ---------------------------------------------------------------------------
// The regression the live smoke caught
// ---------------------------------------------------------------------------

test('two createTask calls in quick succession provision each task exactly once', async () => {
  const { orch, worktrees, agents } = makeOrchestrator(2);
  await orch.start('test');
  await orch.createTask(spec('a'));
  await orch.createTask(spec('b'));
  await tick();

  assert.deepEqual(worktrees.provisioned.sort(), ['a', 'b'], 'each task provisioned once');
  assert.equal(orch.state.tasks['a'].phase, 'RUNNING');
  assert.equal(orch.state.tasks['b'].phase, 'RUNNING');

  agents.finish('a', { result: 'success', detail: null });
  agents.finish('b', { result: 'success', detail: null });
  await tick();
});

test('the concurrency cap holds; a finishing task releases its slot', async () => {
  const { orch, agents } = makeOrchestrator(2);
  await orch.start('test');
  await orch.createTask(spec('a'));
  await orch.createTask(spec('b'));
  await orch.createTask(spec('c'));
  await tick();

  assert.equal(orch.state.tasks['a'].phase, 'RUNNING');
  assert.equal(orch.state.tasks['b'].phase, 'RUNNING');
  assert.equal(orch.state.tasks['c'].phase, 'QUEUED', 'third task waits under cap 2');
  assert.equal(agents.started.length, 2);

  agents.finish('a', { result: 'success', detail: null });
  await tick();
  assert.equal(orch.state.tasks['c'].phase, 'RUNNING', 'freed slot starts the queued task');
  assert.equal(orch.state.tasks['a'].phase, 'READY', 'no gates + no verify command → straight to READY');

  agents.finish('b', { result: 'success', detail: null });
  agents.finish('c', { result: 'success', detail: null });
  await tick();
});

test('a successful task without gates flows RUNNING → VERIFYING → READY', async () => {
  const { orch, agents, log } = makeOrchestrator(1);
  await orch.start('test');
  await orch.createTask(spec('a'));
  await tick();
  agents.finish('a', { result: 'success', detail: 'done' });
  await tick();
  assert.equal(orch.state.tasks['a'].phase, 'READY');
  const types = log.events.map((e) => e.type);
  assert.ok(types.includes('task-verifying'));
  assert.ok(types.includes('task-ready'));
});

test('agent question round-trip: decide() raises an item, answer() resumes with the resolution', async () => {
  const { orch, agents } = makeOrchestrator(1);
  await orch.start('test');
  await orch.createTask(spec('a'));
  await tick();

  const decide = agents.started[0].callbacks.decide({
    kind: 'question',
    header: null,
    question: 'which?',
    options: [{ label: 'X', description: null }],
    multiSelect: false,
  });
  await tick();

  assert.equal(orch.state.tasks['a'].phase, 'BLOCKED');
  const pending = orch.state.inbox.filter((i) => i.resolvedAt === null);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'question');

  await orch.answer(pending[0].id, { rkind: 'question', optionLabels: ['X'], freeText: null });
  const resolution = await decide;
  assert.deepEqual(resolution, { rkind: 'question', optionLabels: ['X'], freeText: null });
  assert.equal(orch.state.tasks['a'].phase, 'RUNNING');

  agents.finish('a', { result: 'success', detail: null });
  await tick();
});

test('a failing gate raises verify-failure; abandon fails the task', async () => {
  const log = new MemoryEventLog();
  const worktrees = new FakeWorktrees();
  const agents = makeFakeAgents();
  const failingGates = { run: () => Promise.resolve({ exitCode: 1, outputTail: 'boom', durationMs: 5 }) };
  const orch = new Orchestrator({
    repoRoot: '/repo',
    argusDir: '/repo/.argus',
    eventLog: log,
    worktrees: worktrees as never,
    startAgent: agents.startAgent,
    gates: failingGates,
    config: { ...DEFAULT_CONFIG, maxConcurrentAgents: 1, installDepsOnProvision: false },
    installCommand: null,
    execGit: fakeGit,
  });
  await orch.start('test');
  await orch.createTask(spec('a', { gates: [{ name: 'tests', command: 'npm test' }] }));
  await tick();
  agents.finish('a', { result: 'success', detail: null });
  await tick();

  const pending = orch.state.inbox.filter((i) => i.resolvedAt === null);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'verify-failure');
  assert.equal(orch.state.tasks['a'].phase, 'VERIFYING');

  await orch.answer(pending[0].id, { rkind: 'verify-failure', action: 'abandon' });
  await tick();
  assert.equal(orch.state.tasks['a'].phase, 'FAILED');
});

test('stopTask while parked rejects the held decision and cancels cleanly', async () => {
  const { orch, agents } = makeOrchestrator(1);
  await orch.start('test');
  await orch.createTask(spec('a'));
  await tick();

  const decide = agents.started[0].callbacks.decide({
    kind: 'scope-escalation',
    tool: 'Edit',
    path: 'elsewhere/x.ts',
  });
  await tick();
  assert.equal(orch.state.tasks['a'].phase, 'BLOCKED');

  await orch.stopTask('a', 'operator stop');
  await assert.rejects(decide);
  await tick();
  assert.equal(orch.state.tasks['a'].phase, 'CANCELLED');
});

test('crossing the fleet budget stops every live task with the budget reason', async () => {
  const log = new MemoryEventLog();
  const worktrees = new FakeWorktrees();
  const agents = makeFakeAgents();
  const orch = new Orchestrator({
    repoRoot: '/repo',
    argusDir: '/repo/.argus',
    eventLog: log,
    worktrees: worktrees as never,
    startAgent: agents.startAgent,
    gates: noGates,
    config: {
      ...DEFAULT_CONFIG,
      maxConcurrentAgents: 2,
      installDepsOnProvision: false,
      perTaskBudgetUsd: null,
      fleetBudgetUsd: 1,
    },
    installCommand: null,
    execGit: fakeGit,
  });
  await orch.start('test');
  await orch.createTask(spec('a'));
  await orch.createTask(spec('b'));
  await tick();

  // The runner reports spend past the fleet cap.
  agents.started[0].callbacks.emit({
    type: 'usage',
    taskId: 'a',
    costUsdDelta: 1.5,
    tokensDelta: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  await tick();

  assert.equal(orch.state.tasks['a'].phase, 'CANCELLED');
  assert.equal(orch.state.tasks['b'].phase, 'CANCELLED');
  assert.match(orch.state.tasks['a'].failureReason ?? '', /budget exceeded/);
  assert.ok(orch.state.fleetCostUsd > 1);
});

test('C1: stopping a task mid-merge prevents the fast-forward from landing', async () => {
  const log = new MemoryEventLog();
  const worktrees = new FakeWorktrees();
  const agents = makeFakeAgents();
  const gitCalls: string[][] = [];
  let releaseGate: () => void = () => undefined;
  const slowGates = {
    run: () =>
      new Promise<{ exitCode: number; outputTail: string; durationMs: number }>((resolve) => {
        releaseGate = () => resolve({ exitCode: 0, outputTail: '', durationMs: 1 });
      }),
  };
  const orch = new Orchestrator({
    repoRoot: '/repo',
    argusDir: '/repo/.argus',
    eventLog: log,
    worktrees: worktrees as never,
    startAgent: agents.startAgent,
    gates: slowGates,
    config: { ...DEFAULT_CONFIG, maxConcurrentAgents: 1, installDepsOnProvision: false, autoMerge: true, verifyCommand: null },
    installCommand: null,
    execGit: (args: string[]) => {
      gitCalls.push(args);
      return Promise.resolve({ stdout: 'main\n', stderr: '', exitCode: 0 });
    },
  });
  await orch.start('test');
  await orch.createTask(spec('a', { gates: [{ name: 'g', command: 'x' }] }));
  await tick();
  assert.equal(orch.state.tasks['a'].phase, 'RUNNING');
  agents.finish('a', { result: 'success', detail: null });
  await tick();
  // verifyTask is parked on the slow gate.
  assert.equal(orch.state.tasks['a'].phase, 'VERIFYING');
  releaseGate();
  await tick();
  // READY → autoMerge → rebase ok → parked on the post-rebase gate.
  assert.equal(orch.state.tasks['a'].phase, 'MERGING');
  // The merge is now parked inside its post-rebase gate. Stop the task.
  await orch.stopTask('a', 'operator stop');
  await tick();
  releaseGate(); // let the parked merge continue — it must notice and bail
  await tick();
  assert.equal(orch.state.tasks['a'].phase, 'CANCELLED');
  assert.ok(
    !gitCalls.some((c) => c[0] === 'merge'),
    `no ff-merge may run after a cancel (git calls: ${gitCalls.map((c) => c.join(' ')).join('; ')})`,
  );
});

test('C2: stopTask during provisioning never spawns an agent and cleans the worktree', async () => {
  const log = new MemoryEventLog();
  const agents = makeFakeAgents();
  let releaseProvision: () => void = () => undefined;
  const removed: string[] = [];
  const slowWorktrees = {
    provision: (taskId: string) =>
      new Promise<WorktreeInfo>((resolve) => {
        releaseProvision = () => resolve({ taskId, path: `/wt/${taskId}`, branch: `argus/${taskId}` });
      }),
    remove: (taskId: string) => {
      removed.push(taskId);
      return Promise.resolve();
    },
    list: () => Promise.resolve([]),
    findStale: () => Promise.resolve([]),
  };
  const orch = new Orchestrator({
    repoRoot: '/repo',
    argusDir: '/repo/.argus',
    eventLog: log,
    worktrees: slowWorktrees as never,
    startAgent: agents.startAgent,
    gates: noGates,
    config: { ...DEFAULT_CONFIG, maxConcurrentAgents: 1, installDepsOnProvision: false },
    installCommand: null,
    execGit: fakeGit,
  });
  await orch.start('test');
  await orch.createTask(spec('a'));
  await tick();
  await orch.stopTask('a', 'changed my mind'); // still provisioning: no handle
  assert.equal(orch.state.tasks['a'].phase, 'CANCELLED');
  releaseProvision();
  await tick();
  assert.equal(agents.started.length, 0, 'no agent may spawn for a cancelled task');
  assert.deepEqual(removed, ['a'], 'the fresh worktree is cleaned up');
});

test('C3: start() schedules QUEUED tasks that survived a restart', async () => {
  const log = new MemoryEventLog();
  await log.append({ type: 'task-created', spec: spec('leftover') });
  await log.append({ type: 'task-queued', taskId: 'leftover' });
  const worktrees = new FakeWorktrees();
  const agents = makeFakeAgents();
  const orch = new Orchestrator({
    repoRoot: '/repo',
    argusDir: '/repo/.argus',
    eventLog: log,
    worktrees: worktrees as never,
    startAgent: agents.startAgent,
    gates: noGates,
    config: { ...DEFAULT_CONFIG, maxConcurrentAgents: 2, installDepsOnProvision: false },
    installCommand: null,
    execGit: fakeGit,
  });
  await orch.start('restarted');
  await tick();
  assert.equal(orch.state.tasks['leftover'].phase, 'RUNNING', 'replayed QUEUED task starts without user action');
  agents.finish('leftover', { result: 'success', detail: null });
  await tick();
});

test('C4: raising the fleet budget after a trip un-wedges scheduling', async () => {
  const log = new MemoryEventLog();
  const worktrees = new FakeWorktrees();
  const agents = makeFakeAgents();
  const orch = new Orchestrator({
    repoRoot: '/repo',
    argusDir: '/repo/.argus',
    eventLog: log,
    worktrees: worktrees as never,
    startAgent: agents.startAgent,
    gates: noGates,
    config: { ...DEFAULT_CONFIG, maxConcurrentAgents: 1, installDepsOnProvision: false, perTaskBudgetUsd: null, fleetBudgetUsd: 1 },
    installCommand: null,
    execGit: fakeGit,
  });
  await orch.start('test');
  await orch.createTask(spec('a'));
  await tick();
  agents.started[0].callbacks.emit({ type: 'usage', taskId: 'a', costUsdDelta: 2, tokensDelta: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  await tick();
  assert.equal(orch.state.tasks['a'].phase, 'CANCELLED'); // tripped

  await orch.setConfig({ ...DEFAULT_CONFIG, maxConcurrentAgents: 1, installDepsOnProvision: false, perTaskBudgetUsd: null, fleetBudgetUsd: 100 });
  await orch.createTask(spec('b'));
  await tick();
  assert.equal(orch.state.tasks['b'].phase, 'RUNNING', 'new task runs after the cap is raised');
  agents.finish('b', { result: 'success', detail: null });
  await tick();
});

test('C5/C10: stopping a BLOCKED task voids its pending inbox item', async () => {
  const { orch, agents } = makeOrchestrator(1);
  await orch.start('test');
  await orch.createTask(spec('a'));
  await tick();
  const decide = agents.started[0].callbacks.decide({ kind: 'question', header: null, question: 'q?', options: [], multiSelect: false });
  decide.catch(() => undefined);
  await tick();
  assert.equal(orch.state.inbox.filter((i) => i.resolvedAt === null).length, 1);
  await orch.stopTask('a', 'stop');
  await tick();
  const item = orch.state.inbox[0];
  assert.notEqual(item.resolvedAt, null, 'the ghost card is expired');
  assert.equal(item.resolution, null, 'expired, not answered');
});

test('C15: READY tasks own their worktrees — never offered as stale', async () => {
  const { orch, agents, worktrees } = makeOrchestrator(1);
  await orch.start('test');
  await orch.createTask(spec('a'));
  await tick();
  agents.finish('a', { result: 'success', detail: null });
  await tick();
  assert.equal(orch.state.tasks['a'].phase, 'READY');
  const before = (await worktrees.list()).length;
  const removedCount = await orch.cleanupStaleWorktrees();
  assert.equal(removedCount, 0, 'READY worktree must not be cleaned');
  assert.equal((await worktrees.list()).length, before);
});

test('restart replay marks previously-live tasks failed and offers their worktrees as stale', async () => {
  const { orch, log, agents } = makeOrchestrator(2);
  await orch.start('test');
  await orch.createTask(spec('a'));
  await tick();
  assert.equal(orch.state.tasks['a'].phase, 'RUNNING');

  // Simulate death: a NEW orchestrator over the same log and worktree state.
  const worktrees2 = new FakeWorktrees();
  await worktrees2.provision('a'); // the dir survived the crash
  const orch2 = new Orchestrator({
    repoRoot: '/repo',
    argusDir: '/repo/.argus',
    eventLog: log,
    worktrees: worktrees2 as never,
    startAgent: makeFakeAgents().startAgent,
    gates: noGates,
    config: { ...DEFAULT_CONFIG, maxConcurrentAgents: 2, installDepsOnProvision: false },
    installCommand: null,
    execGit: fakeGit,
  });
  const stale = await orch2.start('test-restart');
  assert.equal(orch2.state.tasks['a'].phase, 'FAILED');
  assert.match(orch2.state.tasks['a'].failureReason ?? '', /interrupted/);
  assert.deepEqual(stale.map((w) => w.taskId), ['a'], 'the dead task worktree is offered as stale');

  agents.finish('a', { result: 'success', detail: null }); // silence the first orch's loop
  await tick();
});
