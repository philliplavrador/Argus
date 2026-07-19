/**
 * ScopeGuard's pure decision core: classify a tool call against a task's
 * scope. The imperative half (AgentRunner's `canUseTool`) acts on the verdict;
 * everything about *what* to do lives here where it is testable.
 *
 * v2.0 checks the path-bearing write tools (`Edit`, `Write`, `NotebookEdit`)
 * and records `Read` paths for instrumentation (§7). `Bash` commands are not
 * path-checked — that limitation is documented in SPEC.md — but destructive
 * command shapes are classified so the pushback policy can escalate them.
 */

import type { Pushback, Scope } from './types';
import { normalizePath, pathInScope, toRepoRelative } from './scope';

export type ScopeVerdict =
  /** Not a write tool, or a policy-allowed call: let it through, no record. */
  | { kind: 'allow' }
  /** In-scope write: allow and record the path (repo-relative). */
  | { kind: 'record-write'; path: string; tool: string }
  /** Allowed read: record the path (repo-relative). */
  | { kind: 'record-read'; path: string }
  /** Out-of-scope or unparseable write, or risky Bash under a strict policy:
   * park the agent and ask the human. `path` is repo-relative when inside the
   * worktree, absolute when outside it, or a placeholder when unparseable. */
  | { kind: 'escalate'; path: string; tool: string };

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/**
 * Bash command shapes that count as destructive. Deliberately short and
 * conservative — this backs the pushback policy (balanced/consult escalate
 * these), not a security boundary.
 */
const RISKY_BASH = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, // rm -rf and friends
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[fsq]\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+checkout\b/i, // branch switching breaks the worktree contract
  /\bgit\s+switch\b/i,
  /\bnpm\s+publish\b/i,
  /\bvsce\s+publish\b/i,
  /\bRemove-Item\b.*\b(-Recurse|-Force)\b/i,
  /\bshutdown\b/i,
  /\bformat\b\s+[a-z]:/i,
];

/** True when a Bash command matches a destructive shape. */
export function isRiskyBashCommand(command: string): boolean {
  return RISKY_BASH.some((re) => re.test(command));
}

/**
 * Classify one tool call. `worktreeRoot` is the task's worktree (absolute);
 * relative tool paths resolve against it, because it is the agent's cwd.
 *
 * Fail-closed rule: a write tool whose path cannot be parsed escalates.
 */
export function checkToolCall(
  scope: Scope,
  pushback: Pushback,
  worktreeRoot: string,
  toolName: string,
  input: unknown,
): ScopeVerdict {
  if (WRITE_TOOLS.has(toolName)) {
    const raw = extractPath(input);
    if (raw === null) {
      return { kind: 'escalate', path: '(unparseable tool input)', tool: toolName };
    }
    const rel = resolveAgainst(worktreeRoot, raw);
    if (rel === null) {
      // Outside the worktree entirely — always the human's call.
      return { kind: 'escalate', path: normalizePath(raw), tool: toolName };
    }
    return pathInScope(scope, rel)
      ? { kind: 'record-write', path: rel, tool: toolName }
      : { kind: 'escalate', path: rel, tool: toolName };
  }

  if (toolName === 'Read') {
    const raw = extractPath(input);
    if (raw !== null) {
      const rel = resolveAgainst(worktreeRoot, raw);
      if (rel !== null) {
        return { kind: 'record-read', path: rel };
      }
    }
    return { kind: 'allow' };
  }

  if (toolName === 'Bash' && pushback !== 'autonomous') {
    const command = extractCommand(input);
    if (command !== null && isRiskyBashCommand(command)) {
      return { kind: 'escalate', path: truncate(command, 120), tool: 'Bash' };
    }
  }

  return { kind: 'allow' };
}

/** file_path / notebook_path / path, defensively. */
function extractPath(input: unknown): string | null {
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

function extractCommand(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const v = (input as Record<string, unknown>)['command'];
  return typeof v === 'string' ? v : null;
}

/** Absolute → repo-relative (or null if outside); relative → normalized as-is. */
function resolveAgainst(worktreeRoot: string, p: string): string | null {
  const norm = normalizePath(p);
  if (isAbsolute(norm)) {
    return toRepoRelative(worktreeRoot, norm);
  }
  return norm;
}

function isAbsolute(p: string): boolean {
  return /^[a-z]:\//i.test(p) || p.startsWith('/');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
