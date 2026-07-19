import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockedTaskIds,
  countByPhase,
  foldEvents,
  initialState,
  isLivePhase,
  pendingInbox,
  reduce,
} from '../src/core/reducer';
import {
  AGENT_TEXT_CAP,
  ArgusConfig,
  ArgusEvent,
  ArgusEventBody,
  DEFAULT_CONFIG,
  FleetState,
  GateResult,
  QuestionItem,
  QuestionResolution,
  TaskPhase,
  TaskSpec,
  TOOL_TAIL_CAP,
} from '../src/core/types';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const CONFIG: ArgusConfig = DEFAULT_CONFIG;

function spec(id: string): TaskSpec {
  return {
    id,
    title: id.toUpperCase(),
    prompt: `do ${id}`,
    scope: { include: ['src/**'] },
    model: 'claude-opus-4-8',
    effort: 'high',
    gates: [],
    budgetUsd: null,
    autoMerge: false,
  };
}

function gate(name = 'test', exitCode = 0): GateResult {
  return {
    name,
    command: `npm run ${name}`,
    exitCode,
    outputTail: 'ok',
    durationMs: 10,
    finishedAt: '2026-07-18T00:00:00.000Z',
  };
}

function question(id: string, taskId: string, raisedAt: string): QuestionItem {
  return {
    id,
    taskId,
    raisedAt,
    resolvedAt: null,
    kind: 'question',
    header: null,
    question: 'which?',
    options: [],
    multiSelect: false,
    resolution: null,
  };
}

const answer: QuestionResolution = { rkind: 'question', optionLabels: ['a'], freeText: null };

/** A monotonic event sequencer: seq 1,2,3… and ascending ISO timestamps. */
function sequencer() {
  let n = 0;
  let clock = Date.parse('2026-07-18T00:00:00.000Z');
  return (body: ArgusEventBody, ts?: string): ArgusEvent => {
    n += 1;
    clock += 1000;
    return { seq: n, ts: ts ?? new Date(clock).toISOString(), ...body };
  };
}

/** Fold a list of bodies from empty, auto-stamping seq/ts. */
function fold(...bodies: ArgusEventBody[]): FleetState {
  const ev = sequencer();
  return foldEvents(bodies.map((b) => ev(b)), CONFIG);
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) {
      deepFreeze(v);
    }
    Object.freeze(o);
  }
  return o;
}

// A task driven all the way to RUNNING, as reusable prefixes.
function toRunning(id: string): ArgusEventBody[] {
  return [
    { type: 'task-created', spec: spec(id) },
    { type: 'task-queued', taskId: id },
    { type: 'task-started', taskId: id, worktreePath: `/wt/${id}`, branch: `argus/${id}` },
  ];
}

// ---------------------------------------------------------------------------
// initialState / foldEvents
// ---------------------------------------------------------------------------

test('initialState is the empty fleet', () => {
  const s = initialState(CONFIG);
  assert.equal(s.seq, 0);
  assert.equal(s.config, CONFIG);
  assert.deepEqual(s.tasks, {});
  assert.deepEqual(s.taskOrder, []);
  assert.deepEqual(s.inbox, []);
  assert.deepEqual(s.mergeQueue, []);
  assert.equal(s.merging, null);
  assert.equal(s.fleetCostUsd, 0);
});

test('foldEvents on empty and non-array input yields initial state', () => {
  assert.deepEqual(foldEvents([], CONFIG), initialState(CONFIG));
  // Defensive: never throw on a corrupt stream reference.
  assert.deepEqual(foldEvents(undefined as unknown as ArgusEvent[], CONFIG), initialState(CONFIG));
});

test('isLivePhase matches the live set', () => {
  for (const p of ['RUNNING', 'BLOCKED', 'VERIFYING'] as TaskPhase[]) {
    assert.equal(isLivePhase(p), true);
  }
  for (const p of ['DRAFT', 'QUEUED', 'READY', 'MERGING', 'DONE', 'FAILED', 'CANCELLED'] as TaskPhase[]) {
    assert.equal(isLivePhase(p), false);
  }
});

// ---------------------------------------------------------------------------
// seq discipline & malformed events
// ---------------------------------------------------------------------------

test('malformed events leave state untouched (same reference)', () => {
  const s = fold(...toRunning('a'));
  assert.equal(reduce(s, null as unknown as ArgusEvent), s);
  assert.equal(reduce(s, {} as ArgusEvent), s); // no numeric seq
  assert.equal(reduce(s, { seq: 'x' } as unknown as ArgusEvent), s);
});

test('every applied event advances seq, including no-ops', () => {
  const s = fold(...toRunning('a'));
  // Unknown taskId: no state change but seq advances.
  const r1 = reduce(s, { seq: 99, ts: 't', type: 'task-queued', taskId: 'ghost' });
  assert.equal(r1.seq, 99);
  assert.deepEqual(r1.tasks, s.tasks);
  // Unknown type (forward-compatible line from disk): seq advances.
  const r2 = reduce(s, { seq: 100, ts: 't', type: 'from-the-future' } as unknown as ArgusEvent);
  assert.equal(r2.seq, 100);
  assert.deepEqual(r2.tasks, s.tasks);
});

// ---------------------------------------------------------------------------
// task-created
// ---------------------------------------------------------------------------

test('task-created initializes a DRAFT task with zeroed fields', () => {
  const s = fold({ type: 'task-created', spec: spec('a') });
  const t = s.tasks['a'];
  assert.equal(t.phase, 'DRAFT');
  assert.equal(t.createdAt, s.tasks['a'].createdAt);
  assert.equal(t.startedAt, null);
  assert.equal(t.endedAt, null);
  assert.equal(t.worktreePath, null);
  assert.equal(t.branch, null);
  assert.equal(t.sessionId, null);
  assert.equal(t.blockedOn, null);
  assert.equal(t.stepsDone, null);
  assert.equal(t.stepsTotal, null);
  assert.equal(t.costUsd, 0);
  assert.deepEqual(t.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(t.recentToolCalls, []);
  assert.deepEqual(t.writes, []);
  assert.deepEqual(t.reads, []);
  assert.deepEqual(t.gateResults, []);
  assert.equal(t.escalations, 0);
  assert.deepEqual(s.taskOrder, ['a']);
});

test('task-created with duplicate id keeps the first', () => {
  const first = spec('a');
  const s = fold(
    { type: 'task-created', spec: first },
    { type: 'task-created', spec: { ...spec('a'), title: 'SECOND' } },
  );
  assert.equal(s.tasks['a'].spec.title, 'A');
  assert.deepEqual(s.taskOrder, ['a']);
});

test('task-created with a bad spec is a no-op', () => {
  const s = fold({ type: 'task-created', spec: { id: 123 } as unknown as TaskSpec });
  assert.deepEqual(s.tasks, {});
  assert.deepEqual(s.taskOrder, []);
});

// ---------------------------------------------------------------------------
// Happy-path lifecycle
// ---------------------------------------------------------------------------

test('full lifecycle DRAFT -> DONE as one fold', () => {
  const s = fold(
    { type: 'task-created', spec: spec('a') },
    { type: 'task-queued', taskId: 'a' },
    { type: 'task-started', taskId: 'a', worktreePath: '/wt/a', branch: 'argus/a' },
    { type: 'agent-init', taskId: 'a', sessionId: 'sess-1', model: 'claude-opus-4-8' },
    { type: 'tool-call', taskId: 'a', tool: 'Edit', detail: 'Edit src/x.ts', paths: ['src/x.ts'] },
    { type: 'usage', taskId: 'a', costUsdDelta: 0.25, tokensDelta: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 } },
    { type: 'progress', taskId: 'a', stepsDone: 2, stepsTotal: 4 },
    { type: 'task-verifying', taskId: 'a' },
    { type: 'gate-finished', taskId: 'a', result: gate() },
    { type: 'task-ready', taskId: 'a' },
    { type: 'merge-started', taskId: 'a' },
    { type: 'merge-finished', taskId: 'a', mergeCommit: 'abc123' },
  );
  const t = s.tasks['a'];
  assert.equal(t.phase, 'DONE');
  // merge-finished tears the worktree down, so the path clears with it (C12);
  // the branch name stays as display history.
  assert.equal(t.worktreePath, null);
  assert.equal(t.branch, 'argus/a');
  assert.equal(t.sessionId, 'sess-1');
  assert.notEqual(t.startedAt, null);
  assert.notEqual(t.endedAt, null);
  assert.equal(t.costUsd, 0.25);
  assert.deepEqual(t.tokens, { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 });
  assert.equal(t.stepsDone, 2);
  assert.equal(t.stepsTotal, 4);
  assert.equal(t.gateResults.length, 1);
  assert.equal(t.recentToolCalls.length, 1);
  assert.equal(s.fleetCostUsd, 0.25);
  assert.deepEqual(s.mergeQueue, []);
  assert.equal(s.merging, null);
});

// ---------------------------------------------------------------------------
// Phase-guard no-ops
// ---------------------------------------------------------------------------

test('task-queued only fires from DRAFT', () => {
  const s = fold(...toRunning('a'), { type: 'task-queued', taskId: 'a' });
  assert.equal(s.tasks['a'].phase, 'RUNNING'); // stayed
});

test('task-started only fires from QUEUED', () => {
  const s = fold(
    { type: 'task-created', spec: spec('a') },
    { type: 'task-started', taskId: 'a', worktreePath: '/wt/a', branch: 'argus/a' },
  );
  assert.equal(s.tasks['a'].phase, 'DRAFT');
  assert.equal(s.tasks['a'].worktreePath, null);
});

test('agent-init sets sessionId only in a live phase', () => {
  const draft = fold(
    { type: 'task-created', spec: spec('a') },
    { type: 'agent-init', taskId: 'a', sessionId: 'nope', model: 'm' },
  );
  assert.equal(draft.tasks['a'].sessionId, null); // DRAFT is not live

  const running = fold(
    ...toRunning('a'),
    { type: 'agent-init', taskId: 'a', sessionId: 'yes', model: 'm' },
  );
  assert.equal(running.tasks['a'].sessionId, 'yes');
});

// ---------------------------------------------------------------------------
// Block / resume
// ---------------------------------------------------------------------------

test('block then resume cycle from RUNNING', () => {
  const blocked = fold(
    ...toRunning('a'),
    { type: 'task-blocked', taskId: 'a', itemId: 'a#1' },
  );
  assert.equal(blocked.tasks['a'].phase, 'BLOCKED');
  assert.equal(blocked.tasks['a'].blockedOn, 'a#1');
  assert.notEqual(blocked.tasks['a'].blockedSince, null);
  assert.deepEqual(blockedTaskIds(blocked), ['a']);

  const resumed = reduce(blocked, {
    seq: blocked.seq + 1,
    ts: '2026-07-18T01:00:00.000Z',
    type: 'task-resumed',
    taskId: 'a',
    itemId: 'a#1',
  });
  assert.equal(resumed.tasks['a'].phase, 'RUNNING');
  assert.equal(resumed.tasks['a'].blockedOn, null);
  assert.equal(resumed.tasks['a'].blockedSince, null);
  assert.deepEqual(blockedTaskIds(resumed), []);
});

test('verify-failure: task-blocked during VERIFYING keeps VERIFYING but shows blockedOn', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'task-verifying', taskId: 'a' },
    { type: 'task-blocked', taskId: 'a', itemId: 'a#1' },
  );
  assert.equal(s.tasks['a'].phase, 'VERIFYING');
  assert.equal(s.tasks['a'].blockedOn, 'a#1');
  assert.deepEqual(blockedTaskIds(s), ['a']);
});

test('task-resumed from a non-BLOCKED phase clears blockedOn but keeps phase', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'task-verifying', taskId: 'a' },
    { type: 'task-blocked', taskId: 'a', itemId: 'a#1' }, // VERIFYING + blockedOn
    { type: 'task-resumed', taskId: 'a', itemId: 'a#1' },
  );
  assert.equal(s.tasks['a'].phase, 'VERIFYING');
  assert.equal(s.tasks['a'].blockedOn, null);
});

test('task-verifying transitions from RUNNING and from BLOCKED, clearing blockedOn', () => {
  const fromRunning = fold(...toRunning('a'), { type: 'task-verifying', taskId: 'a' });
  assert.equal(fromRunning.tasks['a'].phase, 'VERIFYING');

  const fromBlocked = fold(
    ...toRunning('a'),
    { type: 'task-blocked', taskId: 'a', itemId: 'a#1' },
    { type: 'task-verifying', taskId: 'a' },
  );
  assert.equal(fromBlocked.tasks['a'].phase, 'VERIFYING');
  assert.equal(fromBlocked.tasks['a'].blockedOn, null);

  // From an ineligible phase (DRAFT) it is a no-op.
  const fromDraft = fold(
    { type: 'task-created', spec: spec('a') },
    { type: 'task-verifying', taskId: 'a' },
  );
  assert.equal(fromDraft.tasks['a'].phase, 'DRAFT');
});

// ---------------------------------------------------------------------------
// Gates, ready, merge queue
// ---------------------------------------------------------------------------

test('gate-finished appends results without a phase change', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'task-verifying', taskId: 'a' },
    { type: 'gate-finished', taskId: 'a', result: gate('lint') },
    { type: 'gate-finished', taskId: 'a', result: gate('test', 1) },
  );
  assert.equal(s.tasks['a'].phase, 'VERIFYING');
  assert.equal(s.tasks['a'].gateResults.length, 2);
  assert.equal(s.tasks['a'].gateResults[1].exitCode, 1);
});

test('task-ready enqueues once, only from VERIFYING', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'task-verifying', taskId: 'a' },
    { type: 'task-ready', taskId: 'a' },
    { type: 'task-ready', taskId: 'a' }, // idempotent enqueue
  );
  assert.equal(s.tasks['a'].phase, 'READY');
  assert.deepEqual(s.mergeQueue, ['a']);

  // Not from RUNNING.
  const notReady = fold(...toRunning('a'), { type: 'task-ready', taskId: 'a' });
  assert.equal(notReady.tasks['a'].phase, 'RUNNING');
  assert.deepEqual(notReady.mergeQueue, []);
});

test('merge-started only from READY; sets merging and dequeues', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'task-verifying', taskId: 'a' },
    { type: 'task-ready', taskId: 'a' },
    { type: 'merge-started', taskId: 'a' },
  );
  assert.equal(s.tasks['a'].phase, 'MERGING');
  assert.equal(s.merging, 'a');
  assert.deepEqual(s.mergeQueue, []);
});

test('merge-finished clears merging only when it matches, DONE only from MERGING', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'task-verifying', taskId: 'a' },
    { type: 'task-ready', taskId: 'a' },
    { type: 'merge-started', taskId: 'a' },
    { type: 'merge-finished', taskId: 'a', mergeCommit: 'sha' },
  );
  assert.equal(s.tasks['a'].phase, 'DONE');
  assert.notEqual(s.tasks['a'].endedAt, null);
  assert.equal(s.merging, null);

  // merge-finished for a non-MERGING task does not clear another task's merge.
  const busy = fold(
    ...toRunning('a'),
    { type: 'task-verifying', taskId: 'a' },
    { type: 'task-ready', taskId: 'a' },
    { type: 'merge-started', taskId: 'a' },
    ...toRunning('b'),
    { type: 'merge-finished', taskId: 'b', mergeCommit: 'sha' },
  );
  assert.equal(busy.merging, 'a'); // unchanged
  assert.equal(busy.tasks['b'].phase, 'RUNNING'); // no-op on b
});

// ---------------------------------------------------------------------------
// Terminal transitions
// ---------------------------------------------------------------------------

test('task-failed from a non-terminal phase cleans up queue, merge, block', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'task-verifying', taskId: 'a' },
    { type: 'task-ready', taskId: 'a' },
    { type: 'merge-started', taskId: 'a' },
    { type: 'task-blocked', taskId: 'a', itemId: 'a#1' }, // sets blockedOn on MERGING
    { type: 'task-failed', taskId: 'a', reason: 'boom' },
  );
  const t = s.tasks['a'];
  assert.equal(t.phase, 'FAILED');
  assert.equal(t.failureReason, 'boom');
  assert.notEqual(t.endedAt, null);
  assert.equal(t.blockedOn, null);
  assert.equal(t.blockedSince, null);
  assert.equal(s.merging, null);
  assert.deepEqual(s.mergeQueue, []);
});

test('terminal phases are frozen: task-failed on a DONE task is a no-op', () => {
  const done = fold(
    ...toRunning('a'),
    { type: 'task-verifying', taskId: 'a' },
    { type: 'task-ready', taskId: 'a' },
    { type: 'merge-started', taskId: 'a' },
    { type: 'merge-finished', taskId: 'a', mergeCommit: 'sha' },
    { type: 'task-failed', taskId: 'a', reason: 'too late' },
  );
  assert.equal(done.tasks['a'].phase, 'DONE');
  assert.equal(done.tasks['a'].failureReason, null);
});

test('task-ready from MERGING releases the merge slot and re-queues (merge back-off path)', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'task-verifying', taskId: 'a' },
    { type: 'task-ready', taskId: 'a' },
    { type: 'merge-started', taskId: 'a' },
    { type: 'task-blocked', taskId: 'a', itemId: 'a#1' }, // conflict item pending
    { type: 'task-ready', taskId: 'a' }, // operator chose open-editor → back off
  );
  assert.equal(s.tasks['a'].phase, 'READY');
  assert.equal(s.tasks['a'].blockedOn, null);
  assert.equal(s.merging, null);
  assert.deepEqual(s.mergeQueue, ['a']);
});

test('task-ready from RUNNING stays a no-op', () => {
  const s = fold(...toRunning('a'), { type: 'task-ready', taskId: 'a' });
  assert.equal(s.tasks['a'].phase, 'RUNNING');
  assert.deepEqual(s.mergeQueue, []);
});

test('scope-expanded appends a new glob to the task spec, once', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'scope-expanded', taskId: 'a', glob: 'lib/**' },
    { type: 'scope-expanded', taskId: 'a', glob: 'lib/**' }, // duplicate → no-op
    { type: 'scope-expanded', taskId: 'a', glob: '' }, // empty → no-op
  );
  assert.deepEqual(s.tasks['a'].spec.scope.include, ['src/**', 'lib/**']);
});

test('task-cancelled accepts a null reason', () => {
  const s = fold(...toRunning('a'), { type: 'task-cancelled', taskId: 'a', reason: null });
  assert.equal(s.tasks['a'].phase, 'CANCELLED');
  assert.equal(s.tasks['a'].failureReason, null);
  assert.notEqual(s.tasks['a'].endedAt, null);
});

// ---------------------------------------------------------------------------
// Activity, usage, progress, paths
// ---------------------------------------------------------------------------

test('task-steered prefixes and truncates to AGENT_TEXT_CAP', () => {
  const long = 'x'.repeat(500);
  const s = fold(...toRunning('a'), { type: 'task-steered', taskId: 'a', message: long });
  const la = s.tasks['a'].lastActivity!;
  assert.equal(la.length, AGENT_TEXT_CAP);
  assert.ok(la.startsWith('steered: '));
  assert.notEqual(s.tasks['a'].lastActivityAt, null);
});

test('tool-call tail caps at TOOL_TAIL_CAP, dropping oldest, newest last', () => {
  const bodies: ArgusEventBody[] = [...toRunning('a')];
  const total = TOOL_TAIL_CAP + 10;
  for (let i = 0; i < total; i += 1) {
    bodies.push({ type: 'tool-call', taskId: 'a', tool: 'Bash', detail: `call-${i}`, paths: [] });
  }
  const s = fold(...bodies);
  const tail = s.tasks['a'].recentToolCalls;
  assert.equal(tail.length, TOOL_TAIL_CAP);
  assert.equal(tail[tail.length - 1].detail, `call-${total - 1}`); // newest last
  assert.equal(tail[0].detail, `call-${total - TOOL_TAIL_CAP}`); // oldest dropped
  assert.equal(s.tasks['a'].lastActivity, `call-${total - 1}`);
});

test('agent-text truncates to AGENT_TEXT_CAP', () => {
  const s = fold(...toRunning('a'), { type: 'agent-text', taskId: 'a', text: 'y'.repeat(1000) });
  assert.equal(s.tasks['a'].lastActivity!.length, AGENT_TEXT_CAP);
});

test('usage accumulates and guards non-finite / negative deltas to 0', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'usage', taskId: 'a', costUsdDelta: 1.5, tokensDelta: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } },
    { type: 'usage', taskId: 'a', costUsdDelta: NaN, tokensDelta: { input: Infinity, output: -5, cacheRead: 3, cacheWrite: 0 } },
    { type: 'usage', taskId: 'a', costUsdDelta: -2, tokensDelta: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
  );
  const t = s.tasks['a'];
  assert.equal(t.costUsd, 1.5); // NaN and -2 ignored
  assert.equal(s.fleetCostUsd, 1.5);
  assert.deepEqual(t.tokens, { input: 11, output: 3, cacheRead: 4, cacheWrite: 1 });
});

test('usage on an unknown task does not move fleetCostUsd', () => {
  const s = fold(...toRunning('a'));
  const r = reduce(s, {
    seq: s.seq + 1,
    ts: 't',
    type: 'usage',
    taskId: 'ghost',
    costUsdDelta: 5,
    tokensDelta: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(r.fleetCostUsd, 0);
  assert.equal(r.seq, s.seq + 1);
});

test('progress clamps: rejects negatives, non-integers, and done > total', () => {
  const base = fold(...toRunning('a'), { type: 'progress', taskId: 'a', stepsDone: 3, stepsTotal: 5 });
  assert.equal(base.tasks['a'].stepsDone, 3);
  assert.equal(base.tasks['a'].stepsTotal, 5);

  const cases: Array<[number, number]> = [
    [-1, 5],
    [2, -1],
    [1.5, 5],
    [6, 5], // done > total
  ];
  for (const [d, tot] of cases) {
    const r = reduce(base, { seq: base.seq + 1, ts: 't', type: 'progress', taskId: 'a', stepsDone: d, stepsTotal: tot });
    assert.equal(r.tasks['a'].stepsDone, 3, `stepsDone unchanged for (${d},${tot})`);
    assert.equal(r.tasks['a'].stepsTotal, 5, `stepsTotal unchanged for (${d},${tot})`);
  }
});

test('path-write and path-read dedupe', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'path-write', taskId: 'a', path: 'src/x.ts', tool: 'Edit' },
    { type: 'path-write', taskId: 'a', path: 'src/x.ts', tool: 'Edit' },
    { type: 'path-write', taskId: 'a', path: 'src/y.ts', tool: 'Write' },
    { type: 'path-read', taskId: 'a', path: 'src/z.ts' },
    { type: 'path-read', taskId: 'a', path: 'src/z.ts' },
  );
  assert.deepEqual(s.tasks['a'].writes, ['src/x.ts', 'src/y.ts']);
  assert.deepEqual(s.tasks['a'].reads, ['src/z.ts']);
});

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

test('inbox-raised appends; duplicate id is ignored', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'inbox-raised', item: question('a#1', 'a', '2026-07-18T00:10:00.000Z') },
    { type: 'inbox-raised', item: { ...question('a#1', 'a', '2026-07-18T00:20:00.000Z'), question: 'dup' } },
  );
  assert.equal(s.inbox.length, 1);
  assert.equal(s.inbox[0].raisedAt, '2026-07-18T00:10:00.000Z');
});

test('inbox-resolved sets resolution and resolvedAt exactly once', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'inbox-raised', item: question('a#1', 'a', '2026-07-18T00:10:00.000Z') },
    { type: 'inbox-resolved', itemId: 'a#1', resolution: answer },
  );
  const item = s.inbox[0] as QuestionItem;
  assert.deepEqual(item.resolution, answer);
  assert.notEqual(item.resolvedAt, null);
});

test('inbox-resolved no-ops on double-resolve, rkind mismatch, and unknown id', () => {
  const s = fold(
    ...toRunning('a'),
    { type: 'inbox-raised', item: question('a#1', 'a', '2026-07-18T00:10:00.000Z') },
    { type: 'inbox-resolved', itemId: 'a#1', resolution: answer },
    // double-resolve
    { type: 'inbox-resolved', itemId: 'a#1', resolution: { rkind: 'question', optionLabels: ['b'], freeText: null } },
    // rkind mismatch against a question item
    { type: 'inbox-raised', item: question('a#2', 'a', '2026-07-18T00:11:00.000Z') },
    { type: 'inbox-resolved', itemId: 'a#2', resolution: { rkind: 'verify-failure', action: 'override' } },
    // unknown id
    { type: 'inbox-resolved', itemId: 'nope', resolution: answer },
  );
  const first = s.inbox[0] as QuestionItem;
  const second = s.inbox[1] as QuestionItem;
  assert.deepEqual(first.resolution, answer); // first resolution stuck
  assert.equal(second.resolution, null); // mismatch rejected
});

// ---------------------------------------------------------------------------
// config-changed
// ---------------------------------------------------------------------------

test('config-changed replaces config; bad config is ignored', () => {
  const next: ArgusConfig = { ...CONFIG, maxConcurrentAgents: 9 };
  const s = fold({ type: 'config-changed', config: next });
  assert.equal(s.config.maxConcurrentAgents, 9);

  const bad = reduce(s, { seq: s.seq + 1, ts: 't', type: 'config-changed', config: null as unknown as ArgusConfig });
  assert.equal(bad.config, s.config); // unchanged
});

// ---------------------------------------------------------------------------
// Two interleaved tasks + structural sharing
// ---------------------------------------------------------------------------

test('two interleaved tasks progress independently', () => {
  const s = fold(
    { type: 'task-created', spec: spec('a') },
    { type: 'task-created', spec: spec('b') },
    { type: 'task-queued', taskId: 'a' },
    { type: 'task-queued', taskId: 'b' },
    { type: 'task-started', taskId: 'a', worktreePath: '/wt/a', branch: 'argus/a' },
    { type: 'task-started', taskId: 'b', worktreePath: '/wt/b', branch: 'argus/b' },
    { type: 'task-verifying', taskId: 'a' },
    { type: 'task-ready', taskId: 'a' },
    { type: 'task-blocked', taskId: 'b', itemId: 'b#1' },
  );
  assert.equal(s.tasks['a'].phase, 'READY');
  assert.equal(s.tasks['b'].phase, 'BLOCKED');
  assert.deepEqual(s.mergeQueue, ['a']);
  assert.deepEqual(s.taskOrder, ['a', 'b']);
  assert.deepEqual(blockedTaskIds(s), ['b']);
});

test('an event touching one task shares the other task by reference', () => {
  const before = fold(...toRunning('a'), ...toRunning('b'));
  const after = reduce(before, { seq: before.seq + 1, ts: 't', type: 'task-verifying', taskId: 'a' });
  assert.notEqual(after.tasks['a'], before.tasks['a']); // changed branch is fresh
  assert.equal(after.tasks['b'], before.tasks['b']); // untouched branch is shared
});

// ---------------------------------------------------------------------------
// Crash / restart semantics
// ---------------------------------------------------------------------------

test('orchestrator-started fails live/merging tasks, voids their inbox, filters the queue', () => {
  const restartTs = '2026-07-18T09:00:00.000Z';
  const nextConfig: ArgusConfig = { ...CONFIG, maxConcurrentAgents: 7 };
  const s = fold(
    // a: RUNNING
    ...toRunning('a'),
    // b: VERIFYING
    ...toRunning('b'),
    { type: 'task-verifying', taskId: 'b' },
    // c: BLOCKED with a pending inbox item
    ...toRunning('c'),
    { type: 'inbox-raised', item: question('c#1', 'c', '2026-07-18T00:30:00.000Z') },
    { type: 'task-blocked', taskId: 'c', itemId: 'c#1' },
    // d: MERGING
    ...toRunning('d'),
    { type: 'task-verifying', taskId: 'd' },
    { type: 'task-ready', taskId: 'd' },
    { type: 'merge-started', taskId: 'd' },
    // e: READY, with its own pending inbox item
    ...toRunning('e'),
    { type: 'task-verifying', taskId: 'e' },
    { type: 'task-ready', taskId: 'e' },
    { type: 'inbox-raised', item: question('e#1', 'e', '2026-07-18T00:40:00.000Z') },
  );
  assert.equal(s.merging, 'd');
  assert.deepEqual(s.mergeQueue, ['e']);

  const r = reduce(s, { seq: s.seq + 1, ts: restartTs, type: 'orchestrator-started', version: '2.0.0', config: nextConfig });

  // Config replaced.
  assert.equal(r.config.maxConcurrentAgents, 7);
  // Live tasks -> FAILED with the crash reason.
  for (const id of ['a', 'b', 'c']) {
    assert.equal(r.tasks[id].phase, 'FAILED', id);
    assert.equal(r.tasks[id].failureReason, 'interrupted: orchestrator restarted (worktree preserved)', id);
    assert.equal(r.tasks[id].endedAt, restartTs, id);
  }
  // Merging task -> FAILED with the mid-merge reason.
  assert.equal(r.tasks['d'].phase, 'FAILED');
  assert.equal(r.tasks['d'].failureReason, 'interrupted mid-merge — inspect the repo before retrying');
  // Crash-failed tasks shed their block marker — no ★ on a dead task.
  assert.equal(r.tasks['c'].blockedOn, null);
  assert.equal(r.tasks['c'].blockedSince, null);
  assert.deepEqual(blockedTaskIds(r), []);
  // READY survivor untouched.
  assert.equal(r.tasks['e'].phase, 'READY');
  // Queue keeps only still-READY tasks; merging cleared.
  assert.deepEqual(r.mergeQueue, ['e']);
  assert.equal(r.merging, null);
  // Pending inbox of an interrupted task is voided (resolvedAt set, resolution null).
  const cItem = r.inbox.find((i) => i.id === 'c#1') as QuestionItem;
  assert.equal(cItem.resolvedAt, restartTs);
  assert.equal(cItem.resolution, null);
  // Inbox of a non-interrupted task is left pending.
  const eItem = r.inbox.find((i) => i.id === 'e#1') as QuestionItem;
  assert.equal(eItem.resolvedAt, null);
});

test('orchestrator-started leaves already-resolved inbox items alone', () => {
  const restartTs = '2026-07-18T09:00:00.000Z';
  const s = fold(
    ...toRunning('a'),
    { type: 'inbox-raised', item: question('a#1', 'a', '2026-07-18T00:10:00.000Z') },
    { type: 'inbox-resolved', itemId: 'a#1', resolution: answer },
    { type: 'task-blocked', taskId: 'a', itemId: 'a#2' },
  );
  const resolvedAtBefore = (s.inbox[0] as QuestionItem).resolvedAt;
  const r = reduce(s, { seq: s.seq + 1, ts: restartTs, type: 'orchestrator-started', version: '2', config: CONFIG });
  const item = r.inbox[0] as QuestionItem;
  assert.equal(item.resolvedAt, resolvedAtBefore); // untouched — was already answered
  assert.deepEqual(item.resolution, answer);
});

// ---------------------------------------------------------------------------
// Purity & serialization
// ---------------------------------------------------------------------------

test('reduce never mutates its inputs (deep-frozen state and event)', () => {
  const state = deepFreeze(fold(...toRunning('a'), ...toRunning('b')));
  const snapshot = JSON.stringify(state);
  const events: ArgusEvent[] = [
    { seq: 100, ts: 't', type: 'task-verifying', taskId: 'a' },
    { seq: 101, ts: 't', type: 'tool-call', taskId: 'a', tool: 'Bash', detail: 'x', paths: [] },
    { seq: 102, ts: 't', type: 'usage', taskId: 'a', costUsdDelta: 1, tokensDelta: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
    { seq: 103, ts: 't', type: 'task-blocked', taskId: 'b', itemId: 'b#1' },
    { seq: 104, ts: 't', type: 'inbox-raised', item: question('b#1', 'b', 't') },
    { seq: 105, ts: 't', type: 'orchestrator-started', version: '2', config: CONFIG },
  ];
  for (const ev of events) {
    // Frozen inputs would throw on any in-place write.
    assert.doesNotThrow(() => reduce(state, deepFreeze(ev)));
  }
  assert.equal(JSON.stringify(state), snapshot); // original unchanged
});

test('a folded state survives a JSON round-trip unchanged', () => {
  const s = fold(
    { type: 'task-created', spec: spec('a') },
    { type: 'task-queued', taskId: 'a' },
    { type: 'task-started', taskId: 'a', worktreePath: '/wt/a', branch: 'argus/a' },
    { type: 'usage', taskId: 'a', costUsdDelta: 0.5, tokensDelta: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 } },
    { type: 'inbox-raised', item: question('a#1', 'a', '2026-07-18T00:10:00.000Z') },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

test('countByPhase reports every phase, zero-filled', () => {
  const s = fold(
    { type: 'task-created', spec: spec('a') }, // DRAFT
    { type: 'task-created', spec: spec('b') },
    { type: 'task-queued', taskId: 'b' }, // QUEUED
    ...toRunning('c'), // RUNNING
  );
  const counts = countByPhase(s);
  assert.equal(counts.DRAFT, 1);
  assert.equal(counts.QUEUED, 1);
  assert.equal(counts.RUNNING, 1);
  assert.equal(counts.DONE, 0);
  assert.equal(counts.FAILED, 0);
  // All ten phases present as keys.
  assert.equal(Object.keys(counts).length, 10);
});

test('pendingInbox returns unresolved items oldest-first by raisedAt', () => {
  const s = fold(
    ...toRunning('a'),
    // Raised out of chronological order to exercise the sort.
    { type: 'inbox-raised', item: question('a#2', 'a', '2026-07-18T05:00:00.000Z') },
    { type: 'inbox-raised', item: question('a#1', 'a', '2026-07-18T01:00:00.000Z') },
    { type: 'inbox-raised', item: question('a#3', 'a', '2026-07-18T09:00:00.000Z') },
    { type: 'inbox-resolved', itemId: 'a#1', resolution: answer }, // now resolved -> excluded
  );
  const pending = pendingInbox(s);
  assert.deepEqual(pending.map((i) => i.id), ['a#2', 'a#3']);
});

test('blockedTaskIds lists only currently-blocked tasks, in creation order', () => {
  const s = fold(
    ...toRunning('a'),
    ...toRunning('b'),
    ...toRunning('c'),
    { type: 'task-blocked', taskId: 'c', itemId: 'c#1' },
    { type: 'task-blocked', taskId: 'a', itemId: 'a#1' },
  );
  assert.deepEqual(blockedTaskIds(s), ['a', 'c']); // taskOrder order, not event order
});
