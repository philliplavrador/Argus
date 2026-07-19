/**
 * The §7 measurement: two different numbers gating two different features.
 *
 * - **Stray rate** — fraction of started tasks that attempted a write outside
 *   their declared scope (raised ≥1 scope escalation). Tells you how much
 *   friction ScopeGuard causes; ScopeGuard ships regardless.
 * - **Collision rate** — fraction of *concurrently running* task pairs whose
 *   write sets intersected. This is the number that decides whether the
 *   conflict-aware scheduler (v2.3) is worth building. If it stays low, the
 *   scheduler idea gets closed in SPEC.md — a documented decision not to
 *   build is a real deliverable.
 *
 * Pure fold over the event stream; no clock, no I/O.
 */

import type { ArgusEvent, IsoTime, TaskId } from './types';

export interface CollisionPair {
  a: TaskId;
  b: TaskId;
  /** Paths both tasks wrote while their run intervals overlapped. */
  paths: string[];
}

export interface CollisionReport {
  generatedAt: IsoTime;
  eventsAnalyzed: number;
  /** Tasks that actually started. */
  tasksAnalyzed: number;
  tasksWithWrites: number;
  /** started tasks raising ≥1 scope escalation / started tasks. 0 when none started. */
  strayRate: number;
  strayTasks: TaskId[];
  totalEscalations: number;
  escalationOutcomes: { 'allow-once': number; 'expand-scope': number; deny: number; unresolved: number };
  /** Pairs of tasks whose [start, end] intervals overlapped in wall time. */
  concurrentPairs: number;
  collidingPairs: CollisionPair[];
  /** collidingPairs / concurrentPairs. 0 when no pair ever ran concurrently. */
  collisionRate: number;
}

interface TaskTrace {
  started: number | null;
  ended: number | null;
  writes: Set<string>;
  escalations: number;
}

export function collisionReport(events: readonly ArgusEvent[], generatedAt: IsoTime): CollisionReport {
  const traces = new Map<TaskId, TaskTrace>();
  const escalationItems = new Map<string, TaskId>();
  const outcomes = { 'allow-once': 0, 'expand-scope': 0, deny: 0, unresolved: 0 };
  let lastTs = 0;

  const trace = (id: TaskId): TaskTrace => {
    let t = traces.get(id);
    if (t === undefined) {
      t = { started: null, ended: null, writes: new Set(), escalations: 0 };
      traces.set(id, t);
    }
    return t;
  };

  for (const e of events) {
    const ts = Date.parse(e.ts);
    if (!Number.isNaN(ts)) {
      lastTs = Math.max(lastTs, ts);
    }
    switch (e.type) {
      case 'task-started':
        trace(e.taskId).started = ts;
        break;
      case 'task-failed':
      case 'task-cancelled':
      case 'merge-finished':
        trace(e.taskId).ended = ts;
        break;
      case 'path-write':
        trace(e.taskId).writes.add(e.path.toLowerCase());
        break;
      case 'inbox-raised':
        if (e.item.kind === 'scope-escalation') {
          trace(e.item.taskId).escalations += 1;
          escalationItems.set(e.item.id, e.item.taskId);
          outcomes.unresolved += 1;
        }
        break;
      case 'inbox-resolved':
        if (escalationItems.has(e.itemId) && e.resolution.rkind === 'scope-escalation') {
          outcomes[e.resolution.action] += 1;
          outcomes.unresolved = Math.max(0, outcomes.unresolved - 1);
        }
        break;
      default:
        break;
    }
  }

  const started = [...traces.entries()].filter(([, t]) => t.started !== null);
  const strayTasks = started.filter(([, t]) => t.escalations > 0).map(([id]) => id);
  const totalEscalations = started.reduce((n, [, t]) => n + t.escalations, 0);

  // A task still live at report time occupies [started, now-ish]; use the last
  // event timestamp as its provisional end so live overlap still counts.
  const interval = (t: TaskTrace): [number, number] => [t.started as number, t.ended ?? lastTs];

  let concurrentPairs = 0;
  const collidingPairs: CollisionPair[] = [];
  for (let i = 0; i < started.length; i++) {
    for (let j = i + 1; j < started.length; j++) {
      const [idA, a] = started[i];
      const [idB, b] = started[j];
      const [a0, a1] = interval(a);
      const [b0, b1] = interval(b);
      if (a0 <= b1 && b0 <= a1) {
        concurrentPairs += 1;
        const paths = [...a.writes].filter((p) => b.writes.has(p)).sort();
        if (paths.length > 0) {
          collidingPairs.push({ a: idA, b: idB, paths });
        }
      }
    }
  }

  return {
    generatedAt,
    eventsAnalyzed: events.length,
    tasksAnalyzed: started.length,
    tasksWithWrites: started.filter(([, t]) => t.writes.size > 0).length,
    strayRate: started.length === 0 ? 0 : strayTasks.length / started.length,
    strayTasks,
    totalEscalations,
    escalationOutcomes: outcomes,
    concurrentPairs,
    collidingPairs,
    collisionRate: concurrentPairs === 0 ? 0 : collidingPairs.length / concurrentPairs,
  };
}

/** Render the report as the markdown document `argus.collisionReport` opens. */
export function renderCollisionReport(r: CollisionReport): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const lines = [
    '# Argus collision report',
    '',
    `Generated ${r.generatedAt} from ${r.eventsAnalyzed} events · ${r.tasksAnalyzed} started tasks (${r.tasksWithWrites} wrote files).`,
    '',
    '## Stray rate — how often agents leave their lane',
    '',
    `**${pct(r.strayRate)}** of started tasks attempted a write outside their declared scope (${r.strayTasks.length} of ${r.tasksAnalyzed}).`,
    r.strayTasks.length > 0 ? `Stray tasks: ${r.strayTasks.map((t) => `\`${t}\``).join(', ')}` : '',
    `Escalations: ${r.totalEscalations} total — ${r.escalationOutcomes['allow-once']} allowed once, ${r.escalationOutcomes['expand-scope']} expanded scope, ${r.escalationOutcomes.deny} denied, ${r.escalationOutcomes.unresolved} unresolved.`,
    '',
    '## Collision rate — the number that gates the v2.3 scheduler',
    '',
    `**${pct(r.collisionRate)}** of concurrently-running task pairs had intersecting write sets (${r.collidingPairs.length} of ${r.concurrentPairs} pairs).`,
    '',
    ...(r.collidingPairs.length > 0
      ? r.collidingPairs.map((p) => `- \`${p.a}\` × \`${p.b}\`: ${p.paths.map((x) => `\`${x}\``).join(', ')}`)
      : ['No colliding pairs observed. If this stays true over a week of real use, do not build the scheduler — write that decision into SPEC.md and close the idea (§7).']),
    '',
  ];
  return lines.filter((l) => l !== '').join('\n') + '\n';
}
