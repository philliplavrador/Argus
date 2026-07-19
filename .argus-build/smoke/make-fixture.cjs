/**
 * Build a realistic FleetState fixture for the UI harness by folding a
 * scripted event stream through the REAL reducer (no hand-written state that
 * can drift from types). Timestamps are generated relative to now so parked
 * clocks and elapsed timers render realistically.
 *
 * Prereq: npx tsc -p tsconfig.test.json
 * Output: .argus-build/smoke/ui/fixture-state.json + fixture-history.json
 */

'use strict';

const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', '..', 'out-test', 'src');
const { foldEvents } = require(path.join(OUT, 'core', 'reducer.js'));
const { DEFAULT_CONFIG } = require(path.join(OUT, 'core', 'types.js'));

const now = Date.now();
const at = (minAgo, secOff = 0) => new Date(now - minAgo * 60000 + secOff * 1000).toISOString();

const spec = (id, title, scope, model = 'claude-opus-4-8') => ({
  id,
  title,
  prompt: `Work on: ${title}`,
  scope: { include: scope },
  model,
  effort: 'high',
  gates: [{ name: 'tests', command: 'npm test' }],
  budgetUsd: 10,
  autoMerge: false,
});

let seq = 0;
const ev = (ts, body) => ({ seq: ++seq, ts, ...body });

const events = [
  ev(at(32), { type: 'orchestrator-started', version: '2.0.0', config: { ...DEFAULT_CONFIG, maxConcurrentAgents: 4 } }),

  // ---- add-oauth: RUNNING with live tool tail and honest step progress ----
  ev(at(26), { type: 'task-created', spec: spec('add-oauth', 'Add OAuth login flow', ['src/auth/**', 'src/routes/auth*'] ) }),
  ev(at(26), { type: 'task-queued', taskId: 'add-oauth' }),
  ev(at(25), { type: 'task-started', taskId: 'add-oauth', worktreePath: 'C:/repo/.argus/worktrees/add-oauth', branch: 'argus/add-oauth' }),
  ev(at(25), { type: 'agent-init', taskId: 'add-oauth', sessionId: '4f9d2c11-77aa-4b02-9a41-3c5d8e2f1b6a', model: 'claude-opus-4-8' }),
  ev(at(24), { type: 'tool-call', taskId: 'add-oauth', tool: 'Read', detail: 'Read src/auth/session.ts', paths: ['src/auth/session.ts'] }),
  ev(at(24), { type: 'path-read', taskId: 'add-oauth', path: 'src/auth/session.ts' }),
  ev(at(20), { type: 'tool-call', taskId: 'add-oauth', tool: 'Edit', detail: 'Edit src/auth/oauth.ts', paths: ['src/auth/oauth.ts'] }),
  ev(at(20), { type: 'path-write', taskId: 'add-oauth', path: 'src/auth/oauth.ts', tool: 'Edit' }),
  ev(at(14), { type: 'tool-call', taskId: 'add-oauth', tool: 'Bash', detail: 'Bash: npm test -- --filter auth', paths: [] }),
  ev(at(9), { type: 'tool-call', taskId: 'add-oauth', tool: 'Edit', detail: 'Edit src/routes/auth-callback.ts', paths: ['src/routes/auth-callback.ts'] }),
  ev(at(9), { type: 'path-write', taskId: 'add-oauth', path: 'src/routes/auth-callback.ts', tool: 'Edit' }),
  ev(at(8), { type: 'progress', taskId: 'add-oauth', stepsDone: 3, stepsTotal: 5 }),
  ev(at(8), { type: 'usage', taskId: 'add-oauth', costUsdDelta: 1.84, tokensDelta: { input: 210000, output: 8200, cacheRead: 1400000, cacheWrite: 60000 } }),
  ev(at(1, 20), { type: 'tool-call', taskId: 'add-oauth', tool: 'Bash', detail: 'Bash: npx tsc --noEmit', paths: [] }),
  ev(at(0, -20), { type: 'agent-text', taskId: 'add-oauth', text: 'Callback route wired; adding the token refresh path next.' }),

  // ---- fix-billing: BLOCKED on a question, parked ~6 minutes --------------
  ev(at(23), { type: 'task-created', spec: spec('fix-billing', 'Fix billing rounding errors', ['src/billing/**']) }),
  ev(at(23), { type: 'task-queued', taskId: 'fix-billing' }),
  ev(at(22), { type: 'task-started', taskId: 'fix-billing', worktreePath: 'C:/repo/.argus/worktrees/fix-billing', branch: 'argus/fix-billing' }),
  ev(at(22), { type: 'agent-init', taskId: 'fix-billing', sessionId: '9b1e6a30-1234-4cde-8f00-aa55bb66cc77', model: 'claude-opus-4-8' }),
  ev(at(18), { type: 'tool-call', taskId: 'fix-billing', tool: 'Edit', detail: 'Edit src/billing/rounding.ts', paths: ['src/billing/rounding.ts'] }),
  ev(at(18), { type: 'path-write', taskId: 'fix-billing', path: 'src/billing/rounding.ts', tool: 'Edit' }),
  ev(at(8), { type: 'usage', taskId: 'fix-billing', costUsdDelta: 0.92, tokensDelta: { input: 90000, output: 4100, cacheRead: 800000, cacheWrite: 30000 } }),
  ev(at(6), {
    type: 'inbox-raised',
    item: {
      id: 'fix-billing#1',
      taskId: 'fix-billing',
      raisedAt: at(6),
      resolvedAt: null,
      kind: 'question',
      header: 'Rounding',
      question: 'Invoice line items currently round half-up per line. Should totals round per line or once on the invoice total?',
      options: [
        { label: 'Per line', description: 'Matches the printed line amounts exactly' },
        { label: 'On the total', description: 'Minimizes cumulative drift across many lines' },
        { label: 'Banker’s rounding', description: 'Round-half-even everywhere; least bias, differs from current output' },
      ],
      multiSelect: false,
      resolution: null,
    },
  }),
  ev(at(6), { type: 'task-blocked', taskId: 'fix-billing', itemId: 'fix-billing#1' }),

  // ---- refactor-utils: VERIFYING with a failed gate -----------------------
  ev(at(21), { type: 'task-created', spec: spec('refactor-utils', 'Split shared date utilities', ['src/lib/**'], 'claude-haiku-4-5-20251001') }),
  ev(at(21), { type: 'task-queued', taskId: 'refactor-utils' }),
  ev(at(20), { type: 'task-started', taskId: 'refactor-utils', worktreePath: 'C:/repo/.argus/worktrees/refactor-utils', branch: 'argus/refactor-utils' }),
  ev(at(20), { type: 'agent-init', taskId: 'refactor-utils', sessionId: 'c3a91f45-9999-4abc-b111-223344556677', model: 'claude-haiku-4-5-20251001' }),
  ev(at(16), { type: 'path-write', taskId: 'refactor-utils', path: 'src/lib/date.ts', tool: 'Edit' }),
  ev(at(12), {
    type: 'inbox-raised',
    item: {
      id: 'refactor-utils#1',
      taskId: 'refactor-utils',
      raisedAt: at(12),
      resolvedAt: null,
      kind: 'scope-escalation',
      tool: 'Edit',
      path: 'src/billing/invoice.ts',
      overlappingTasks: ['fix-billing'],
      resolution: null,
    },
  }),
  ev(at(12), { type: 'task-blocked', taskId: 'refactor-utils', itemId: 'refactor-utils#1' }),
  ev(at(11), {
    type: 'inbox-resolved',
    itemId: 'refactor-utils#1',
    resolution: { rkind: 'scope-escalation', action: 'deny', reason: 'fix-billing owns that file tonight; work around it' },
  }),
  ev(at(11), { type: 'task-resumed', taskId: 'refactor-utils' }),
  ev(at(5), { type: 'task-verifying', taskId: 'refactor-utils' }),
  ev(at(3), {
    type: 'gate-finished',
    taskId: 'refactor-utils',
    result: { name: 'tests', command: 'npm test', exitCode: 1, outputTail: 'FAIL test/date.test.ts\n  ✕ parses ISO week dates (12ms)\n\n  ● parses ISO week dates\n    expected 2026-W03 to be week 3, got week 2\n\nTests: 1 failed, 41 passed', durationMs: 41800, finishedAt: at(3) },
  }),
  ev(at(3), {
    type: 'inbox-raised',
    item: {
      id: 'refactor-utils#2',
      taskId: 'refactor-utils',
      raisedAt: at(3),
      resolvedAt: null,
      kind: 'verify-failure',
      gate: { name: 'tests', command: 'npm test', exitCode: 1, outputTail: 'FAIL test/date.test.ts\n  ✕ parses ISO week dates (12ms)\n\n  ● parses ISO week dates\n    expected 2026-W03 to be week 3, got week 2\n\nTests: 1 failed, 41 passed', durationMs: 41800, finishedAt: at(3) },
      resolution: null,
    },
  }),
  ev(at(3), { type: 'task-blocked', taskId: 'refactor-utils', itemId: 'refactor-utils#2' }),
  ev(at(3), { type: 'usage', taskId: 'refactor-utils', costUsdDelta: 0.31, tokensDelta: { input: 60000, output: 2500, cacheRead: 300000, cacheWrite: 12000 } }),

  // ---- ship-darkmode: DONE (merged 10 minutes ago) ------------------------
  ev(at(31), { type: 'task-created', spec: spec('ship-darkmode', 'Ship dark mode toggle', ['src/theme/**']) }),
  ev(at(31), { type: 'task-queued', taskId: 'ship-darkmode' }),
  ev(at(30), { type: 'task-started', taskId: 'ship-darkmode', worktreePath: 'C:/repo/.argus/worktrees/ship-darkmode', branch: 'argus/ship-darkmode' }),
  ev(at(30), { type: 'agent-init', taskId: 'ship-darkmode', sessionId: 'aa00bb11-2222-4333-8444-556677889900', model: 'claude-opus-4-8' }),
  ev(at(25), { type: 'path-write', taskId: 'ship-darkmode', path: 'src/theme/tokens.ts', tool: 'Edit' }),
  ev(at(15), { type: 'task-verifying', taskId: 'ship-darkmode' }),
  ev(at(13), { type: 'gate-finished', taskId: 'ship-darkmode', result: { name: 'tests', command: 'npm test', exitCode: 0, outputTail: 'Tests: 42 passed', durationMs: 39000, finishedAt: at(13) } }),
  ev(at(13), { type: 'task-ready', taskId: 'ship-darkmode' }),
  ev(at(11), { type: 'merge-started', taskId: 'ship-darkmode' }),
  ev(at(10), { type: 'merge-finished', taskId: 'ship-darkmode', mergeCommit: 'f3c2b1a0d9e8f7c6b5a4930211fedcba98765432' }),
  ev(at(10), { type: 'usage', taskId: 'ship-darkmode', costUsdDelta: 2.4, tokensDelta: { input: 300000, output: 12000, cacheRead: 2100000, cacheWrite: 90000 } }),
];

const state = foldEvents(events, { ...DEFAULT_CONFIG, maxConcurrentAgents: 4 });
const dir = path.join(__dirname, 'ui');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'fixture-state.json'), JSON.stringify(state, null, 2));
writeFileSync(path.join(dir, 'fixture-history.json'), JSON.stringify(events, null, 2));
console.log(`fixture written: ${events.length} events → ${dir}`);
console.log(`pending inbox: ${state.inbox.filter((i) => i.resolvedAt === null).length} · tasks: ${state.taskOrder.join(', ')}`);
