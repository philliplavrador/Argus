/**
 * Live merge-conflict smoke: real git, real WorktreeManager and merge queue,
 * a scripted "agent" (no SDK spawn needed — the conflict is a git property).
 *
 * Sequence: base commits conflict.txt v1 → task worktree branches and edits
 * the same line → base moves to v2 behind the task's back → auto-merge rebase
 * conflicts → the merge-conflict inbox item surfaces with the file named →
 * operator answers 'open-editor' (task backs off to READY, merge slot freed)
 * → merge retried → conflicts again → 'abandon' → FAILED, and the base branch
 * is untouched. No silent bad merge anywhere.
 *
 * Prereq: npx tsc -p tsconfig.test.json
 * Run:    node .argus-build/smoke/smoke-conflict.cjs <disposable-source-repo>
 */

'use strict';

const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', '..', 'out-test', 'src');
const { Orchestrator } = require(path.join(OUT, 'host', 'orchestrator.js'));
const { JsonlEventLog } = require(path.join(OUT, 'host', 'eventlog.js'));
const { GitWorktreeManager } = require(path.join(OUT, 'host', 'worktrees.js'));
const { ShellGateRunner } = require(path.join(OUT, 'host', 'gates.js'));
const { DEFAULT_CONFIG } = require(path.join(OUT, 'core', 'types.js'));

const sh = (cwd, file, args) => execFileSync(file, args, { cwd, encoding: 'utf8', windowsHide: true });
const log = (line) => console.log(`[conflict ${new Date().toISOString().slice(11, 19)}] ${line}`);

async function main() {
  const sourceRepo = process.argv[2];
  if (!sourceRepo || /kosik'?s kiosk/i.test(sourceRepo)) {
    console.error('Usage: smoke-conflict.cjs <disposable-source-repo>');
    process.exit(2);
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'argus-conflict-'));
  const repo = path.join(root, 'repo');
  sh(root, 'git', ['clone', '--no-hardlinks', '-q', sourceRepo, repo]);

  writeFileSync(path.join(repo, 'conflict.txt'), 'base v1\n');
  sh(repo, 'git', ['add', 'conflict.txt']);
  sh(repo, 'git', ['commit', '-q', '-m', 'base: conflict.txt v1']);

  const argusDir = path.join(repo, '.argus');
  for (const d of ['state', 'logs', 'worktrees']) {
    mkdirSync(path.join(argusDir, d), { recursive: true });
  }

  /** Scripted agent: edits the same line the base is about to change. */
  const fakeStartAgent = (opts) => {
    const done = (async () => {
      writeFileSync(path.join(opts.worktreePath, 'conflict.txt'), 'task change\n');
      sh(opts.worktreePath, 'git', ['add', 'conflict.txt']);
      sh(opts.worktreePath, 'git', ['commit', '-q', '-m', 'task: conflict.txt edited']);
      // The base moves after the task branched — the classic rebase conflict.
      writeFileSync(path.join(repo, 'conflict.txt'), 'base v2\n');
      sh(repo, 'git', ['add', 'conflict.txt']);
      sh(repo, 'git', ['commit', '-q', '-m', 'base: conflict.txt v2']);
      opts.callbacks.emit({ type: 'path-write', taskId: opts.spec.id, path: 'conflict.txt', tool: 'Edit' });
      return { result: 'success', detail: 'edited and committed' };
    })();
    return {
      taskId: opts.spec.id,
      steer: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      done,
    };
  };

  const eventLog = new JsonlEventLog(path.join(argusDir, 'state', 'events.jsonl'));
  const orch = new Orchestrator({
    repoRoot: repo,
    argusDir,
    eventLog,
    worktrees: new GitWorktreeManager(repo),
    startAgent: fakeStartAgent,
    gates: new ShellGateRunner(),
    config: { ...DEFAULT_CONFIG, maxConcurrentAgents: 1, installDepsOnProvision: false, verifyCommand: null },
    installCommand: null,
    toast: (level, text) => log(`toast[${level}] ${text}`),
  });

  const conflicts = [];
  let firstAnswered = false;
  orch.onEvent((e) => {
    if (e.type === 'inbox-raised' && e.item.kind === 'merge-conflict') {
      conflicts.push(e.item);
      log(`merge-conflict raised: files=[${e.item.files.join(', ')}]`);
      const action = firstAnswered ? 'abandon' : 'open-editor';
      firstAnswered = true;
      setTimeout(() => {
        orch
          .answer(e.item.id, { rkind: 'merge-conflict', action })
          .then(() => log(`answered with ${action}`))
          .catch((err) => log(`ANSWER FAILED: ${err}`));
      }, 400);
    }
  });

  await orch.start('conflict-smoke');
  await orch.createTask({
    id: 'conflicter',
    title: 'Edits a line the base also edits',
    prompt: 'scripted',
    scope: { include: ['conflict.txt'] },
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    gates: [],
    budgetUsd: null,
    autoMerge: true,
  });

  // Wait for the first conflict → open-editor → READY.
  const deadline = Date.now() + 120000;
  while (!(conflicts.length >= 1 && orch.state.tasks['conflicter']?.phase === 'READY')) {
    if (Date.now() > deadline) {
      log(`TIMEOUT waiting for first back-off; phase=${orch.state.tasks['conflicter']?.phase}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  log('back-off verified: READY again with the merge slot free — retrying merge');
  orch.enqueueMerge('conflicter');

  while (orch.state.tasks['conflicter']?.phase !== 'FAILED') {
    if (Date.now() > deadline) {
      log(`TIMEOUT waiting for abandon; phase=${orch.state.tasks['conflicter']?.phase}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const failures = [];
  const assert = (cond, label) => {
    log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
    if (!cond) {
      failures.push(label);
    }
  };

  assert(conflicts.length === 2, `two conflict items raised across two merge attempts (got ${conflicts.length})`);
  assert(conflicts.every((c) => c.files.includes('conflict.txt')), 'the conflicting file is named in the item');
  assert(orch.state.merging === null, 'the fleet-wide merge slot is released');
  assert(readFileSync(path.join(repo, 'conflict.txt'), 'utf8').trim() === 'base v2', 'the base branch was never silently merged over');
  assert(!sh(repo, 'git', ['log', '--oneline', '-3']).includes('task:'), 'no task commit leaked onto the base branch');
  assert(orch.state.tasks['conflicter'].failureReason === 'merge conflict; abandoned', 'abandon recorded the honest reason');

  await orch.dispose();
  if (failures.length > 0) {
    console.error(`\nCONFLICT SMOKE FAILED — ${failures.length} assertion(s)`);
    process.exit(1);
  }
  console.log('\nCONFLICT SMOKE PASSED — conflicts surface, never silently merge.');
  process.exit(0);
}

main().catch((err) => {
  console.error('CONFLICT SMOKE CRASHED:', err);
  process.exit(1);
});
