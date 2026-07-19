/**
 * Argus v2 core contracts.
 *
 * PURE DATA ONLY. This file — and everything under `src/core/` — imports
 * neither `vscode` nor the Agent SDK. The orchestrator's in-memory state is a
 * pure fold over `ArgusEvent`s; the webview runs the *same* fold over the
 * *same* events; `.argus/state/events.jsonl` is the durable form of the same
 * stream. One reducer, three consumers.
 *
 * Everything here must survive `JSON.parse(JSON.stringify(x))` unchanged —
 * state crosses the webview boundary via `postMessage` and the disk via JSONL.
 */

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Task identifier: a kebab-case slug, unique within the fleet. */
export type TaskId = string;
/** Inbox item identifier: `<taskId>#<n>`. */
export type InboxItemId = string;
/** Monotonic event sequence number, 1-based, assigned by the EventLog. */
export type Seq = number;
/** ISO-8601 UTC timestamp. */
export type IsoTime = string;

/** Known model ids, open-ended for forward compatibility. */
export type ModelId =
  | 'claude-fable-5'
  | 'claude-opus-4-8'
  | 'claude-haiku-4-5-20251001'
  | (string & {});

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Verbosity = 'terse' | 'normal' | 'detailed';
export type Pushback = 'autonomous' | 'balanced' | 'consult';

/**
 * Task lifecycle. `BLOCKED` means a human decision is pending in the inbox and
 * the agent process is alive, parked inside `canUseTool`. `MERGING` is held by
 * at most one task fleet-wide. `READY` means all gates passed and the task
 * awaits its merge-queue turn.
 */
export type TaskPhase =
  | 'DRAFT'
  | 'QUEUED'
  | 'RUNNING'
  | 'BLOCKED'
  | 'VERIFYING'
  | 'READY'
  | 'MERGING'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED';

/** Phases in which the agent subprocess may be alive. */
export const LIVE_PHASES: readonly TaskPhase[] = ['RUNNING', 'BLOCKED', 'VERIFYING'];
/** Terminal phases: the task will never change again. */
export const TERMINAL_PHASES: readonly TaskPhase[] = ['DONE', 'FAILED', 'CANCELLED'];

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * What a task is allowed to write. Globs are repo-root-relative with forward
 * slashes, matched by `src/core/scope.ts` which supports the documented subset
 * `**`, `*`, `?` (no braces, no extglobs, no negation). Matching is
 * case-insensitive (Windows-first product).
 *
 * An empty `include` means the task may write nothing — every write escalates.
 */
export interface Scope {
  include: string[];
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * A verify gate: a shell command that must exit 0 in the task's worktree
 * before the task can leave `VERIFYING`. Per design principle 7 this is
 * enforcement, not prompt text: a failing gate physically blocks `READY` and
 * raises a `verify-failure` inbox item.
 */
export interface Gate {
  name: string;
  command: string;
}

export interface GateResult {
  name: string;
  command: string;
  exitCode: number;
  /** Last ~4KB of combined output — enough to act on from the inbox. */
  outputTail: string;
  durationMs: number;
  finishedAt: IsoTime;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/** Everything the human declares at creation time. Immutable except `scope`
 * (which can grow via an `expand-scope` escalation resolution). */
export interface TaskSpec {
  id: TaskId;
  title: string;
  /** The task prompt handed to the agent, verbatim. */
  prompt: string;
  scope: Scope;
  model: ModelId;
  effort: Effort;
  gates: Gate[];
  /** Per-task spend ceiling in USD (client-side estimate); null = fleet default. */
  budgetUsd: number | null;
  /** Enter the merge queue automatically on READY, or wait for a click. */
  autoMerge: boolean;
}

/** One entry in a task's live tool-call tail. */
export interface ToolCallSummary {
  ts: IsoTime;
  tool: string;
  /** One human line, e.g. `Edit src/lib/date.ts` or `Bash npm test`. */
  detail: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Live task state. Entirely derived from events — never mutated directly. */
export interface Task {
  spec: TaskSpec;
  phase: TaskPhase;
  createdAt: IsoTime;
  startedAt: IsoTime | null;
  endedAt: IsoTime | null;
  /** Absolute path of the task's git worktree, once provisioned. */
  worktreePath: string | null;
  branch: string | null;
  /** SDK session id, once the agent has emitted its init message. */
  sessionId: string | null;

  /** One-line summary of the most recent activity, for the Fleet row. */
  lastActivity: string | null;
  lastActivityAt: IsoTime | null;
  /** Rolling tail of tool calls, newest last, capped at TOOL_TAIL_CAP. */
  recentToolCalls: ToolCallSummary[];

  /** Set while BLOCKED: the inbox item holding this task. */
  blockedOn: InboxItemId | null;
  blockedSince: IsoTime | null;

  /**
   * Honest progress: agent-declared steps, or null when unknown. The UI shows
   * a phase + activity indicator when null — never a fake-advancing bar.
   */
  stepsDone: number | null;
  stepsTotal: number | null;

  /** Client-side spend estimate for this task (deduped upstream by message id). */
  costUsd: number;
  tokens: TokenTotals;

  /** Instrumentation (§7): distinct repo-relative paths this task touched. */
  writes: string[];
  reads: string[];
  /** Count of scope escalations raised by this task. */
  escalations: number;

  gateResults: GateResult[];
  /** Human-readable reason for FAILED/CANCELLED, else null. */
  failureReason: string | null;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export type InboxItemKind =
  | 'question'
  | 'scope-escalation'
  | 'verify-failure'
  | 'merge-conflict';

interface InboxItemBase {
  id: InboxItemId;
  taskId: TaskId;
  raisedAt: IsoTime;
  /** null while pending. Resolved items stay in state for the Timeline. */
  resolvedAt: IsoTime | null;
}

export interface QuestionOption {
  label: string;
  description: string | null;
}

/** Raised when the agent calls `AskUserQuestion`. */
export interface QuestionItem extends InboxItemBase {
  kind: 'question';
  /** Short chip label from the tool input, when present. */
  header: string | null;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  resolution: QuestionResolution | null;
}

export interface QuestionResolution {
  rkind: 'question';
  /** Chosen option labels (1+ when multiSelect, exactly 1 otherwise, 0 with freeText). */
  optionLabels: string[];
  freeText: string | null;
}

/** Raised when ScopeGuard sees an Edit/Write/NotebookEdit outside scope. */
export interface ScopeEscalationItem extends InboxItemBase {
  kind: 'scope-escalation';
  tool: string;
  /** Repo-relative path the agent tried to write. */
  path: string;
  /** Other non-terminal tasks whose scope covers `path` — the collision warning. */
  overlappingTasks: TaskId[];
  resolution: ScopeEscalationResolution | null;
}

export type ScopeEscalationResolution =
  | { rkind: 'scope-escalation'; action: 'allow-once' }
  | { rkind: 'scope-escalation'; action: 'expand-scope'; glob: string }
  | { rkind: 'scope-escalation'; action: 'deny'; reason: string };

/** Raised when a gate fails during VERIFYING. */
export interface VerifyFailureItem extends InboxItemBase {
  kind: 'verify-failure';
  gate: GateResult;
  resolution: VerifyFailureResolution | null;
}

export type VerifyFailureResolution =
  | { rkind: 'verify-failure'; action: 'send-back'; note: string | null }
  | { rkind: 'verify-failure'; action: 'override' }
  | { rkind: 'verify-failure'; action: 'abandon' };

/** Raised when the merge queue's rebase hits a conflict. */
export interface MergeConflictItem extends InboxItemBase {
  kind: 'merge-conflict';
  files: string[];
  detail: string;
  resolution: MergeConflictResolution | null;
}

export type MergeConflictResolution =
  | { rkind: 'merge-conflict'; action: 'agent-fix' }
  | { rkind: 'merge-conflict'; action: 'open-editor' }
  | { rkind: 'merge-conflict'; action: 'abandon' };

export type InboxItem =
  | QuestionItem
  | ScopeEscalationItem
  | VerifyFailureItem
  | MergeConflictItem;

export type InboxResolution =
  | QuestionResolution
  | ScopeEscalationResolution
  | VerifyFailureResolution
  | MergeConflictResolution;

// ---------------------------------------------------------------------------
// Config & repo profile
// ---------------------------------------------------------------------------

/** Fleet policy, persisted at `.argus/config.json` (committed). */
export interface ArgusConfig {
  maxConcurrentAgents: number;
  defaultModel: ModelId;
  defaultEffort: Effort;
  /** Appended to the system prompt. */
  verbosity: Verbosity;
  /**
   * Dual control (§10): appends a directive to the system prompt AND selects
   * the permission policy in AgentRunner. The prompt half alone is a
   * suggestion; the permission half is the enforcement.
   */
  pushback: Pushback;
  perTaskBudgetUsd: number | null;
  fleetBudgetUsd: number | null;
  autoMerge: boolean;
  /** Repo-wide verify command used when a task declares no gates; null = none. */
  verifyCommand: string | null;
}

export const DEFAULT_CONFIG: ArgusConfig = {
  maxConcurrentAgents: 3,
  defaultModel: 'claude-opus-4-8',
  defaultEffort: 'high',
  verbosity: 'normal',
  pushback: 'balanced',
  perTaskBudgetUsd: 10,
  fleetBudgetUsd: 50,
  autoMerge: false,
  verifyCommand: null,
};

/** Detected repo layout, cached at `.argus/profile.json` (committed, regenerable). */
export interface RepoProfile {
  detectedAt: IsoTime;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  /** Workspace globs from package.json / pnpm-workspace.yaml, if any. */
  workspaces: string[];
  /** Root package.json scripts, verbatim. */
  scripts: Record<string, string>;
  /** e.g. 'vitest', 'jest', 'playwright', 'node:test', 'mocha'. */
  testRunners: string[];
  devServerCommand: string | null;
  typecheckCommand: string | null;
  lintCommand: string | null;
}

// ---------------------------------------------------------------------------
// Events — the source of truth
// ---------------------------------------------------------------------------

/**
 * Every state change is one of these, appended to `.argus/state/events.jsonl`.
 * `seq` and `ts` are stamped by the EventLog at append time. The reducer must
 * treat unknown `type` values as no-ops (forward compatibility) and must never
 * throw on any event — a corrupt line is skipped, not fatal.
 *
 * Raw SDK message streams do NOT go here; they go to `.argus/logs/<taskId>.jsonl`.
 * Events carry the semantic summary the UI and the collision report need.
 */
export type ArgusEvent = { seq: Seq; ts: IsoTime } & ArgusEventBody;

export type ArgusEventBody =
  // --- orchestrator lifecycle ---
  | { type: 'orchestrator-started'; version: string; config: ArgusConfig }
  | { type: 'config-changed'; config: ArgusConfig }
  // --- task lifecycle ---
  | { type: 'task-created'; spec: TaskSpec }
  | { type: 'task-queued'; taskId: TaskId }
  | { type: 'task-started'; taskId: TaskId; worktreePath: string; branch: string }
  | { type: 'agent-init'; taskId: TaskId; sessionId: string; model: string }
  | { type: 'task-blocked'; taskId: TaskId; itemId: InboxItemId }
  | { type: 'task-resumed'; taskId: TaskId; itemId: InboxItemId }
  | { type: 'task-verifying'; taskId: TaskId }
  | { type: 'gate-finished'; taskId: TaskId; result: GateResult }
  | { type: 'task-ready'; taskId: TaskId }
  | { type: 'merge-started'; taskId: TaskId }
  | { type: 'merge-finished'; taskId: TaskId; mergeCommit: string }
  | { type: 'task-failed'; taskId: TaskId; reason: string }
  | { type: 'task-cancelled'; taskId: TaskId; reason: string | null }
  | { type: 'task-steered'; taskId: TaskId; message: string }
  // --- agent stream summaries ---
  | { type: 'tool-call'; taskId: TaskId; tool: string; detail: string; paths: string[] }
  | { type: 'agent-text'; taskId: TaskId; text: string }
  | { type: 'usage'; taskId: TaskId; costUsdDelta: number; tokensDelta: TokenTotals }
  | { type: 'progress'; taskId: TaskId; stepsDone: number; stepsTotal: number }
  // --- scope instrumentation (§7) ---
  | { type: 'path-write'; taskId: TaskId; path: string; tool: string }
  | { type: 'path-read'; taskId: TaskId; path: string }
  // --- inbox ---
  | { type: 'inbox-raised'; item: InboxItem }
  | { type: 'inbox-resolved'; itemId: InboxItemId; resolution: InboxResolution };

// ---------------------------------------------------------------------------
// FleetState — fold(events)
// ---------------------------------------------------------------------------

export interface FleetState {
  /** seq of the last applied event; 0 for the empty state. */
  seq: Seq;
  config: ArgusConfig;
  tasks: Record<TaskId, Task>;
  /** Creation order, for stable rendering. */
  taskOrder: TaskId[];
  /** All inbox items ever raised, pending and resolved. */
  inbox: InboxItem[];
  /** READY tasks awaiting merge, FIFO. */
  mergeQueue: TaskId[];
  /** The single task currently MERGING, if any. */
  merging: TaskId | null;
  /** Fleet-wide client-side spend estimate. */
  fleetCostUsd: number;
}

// ---------------------------------------------------------------------------
// Webview ↔ host protocol
// ---------------------------------------------------------------------------

/**
 * The webview owns nothing. On open it sends `ready`; the host replies with a
 * full `snapshot`; thereafter the host pushes batched `events` (interval set
 * by Spike D) and the webview applies the same reducer. Closing the panel
 * costs nothing; reopening replays snapshot → live.
 */
export type HostToWebview =
  | { kind: 'snapshot'; state: FleetState }
  | { kind: 'events'; events: ArgusEvent[] }
  | { kind: 'toast'; level: 'info' | 'warn' | 'error'; text: string };

export type WebviewToHost =
  | { kind: 'ready' }
  | { kind: 'create-task'; spec: TaskSpec }
  | { kind: 'answer'; itemId: InboxItemId; resolution: InboxResolution }
  | { kind: 'stop-task'; taskId: TaskId }
  | { kind: 'steer'; taskId: TaskId; message: string }
  | { kind: 'open-worktree'; taskId: TaskId }
  | { kind: 'view-diff'; taskId: TaskId }
  | { kind: 'merge-task'; taskId: TaskId }
  | { kind: 'set-config'; config: ArgusConfig }
  | { kind: 'init-workspace' }
  | { kind: 'stop-all' }
  | { kind: 'cleanup-worktrees' };

// ---------------------------------------------------------------------------
// Tuning constants (Spike-adjustable)
// ---------------------------------------------------------------------------

/** Max entries kept in a task's recentToolCalls tail. */
export const TOOL_TAIL_CAP = 50;
/** Max characters of an agent text block kept in an `agent-text` event. */
export const AGENT_TEXT_CAP = 240;
/** Default host→webview event batch interval in ms (Spike D refines). */
export const EVENT_BATCH_MS = 100;
