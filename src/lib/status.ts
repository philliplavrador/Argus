/**
 * Defensive STATUS.json parsing, phase categorization, and task ordering.
 * No `vscode` imports — unit-testable under node:test.
 *
 * Contract (SPEC.md): any field may be missing or of the wrong type on a
 * malformed write. Parsing never throws; an unreadable file becomes an
 * `ok: false` entry rendered as `⚠ unparsable`.
 */

export const PHASES = [
  "QUEUED",
  "SCOPED",
  "LEASED",
  "DESIGN",
  "BUILD",
  "SELF-VERIFY",
  "REVIEW",
  "GATE",
  "HANDOFF",
  "LANDED",
  "MERGED",
  "PUSHED",
  "BLOCKED",
  "FAILED",
] as const;

export type Phase = (typeof PHASES)[number];

export interface BlockedOn {
  kind: string;
  ref: string | null;
  since: string | null;
}

export interface TaskStatus {
  ok: true;
  id: string;
  title: string | null;
  phase: string;
  pct: number | null;
  etaMin: number | null;
  stepsDone: number | null;
  stepsTotal: number | null;
  tree: string | null;
  branch: string | null;
  agentName: string | null;
  model: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  heartbeatAt: string | null;
  progressToken: string | null;
  blockedOn: BlockedOn | null;
  locks: string[];
  lease: string[];
  lastEvent: string | null;
  acknowledged: boolean;
}

export interface UnparsableStatus {
  ok: false;
  id: string;
  error: string;
}

export type ParsedStatus = TaskStatus | UnparsableStatus;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseBlockedOn(v: unknown): BlockedOn | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return null;
  }
  const o = v as Record<string, unknown>;
  const kind = str(o.kind);
  if (kind === null) {
    return null;
  }
  return { kind, ref: str(o.ref), since: str(o.since) };
}

/**
 * Parse one STATUS.json body. `fallbackId` (the task directory name) is used
 * when `id` is missing and to label unparsable files.
 */
export function parseStatus(json: string, fallbackId: string): ParsedStatus {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { ok: false, id: fallbackId, error: e instanceof Error ? e.message : String(e) };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, id: fallbackId, error: "STATUS.json is not a JSON object" };
  }
  const o = data as Record<string, unknown>;
  const pct = num(o.pct);
  return {
    ok: true,
    id: str(o.id) ?? fallbackId,
    title: str(o.title),
    phase: str(o.phase)?.toUpperCase() ?? "UNKNOWN",
    pct: pct === null ? null : Math.max(0, Math.min(100, pct)),
    etaMin: num(o.etaMin),
    stepsDone: num(o.stepsDone),
    stepsTotal: num(o.stepsTotal),
    tree: str(o.tree),
    branch: str(o.branch),
    agentName: str(o.agentName),
    model: str(o.model),
    startedAt: str(o.startedAt),
    updatedAt: str(o.updatedAt),
    heartbeatAt: str(o.heartbeatAt),
    progressToken: str(o.progressToken),
    blockedOn: parseBlockedOn(o.blockedOn),
    locks: strArr(o.locks),
    lease: strArr(o.lease),
    lastEvent: str(o.lastEvent),
    acknowledged: o.acknowledged === true,
  };
}

/** PUSHED is terminal-success, FAILED terminal-failure; everything else is live. */
export function isTerminal(phase: string): boolean {
  return phase === "PUSHED" || phase === "FAILED";
}

export type Category = "running" | "blocked" | "finished" | "unparsable";

export function categoryOf(s: ParsedStatus): Category {
  if (!s.ok) {
    return "unparsable";
  }
  if (s.phase === "BLOCKED") {
    return "blocked";
  }
  if (isTerminal(s.phase)) {
    return "finished";
  }
  return "running";
}

const CATEGORY_ORDER: Record<Category, number> = {
  running: 0,
  blocked: 1,
  finished: 2,
  unparsable: 3,
};

/**
 * Tree order: running first (by startedAt), then blocked, then finished.
 * Within a category: startedAt ascending (ISO strings compare lexically),
 * missing startedAt last, id as the tiebreak.
 */
export function compareTasks(a: ParsedStatus, b: ParsedStatus): number {
  const ca = CATEGORY_ORDER[categoryOf(a)];
  const cb = CATEGORY_ORDER[categoryOf(b)];
  if (ca !== cb) {
    return ca - cb;
  }
  const ta = a.ok ? a.startedAt : null;
  const tb = b.ok ? b.startedAt : null;
  if (ta !== tb) {
    if (ta === null) {
      return 1;
    }
    if (tb === null) {
      return -1;
    }
    return ta < tb ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

export interface WatchdogFinding {
  taskid: string;
  detector: string;
  tier: number;
}

/** Parse `<stateRoot>/watchdog/sweep.json`; anything malformed yields []. */
export function parseSweep(json: string): WatchdogFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const arr = (data as Record<string, unknown>).openFindings;
  if (!Array.isArray(arr)) {
    return [];
  }
  const findings: WatchdogFinding[] = [];
  for (const f of arr) {
    if (typeof f !== "object" || f === null) {
      continue;
    }
    const o = f as Record<string, unknown>;
    if (typeof o.taskid === "string" && typeof o.detector === "string" && typeof o.tier === "number") {
      findings.push({ taskid: o.taskid, detector: o.detector, tier: o.tier });
    }
  }
  return findings;
}

/** Detector names (upper-cased) for a task's tier >= 3 findings. */
export function warningDetectors(findings: WatchdogFinding[], taskId: string): string[] {
  return findings.filter((f) => f.taskid === taskId && f.tier >= 3).map((f) => f.detector.toUpperCase());
}
