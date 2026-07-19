/**
 * Contracts between the orchestrator and its imperative adapters.
 *
 * These interfaces deliberately hide *mechanism*: whether AgentRunner parks an
 * agent inside a blocking `canUseTool` or aborts-and-resumes (Spike B decides)
 * is invisible here; whether WorktreeManager copies or junctions node_modules
 * (Spike C decides) is invisible here. The orchestrator and UI depend only on
 * this file plus `src/core/types.ts`.
 *
 * This file may be imported by host code only — never by `src/core/` or the
 * webview. It must not import `vscode` or the SDK itself (adapters do).
 */

import type {
  ArgusConfig,
  ArgusEvent,
  ArgusEventBody,
  InboxResolution,
  QuestionOption,
  TaskId,
  TaskSpec,
} from '../core/types';

/** Structural stand-in for vscode.Disposable — keeps this file host-agnostic. */
export interface Disposable {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// EventLog
// ---------------------------------------------------------------------------

/**
 * Durable append-only store over `.argus/state/events.jsonl`.
 * Appends are serialized internally; listeners fire after the write is
 * durable, in append order. Replay tolerates a truncated final line (the
 * process may have died mid-write) by skipping it.
 */
export interface EventLog {
  /** Stamp `seq` + `ts`, append durably, then notify listeners. */
  append(body: ArgusEventBody): Promise<ArgusEvent>;
  /** All events from disk, in seq order. Corrupt lines are skipped, counted. */
  replay(): Promise<{ events: ArgusEvent[]; skippedLines: number }>;
  onEvent(listener: (e: ArgusEvent) => void): Disposable;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// WorktreeManager
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  taskId: TaskId;
  /** Absolute path, `<repo>/.argus/worktrees/<taskId>`. */
  path: string;
  /** Branch name, `argus/<taskId>`. */
  branch: string;
}

/**
 * Owns `git worktree` lifecycle under `.argus/worktrees/`. All git operations
 * are serialized through an internal queue (Spike C confirms whether git
 * tolerates concurrent worktree mutation; the queue stands either way).
 */
export interface WorktreeManager {
  /** Create worktree + branch for a task. Fails if either already exists. */
  provision(taskId: TaskId): Promise<WorktreeInfo>;
  /**
   * Remove a task's worktree. Callers must stop the task's agent process
   * first — removal while a subprocess holds a handle is the known Windows
   * failure mode. `force` maps to `git worktree remove --force` (discards
   * uncommitted changes in the worktree).
   */
  remove(taskId: TaskId, opts?: { force?: boolean; deleteBranch?: boolean }): Promise<void>;
  /** Worktrees currently on disk under `.argus/worktrees/`. */
  list(): Promise<WorktreeInfo[]>;
  /** On-disk worktrees whose task is not live — restart leftovers. */
  findStale(liveTaskIds: readonly TaskId[]): Promise<WorktreeInfo[]>;
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

/**
 * What a running agent needs the orchestrator to do. The runner never touches
 * the EventLog or Inbox directly — it emits bodies and awaits decisions.
 */
export interface AgentCallbacks {
  /** Fire-and-forget semantic event (tool-call, usage, path-write, …). */
  emit(body: ArgusEventBody): void;
  /**
   * Raise a human decision and resolve when answered. While the returned
   * promise is pending the agent is parked (the task shows BLOCKED ★).
   * Rejection means the task is being cancelled — the runner must unwind.
   */
  decide(request: DecisionRequest): Promise<InboxResolution>;
}

/** The two decision kinds an agent itself can raise mid-run. (verify-failure
 * and merge-conflict items are raised by the orchestrator, not the runner.) */
export type DecisionRequest =
  | {
      kind: 'question';
      header: string | null;
      question: string;
      options: QuestionOption[];
      multiSelect: boolean;
    }
  | {
      kind: 'scope-escalation';
      tool: string;
      /** Repo-relative path the agent tried to write. */
      path: string;
    };

export type AgentOutcome =
  | { result: 'success'; detail: string | null }
  | { result: 'error'; detail: string }
  | { result: 'aborted'; detail: string | null };

/** Handle over one live agent session. */
export interface AgentHandle {
  readonly taskId: TaskId;
  /** Inject a user message into the live session (steering). */
  steer(message: string): Promise<void>;
  /** Abort the session. Resolves once the subprocess is gone. */
  stop(reason: string | null): Promise<void>;
  /** Resolves when the session ends, however it ends. Never rejects. */
  readonly done: Promise<AgentOutcome>;
}

export interface StartAgentOptions {
  spec: TaskSpec;
  /** The task's worktree — the agent's cwd and scope root. */
  worktreePath: string;
  config: ArgusConfig;
  callbacks: AgentCallbacks;
}

/** Spawn an agent for a task. One call per task run. */
export type StartAgent = (opts: StartAgentOptions) => AgentHandle;

// ---------------------------------------------------------------------------
// GateRunner
// ---------------------------------------------------------------------------

/** Runs verify gates in a task's worktree, one at a time. */
export interface GateRunner {
  run(
    worktreePath: string,
    gate: { name: string; command: string },
  ): Promise<{ exitCode: number; outputTail: string; durationMs: number }>;
}
