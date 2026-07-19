import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collisionReport, renderCollisionReport } from '../src/core/collision';
import { ArgusEvent, ArgusEventBody, ScopeEscalationItem, TaskSpec } from '../src/core/types';

function spec(id: string): TaskSpec {
  return {
    id,
    title: id,
    prompt: 'p',
    scope: { include: ['src/**'] },
    model: 'claude-opus-4-8',
    effort: 'high',
    gates: [],
    budgetUsd: null,
    autoMerge: false,
  };
}

function escalation(id: string, taskId: string, raisedAt: string): ScopeEscalationItem {
  return {
    id,
    taskId,
    raisedAt,
    resolvedAt: null,
    kind: 'scope-escalation',
    tool: 'Edit',
    path: 'lib/shared.ts',
    overlappingTasks: [],
    resolution: null,
  };
}

/** Stamp bodies with seq and explicit timestamps. */
function stamp(entries: Array<[string, ArgusEventBody]>): ArgusEvent[] {
  return entries.map(([ts, body], i) => ({ seq: i + 1, ts, ...body }));
}

const T = (min: number, sec = 0): string =>
  new Date(Date.UTC(2026, 6, 18, 3, min, sec)).toISOString();

test('empty stream → zero rates, no division by zero', () => {
  const r = collisionReport([], T(0));
  assert.equal(r.tasksAnalyzed, 0);
  assert.equal(r.strayRate, 0);
  assert.equal(r.collisionRate, 0);
  assert.equal(r.concurrentPairs, 0);
});

test('two concurrent tasks with intersecting writes collide; disjoint pair does not', () => {
  const events = stamp([
    [T(0), { type: 'task-created', spec: spec('a') }],
    [T(0), { type: 'task-started', taskId: 'a', worktreePath: '/w/a', branch: 'argus/a' }],
    [T(1), { type: 'task-created', spec: spec('b') }],
    [T(1), { type: 'task-started', taskId: 'b', worktreePath: '/w/b', branch: 'argus/b' }],
    [T(2), { type: 'path-write', taskId: 'a', path: 'src/Shared/util.ts', tool: 'Edit' }],
    [T(3), { type: 'path-write', taskId: 'b', path: 'src/shared/UTIL.ts', tool: 'Write' }],
    [T(3), { type: 'path-write', taskId: 'b', path: 'src/b-only.ts', tool: 'Write' }],
    [T(4), { type: 'task-failed', taskId: 'a', reason: 'x' }],
    [T(5), { type: 'task-failed', taskId: 'b', reason: 'x' }],
    // c runs strictly after both — concurrent with neither.
    [T(10), { type: 'task-created', spec: spec('c') }],
    [T(10), { type: 'task-started', taskId: 'c', worktreePath: '/w/c', branch: 'argus/c' }],
    [T(11), { type: 'path-write', taskId: 'c', path: 'src/shared/util.ts', tool: 'Edit' }],
    [T(12), { type: 'task-cancelled', taskId: 'c', reason: null }],
  ]);
  const r = collisionReport(events, T(20));
  assert.equal(r.tasksAnalyzed, 3);
  assert.equal(r.concurrentPairs, 1); // only a×b overlap in time
  assert.equal(r.collidingPairs.length, 1);
  // Case-insensitive path intersection (Windows-first).
  assert.deepEqual(r.collidingPairs[0], { a: 'a', b: 'b', paths: ['src/shared/util.ts'] });
  assert.equal(r.collisionRate, 1);
  assert.equal(r.strayRate, 0);
});

test('a still-live task counts as concurrent up to the last event timestamp', () => {
  const events = stamp([
    [T(0), { type: 'task-started', taskId: 'a', worktreePath: '/w/a', branch: 'argus/a' }],
    [T(1), { type: 'path-write', taskId: 'a', path: 'src/x.ts', tool: 'Edit' }],
    // b starts later and never ends; a never ends either.
    [T(2), { type: 'task-started', taskId: 'b', worktreePath: '/w/b', branch: 'argus/b' }],
    [T(3), { type: 'path-write', taskId: 'b', path: 'src/x.ts', tool: 'Edit' }],
  ]);
  const r = collisionReport(events, T(9));
  assert.equal(r.concurrentPairs, 1);
  assert.equal(r.collidingPairs.length, 1);
});

test('stray rate counts tasks with escalations; outcomes tally by resolution', () => {
  const events = stamp([
    [T(0), { type: 'task-started', taskId: 'a', worktreePath: '/w/a', branch: 'argus/a' }],
    [T(0), { type: 'task-started', taskId: 'b', worktreePath: '/w/b', branch: 'argus/b' }],
    [T(1), { type: 'inbox-raised', item: escalation('a#1', 'a', T(1)) }],
    [T(2), { type: 'inbox-resolved', itemId: 'a#1', resolution: { rkind: 'scope-escalation', action: 'expand-scope', glob: 'lib/**' } }],
    [T(3), { type: 'inbox-raised', item: escalation('a#2', 'a', T(3)) }],
  ]);
  const r = collisionReport(events, T(9));
  assert.equal(r.strayRate, 0.5); // a strayed, b did not
  assert.deepEqual(r.strayTasks, ['a']);
  assert.equal(r.totalEscalations, 2);
  assert.equal(r.escalationOutcomes['expand-scope'], 1);
  assert.equal(r.escalationOutcomes.unresolved, 1);
});

test('renderCollisionReport produces markdown with both headline rates', () => {
  const md = renderCollisionReport(collisionReport([], T(0)));
  assert.match(md, /# Argus collision report/);
  assert.match(md, /Stray rate/);
  assert.match(md, /Collision rate/);
  assert.match(md, /do not build the scheduler/);
});
