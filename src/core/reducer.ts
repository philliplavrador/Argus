/**
 * The pure event fold. One reducer, three consumers (§ types.ts): the
 * orchestrator, the webview, and any replay of `events.jsonl` all derive
 * `FleetState` by folding `ArgusEvent`s through `reduce`.
 *
 * Contract: `reduce` is total and pure. It never mutates its inputs, never
 * throws, and treats any malformed, unknown-`type`, or dangling-reference event
 * as a no-op that still advances `seq`. Untouched state branches are shared by
 * reference (structural sharing), so an event touching one task leaves every
 * other task object identical.
 */

import {
  AGENT_TEXT_CAP,
  ArgusConfig,
  ArgusEvent,
  FleetState,
  InboxItem,
  Task,
  TaskId,
  TaskPhase,
  TOOL_TAIL_CAP,
  TokenTotals,
} from './types';

/** Every phase, for exhaustive tallies. */
const ALL_PHASES: readonly TaskPhase[] = [
  'DRAFT',
  'QUEUED',
  'RUNNING',
  'BLOCKED',
  'VERIFYING',
  'READY',
  'MERGING',
  'DONE',
  'FAILED',
  'CANCELLED',
];

/** Phases in which the agent subprocess may be alive. */
const LIVE = new Set<TaskPhase>(['RUNNING', 'BLOCKED', 'VERIFYING']);
/** Phases from which a task can no longer transition. */
const TERMINAL = new Set<TaskPhase>(['DONE', 'FAILED', 'CANCELLED']);

const CRASH_REASON = 'interrupted: orchestrator restarted (worktree preserved)';
const CRASH_MERGE_REASON = 'interrupted mid-merge — inspect the repo before retrying';

/** True while the agent process may still be running. */
export function isLivePhase(p: TaskPhase): boolean {
  return LIVE.has(p);
}

/** The empty fleet: no events applied, config as supplied. */
export function initialState(config: ArgusConfig): FleetState {
  return {
    seq: 0,
    config,
    tasks: {},
    taskOrder: [],
    inbox: [],
    mergeQueue: [],
    merging: null,
    fleetCostUsd: 0,
  };
}

/** Fold a whole stream from empty. */
export function foldEvents(events: ArgusEvent[], config: ArgusConfig): FleetState {
  let state = initialState(config);
  if (!Array.isArray(events)) {
    return state;
  }
  for (const event of events) {
    state = reduce(state, event);
  }
  return state;
}

/**
 * Apply one event. Pure: returns a new state (sharing untouched branches) and
 * never mutates `state` or `event`. Any applied event stamps `state.seq`; a
 * no-op event still advances `seq`. A structurally invalid `event` (non-object
 * or missing numeric `seq`) leaves the state entirely unchanged.
 */
export function reduce(state: FleetState, event: ArgusEvent): FleetState {
  if (event === null || typeof event !== 'object' || typeof event.seq !== 'number') {
    return state;
  }
  // Every event advances seq; handlers below extend this base.
  const base: FleetState = { ...state, seq: event.seq };
  const ts = event.ts;

  switch (event.type) {
    case 'orchestrator-started':
      return applyRestart(base, event.config, ts);

    case 'config-changed':
      return event.config && typeof event.config === 'object'
        ? { ...base, config: event.config }
        : base;

    case 'task-created':
      return applyTaskCreated(base, event.spec, ts);

    case 'task-queued':
      return withTask(base, event.taskId, (t) =>
        t.phase === 'DRAFT' ? { ...t, phase: 'QUEUED' } : t,
      );

    case 'task-started':
      return withTask(base, event.taskId, (t) =>
        t.phase === 'QUEUED'
          ? {
              ...t,
              phase: 'RUNNING',
              worktreePath: event.worktreePath,
              branch: event.branch,
              startedAt: ts,
            }
          : t,
      );

    case 'agent-init':
      return withTask(base, event.taskId, (t) =>
        isLivePhase(t.phase) ? { ...t, sessionId: event.sessionId } : t,
      );

    case 'task-blocked':
      return withTask(base, event.taskId, (t) => ({
        ...t,
        blockedOn: event.itemId,
        blockedSince: ts,
        phase: t.phase === 'RUNNING' ? 'BLOCKED' : t.phase,
      }));

    case 'task-resumed':
      return withTask(base, event.taskId, (t) => ({
        ...t,
        blockedOn: null,
        blockedSince: null,
        phase: t.phase === 'BLOCKED' ? 'RUNNING' : t.phase,
      }));

    case 'task-verifying':
      return withTask(base, event.taskId, (t) =>
        t.phase === 'RUNNING' || t.phase === 'BLOCKED'
          ? { ...t, phase: 'VERIFYING', blockedOn: null, blockedSince: null }
          : t,
      );

    case 'gate-finished':
      return event.result && typeof event.result === 'object'
        ? withTask(base, event.taskId, (t) => ({
            ...t,
            gateResults: [...t.gateResults, event.result],
          }))
        : base;

    case 'task-ready':
      return applyTaskReady(base, event.taskId);

    case 'merge-started':
      return applyMergeStarted(base, event.taskId);

    case 'merge-finished':
      return applyMergeFinished(base, event.taskId, ts);

    case 'task-failed':
      return applyTerminal(base, event.taskId, 'FAILED', event.reason, ts);

    case 'task-cancelled':
      return applyTerminal(base, event.taskId, 'CANCELLED', event.reason, ts);

    case 'task-steered':
      return withTask(base, event.taskId, (t) => ({
        ...t,
        lastActivity: ('steered: ' + str(event.message)).slice(0, AGENT_TEXT_CAP),
        lastActivityAt: ts,
      }));

    case 'tool-call':
      return applyToolCall(base, event.taskId, str(event.tool), str(event.detail), ts);

    case 'agent-text':
      return withTask(base, event.taskId, (t) => ({
        ...t,
        lastActivity: str(event.text).slice(0, AGENT_TEXT_CAP),
        lastActivityAt: ts,
      }));

    case 'usage':
      return applyUsage(base, event.taskId, event.costUsdDelta, event.tokensDelta);

    case 'progress':
      return applyProgress(base, event.taskId, event.stepsDone, event.stepsTotal);

    case 'path-write':
      return withTask(base, event.taskId, (t) =>
        addPath(t.writes, event.path) === t.writes
          ? t
          : { ...t, writes: addPath(t.writes, event.path) },
      );

    case 'path-read':
      return withTask(base, event.taskId, (t) =>
        addPath(t.reads, event.path) === t.reads
          ? t
          : { ...t, reads: addPath(t.reads, event.path) },
      );

    case 'scope-expanded':
      return withTask(base, event.taskId, (t) =>
        typeof event.glob === 'string' && event.glob.length > 0 && !t.spec.scope.include.includes(event.glob)
          ? { ...t, spec: { ...t.spec, scope: { include: [...t.spec.scope.include, event.glob] } } }
          : t,
      );

    case 'inbox-raised':
      return applyInboxRaised(base, event.item);

    case 'inbox-resolved':
      return applyInboxResolved(base, event.itemId, event.resolution, ts);

    case 'inbox-voided':
      return applyInboxVoided(base, event.itemId, ts);

    default:
      // Unknown `type` (a forward-compatible event read from disk): no-op.
      return base;
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Tally of tasks by phase, with every phase present (zero when none). */
export function countByPhase(s: FleetState): Record<TaskPhase, number> {
  const counts = {} as Record<TaskPhase, number>;
  for (const p of ALL_PHASES) {
    counts[p] = 0;
  }
  for (const id of Object.keys(s.tasks)) {
    const phase = s.tasks[id].phase;
    if (phase in counts) {
      counts[phase] += 1;
    }
  }
  return counts;
}

/** Unresolved inbox items, oldest first (by `raisedAt`, stable on ties). */
export function pendingInbox(s: FleetState): InboxItem[] {
  const pending = s.inbox
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.resolvedAt === null);
  pending.sort((a, b) => {
    if (a.item.raisedAt < b.item.raisedAt) {
      return -1;
    }
    if (a.item.raisedAt > b.item.raisedAt) {
      return 1;
    }
    return a.index - b.index;
  });
  return pending.map(({ item }) => item);
}

/** Ids of tasks currently holding a `blockedOn`, in creation order. */
export function blockedTaskIds(s: FleetState): TaskId[] {
  return s.taskOrder.filter((id) => {
    const t = s.tasks[id];
    return t !== undefined && t.blockedOn !== null;
  });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Replace a task via `fn`, sharing state when `fn` returns the same object or
 * the task is unknown. `base` already carries the advanced `seq`.
 */
function withTask(base: FleetState, taskId: TaskId, fn: (t: Task) => Task): FleetState {
  const t = base.tasks[taskId];
  if (t === undefined) {
    return base;
  }
  const next = fn(t);
  if (next === t) {
    return base;
  }
  return { ...base, tasks: { ...base.tasks, [taskId]: next } };
}

/** Crash recovery: fail every live/merging task and void their pending inbox. */
function applyRestart(base: FleetState, config: ArgusConfig, ts: string): FleetState {
  const nextConfig = config && typeof config === 'object' ? config : base.config;

  const interrupted = new Set<TaskId>();
  const tasks: Record<TaskId, Task> = {};
  for (const id of Object.keys(base.tasks)) {
    const t = base.tasks[id];
    if (t.phase === 'MERGING') {
      interrupted.add(id);
      tasks[id] = {
        ...t,
        phase: 'FAILED',
        failureReason: CRASH_MERGE_REASON,
        endedAt: ts,
        blockedOn: null,
        blockedSince: null,
      };
    } else if (isLivePhase(t.phase)) {
      interrupted.add(id);
      tasks[id] = {
        ...t,
        phase: 'FAILED',
        failureReason: CRASH_REASON,
        endedAt: ts,
        blockedOn: null,
        blockedSince: null,
      };
    } else {
      tasks[id] = t;
    }
  }

  // Pending inbox items of interrupted tasks are voided: resolvedAt set,
  // resolution left null (the UI reads this pair as 'expired', not 'answered').
  const inbox = base.inbox.map((item) =>
    item.resolvedAt === null && interrupted.has(item.taskId)
      ? ({ ...item, resolvedAt: ts } as InboxItem)
      : item,
  );

  // Only still-READY tasks survive the merge queue; merging is cleared.
  const mergeQueue = base.mergeQueue.filter((id) => tasks[id]?.phase === 'READY');

  return { ...base, config: nextConfig, tasks, inbox, mergeQueue, merging: null };
}

function applyTaskCreated(base: FleetState, spec: Task['spec'], ts: string): FleetState {
  if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string') {
    return base;
  }
  if (base.tasks[spec.id] !== undefined) {
    return base; // duplicate id: keep first
  }
  const task: Task = {
    spec,
    phase: 'DRAFT',
    createdAt: ts,
    startedAt: null,
    endedAt: null,
    worktreePath: null,
    branch: null,
    sessionId: null,
    lastActivity: null,
    lastActivityAt: null,
    recentToolCalls: [],
    blockedOn: null,
    blockedSince: null,
    stepsDone: null,
    stepsTotal: null,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    writes: [],
    reads: [],
    escalations: 0,
    gateResults: [],
    failureReason: null,
  };
  return {
    ...base,
    tasks: { ...base.tasks, [spec.id]: task },
    taskOrder: [...base.taskOrder, spec.id],
  };
}

function applyTaskReady(base: FleetState, taskId: TaskId): FleetState {
  const t = base.tasks[taskId];
  // VERIFYING → READY is the gate-pass path; MERGING → READY is a merge
  // attempt backing off (conflict resolved by hand, retry later) — it must
  // also release the fleet-wide merge slot and clear any block marker.
  if (t === undefined || (t.phase !== 'VERIFYING' && t.phase !== 'MERGING')) {
    return base;
  }
  const fromMerging = t.phase === 'MERGING';
  const tasks = {
    ...base.tasks,
    [taskId]: { ...t, phase: 'READY' as TaskPhase, blockedOn: null, blockedSince: null },
  };
  const mergeQueue = base.mergeQueue.includes(taskId)
    ? base.mergeQueue
    : [...base.mergeQueue, taskId];
  return {
    ...base,
    tasks,
    mergeQueue,
    merging: fromMerging && base.merging === taskId ? null : base.merging,
  };
}

function applyMergeStarted(base: FleetState, taskId: TaskId): FleetState {
  const t = base.tasks[taskId];
  if (t === undefined || t.phase !== 'READY') {
    return base;
  }
  return {
    ...base,
    tasks: { ...base.tasks, [taskId]: { ...t, phase: 'MERGING' } },
    merging: taskId,
    mergeQueue: base.mergeQueue.filter((id) => id !== taskId),
  };
}

function applyMergeFinished(base: FleetState, taskId: TaskId, ts: string): FleetState {
  const t = base.tasks[taskId];
  const merging = base.merging === taskId ? null : base.merging;
  if (t === undefined || t.phase !== 'MERGING') {
    return merging === base.merging ? base : { ...base, merging };
  }
  return {
    ...base,
    // The worktree and branch are torn down as part of a finished merge —
    // clearing the path keeps the UI from offering actions on a deleted dir.
    tasks: { ...base.tasks, [taskId]: { ...t, phase: 'DONE', endedAt: ts, worktreePath: null } },
    merging,
  };
}

/** Expired, not answered: resolvedAt set, resolution stays null. */
function applyInboxVoided(base: FleetState, itemId: string, ts: string): FleetState {
  const idx = base.inbox.findIndex((i) => i.id === itemId);
  if (idx < 0 || base.inbox[idx].resolvedAt !== null) {
    return base;
  }
  const inbox = [...base.inbox];
  inbox[idx] = { ...inbox[idx], resolvedAt: ts } as InboxItem;
  return { ...base, inbox };
}

function applyTerminal(
  base: FleetState,
  taskId: TaskId,
  phase: 'FAILED' | 'CANCELLED',
  reason: string | null,
  ts: string,
): FleetState {
  const t = base.tasks[taskId];
  if (t === undefined || TERMINAL.has(t.phase)) {
    return base;
  }
  return {
    ...base,
    tasks: {
      ...base.tasks,
      [taskId]: {
        ...t,
        phase,
        endedAt: ts,
        failureReason: reason,
        blockedOn: null,
        blockedSince: null,
      },
    },
    mergeQueue: base.mergeQueue.filter((id) => id !== taskId),
    merging: base.merging === taskId ? null : base.merging,
  };
}

function applyToolCall(
  base: FleetState,
  taskId: TaskId,
  tool: string,
  detail: string,
  ts: string,
): FleetState {
  return withTask(base, taskId, (t) => {
    const recentToolCalls = [...t.recentToolCalls, { ts, tool, detail }];
    if (recentToolCalls.length > TOOL_TAIL_CAP) {
      recentToolCalls.splice(0, recentToolCalls.length - TOOL_TAIL_CAP);
    }
    return { ...t, lastActivity: detail, lastActivityAt: ts, recentToolCalls };
  });
}

function applyUsage(
  base: FleetState,
  taskId: TaskId,
  costUsdDelta: number,
  tokensDelta: TokenTotals,
): FleetState {
  const cost = safeDelta(costUsdDelta);
  const d = tokensDelta && typeof tokensDelta === 'object' ? tokensDelta : ({} as TokenTotals);
  const next = withTask(base, taskId, (t) => ({
    ...t,
    costUsd: t.costUsd + cost,
    tokens: {
      input: t.tokens.input + safeDelta(d.input),
      output: t.tokens.output + safeDelta(d.output),
      cacheRead: t.tokens.cacheRead + safeDelta(d.cacheRead),
      cacheWrite: t.tokens.cacheWrite + safeDelta(d.cacheWrite),
    },
  }));
  // Fleet cost accrues only when the referenced task existed (next changed).
  return next === base ? base : { ...next, fleetCostUsd: base.fleetCostUsd + cost };
}

function applyProgress(
  base: FleetState,
  taskId: TaskId,
  stepsDone: number,
  stepsTotal: number,
): FleetState {
  const valid =
    Number.isInteger(stepsDone) &&
    Number.isInteger(stepsTotal) &&
    stepsDone >= 0 &&
    stepsTotal >= 0 &&
    stepsDone <= stepsTotal;
  if (!valid) {
    return base;
  }
  return withTask(base, taskId, (t) => ({ ...t, stepsDone, stepsTotal }));
}

function applyInboxRaised(base: FleetState, item: InboxItem): FleetState {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
    return base;
  }
  if (base.inbox.some((existing) => existing.id === item.id)) {
    return base; // duplicate item id: keep first
  }
  return { ...base, inbox: [...base.inbox, item] };
}

function applyInboxResolved(
  base: FleetState,
  itemId: string,
  resolution: InboxItem['resolution'],
  ts: string,
): FleetState {
  const index = base.inbox.findIndex((item) => item.id === itemId);
  if (index === -1) {
    return base; // unknown itemId
  }
  const item = base.inbox[index];
  if (
    item.resolution !== null ||
    !resolution ||
    typeof resolution !== 'object' ||
    resolution.rkind !== item.kind
  ) {
    return base; // already resolved, or resolution kind mismatched
  }
  const inbox = base.inbox.slice();
  // The resolution/kind agreement is checked above; the cast pairs the matching
  // union members that the compiler cannot correlate across the two values.
  inbox[index] = { ...item, resolution, resolvedAt: ts } as InboxItem;
  return { ...base, inbox };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A usage delta is trusted only when finite and non-negative; else 0. */
function safeDelta(x: number): number {
  return Number.isFinite(x) && x >= 0 ? x : 0;
}

/** Append `path` to `list` when it is a new string; else return `list` as-is. */
function addPath(list: string[], path: unknown): string[] {
  if (typeof path !== 'string' || list.includes(path)) {
    return list;
  }
  return [...list, path];
}

/** Coerce an untrusted value to a string without throwing. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}
