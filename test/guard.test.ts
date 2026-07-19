import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkToolCall, isRiskyBashCommand } from '../src/core/guard';
import { Scope } from '../src/core/types';

const SCOPE: Scope = { include: ['src/**', 'argus-smoke.md'] };
const WT = 'C:/repo/.argus/worktrees/task-a';

test('in-scope relative and absolute writes are recorded with repo-relative paths', () => {
  const rel = checkToolCall(SCOPE, 'balanced', WT, 'Edit', { file_path: 'src/lib/date.ts' });
  assert.deepEqual(rel, { kind: 'record-write', path: 'src/lib/date.ts', tool: 'Edit' });
  const abs = checkToolCall(SCOPE, 'balanced', WT, 'Write', { file_path: `${WT}/src/x.ts` });
  assert.deepEqual(abs, { kind: 'record-write', path: 'src/x.ts', tool: 'Write' });
});

test('out-of-scope writes escalate', () => {
  const v = checkToolCall(SCOPE, 'balanced', WT, 'Edit', { file_path: 'lib/other.ts' });
  assert.equal(v.kind, 'escalate');
});

test('SECURITY (review C6): ../-escaping relative paths escalate instead of clamping back in scope', () => {
  // Without the join-then-contain fix, '../../../repo/src/evil.ts' clamps to a
  // path that matches 'src/**' and is silently ALLOWED.
  for (const p of [
    '../../../src/evil.ts',
    '..\\..\\..\\src\\evil.ts',
    'src/../../escape/src/evil.ts',
    '../sibling-task/src/x.ts',
  ]) {
    const v = checkToolCall(SCOPE, 'balanced', WT, 'Edit', { file_path: p });
    assert.equal(v.kind, 'escalate', `expected escalate for ${p}, got ${v.kind}`);
  }
  // Interior dots that do NOT escape still resolve and pass.
  const ok = checkToolCall(SCOPE, 'balanced', WT, 'Edit', { file_path: 'src/lib/../date.ts' });
  assert.deepEqual(ok, { kind: 'record-write', path: 'src/date.ts', tool: 'Edit' });
});

test('absolute writes outside the worktree escalate (the primary-checkout case from the live smoke)', () => {
  const v = checkToolCall(SCOPE, 'balanced', WT, 'Write', { file_path: 'C:/repo/argus-smoke.md' });
  assert.equal(v.kind, 'escalate');
});

test('unparseable write input fails closed', () => {
  const v = checkToolCall(SCOPE, 'balanced', WT, 'Write', { nonsense: true });
  assert.equal(v.kind, 'escalate');
});

test('risky Bash escalates under balanced, passes under autonomous; plain Bash always passes', () => {
  const risky = { command: 'git push --force origin main' };
  assert.equal(checkToolCall(SCOPE, 'balanced', WT, 'Bash', risky).kind, 'escalate');
  assert.equal(checkToolCall(SCOPE, 'autonomous', WT, 'Bash', risky).kind, 'allow');
  assert.equal(checkToolCall(SCOPE, 'consult', WT, 'Bash', { command: 'npm test' }).kind, 'allow');
});

test('risky pattern table matches the documented shapes', () => {
  for (const cmd of ['rm -rf node_modules', 'git checkout main', 'git reset --hard HEAD~1', 'npm publish', 'Remove-Item -Recurse -Force x']) {
    assert.equal(isRiskyBashCommand(cmd), true, cmd);
  }
  for (const cmd of ['git add -A', 'git commit -m "x"', 'npm install', 'rm notes.txt']) {
    assert.equal(isRiskyBashCommand(cmd), false, cmd);
  }
});

test('Read paths inside the worktree are recorded; outside are allowed silently', () => {
  const inside = checkToolCall(SCOPE, 'balanced', WT, 'Read', { file_path: 'docs/readme.md' });
  assert.deepEqual(inside, { kind: 'record-read', path: 'docs/readme.md' });
  const outside = checkToolCall(SCOPE, 'balanced', WT, 'Read', { file_path: 'C:/elsewhere/x.md' });
  assert.deepEqual(outside, { kind: 'allow' });
});
