/**
 * Three real agents at once (§13.2): trivial disjoint tasks, cap 3, all three
 * sessions must be alive simultaneously, all three must reach READY with
 * their files committed in their own worktrees.
 *
 * Prereq: npx tsc -p tsconfig.test.json
 * Run:    node .argus-build/smoke/smoke-three.cjs <disposable-source-repo>
 */

'use strict';

const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', '..', 'out-test', 'src');
const { Orchestrator } = require(path.join(OUT, 'host', 'orchestrator.js'));
const { JsonlEventLog } = require(path.join(OUT, 'host', 'eventlog.js'));
const { GitWorktreeManager } = require(path.join(OUT, 'host', 'worktrees.js'));
const { ShellGateRunner } = require(path.join(OUT, 'host', 'gates.js'));
const { startAgent } = require(path.join(OUT, 'host', 'agentrunner.js'));
const { DEFAULT_CONFIG } = require(path.join(OUT, 'core', 'types.js'));

const log = (l) => console.log(`[three ${new Date().toISOString().slice(11, 19)}] ${l}`);

async function main() {
  const sourceRepo = process.argv[2];
  if (!sourceRepo || /kosik'?s kiosk/i.test(sourceRepo)) {
    console.error('Usage: smoke-three.cjs <disposable-source-repo>');
    process.exit(2);
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'argus-three-'));
  const repo = path.join(root, 'repo');
  execFileSync('git', ['clone', '--no-hardlinks', '-q', sourceRepo, repo], { cwd: root, windowsHide: true });
  const argusDir = path.join(repo, '.argus');
  for (const d of ['state', 'logs', 'worktrees']) {
    mkdirSync(path.join(argusDir, d), { recursive: true });
  }

  const orch = new Orchestrator({
    repoRoot: repo,
    argusDir,
    eventLog: new JsonlEventLog(path.join(argusDir, 'state', 'events.jsonl')),
    worktrees: new GitWorktreeManager(repo),
    startAgent: (o) => startAgent(o),
    gates: new ShellGateRunner(),
    config: { ...DEFAULT_CONFIG, maxConcurrentAgents: 3, installDepsOnProvision: false, defaultModel: 'claude-haiku-4-5-20251001', verifyCommand: null, autoMerge: false },
    installCommand: null,
    toast: (level, text) => log(`toast[${level}] ${text}`),
  });

  const live = new Set();
  let peak = 0;
  orch.onEvent((e) => {
    if (e.type === 'agent-init') {
      live.add(e.taskId);
      peak = Math.max(peak, live.size);
      log(`agent-init ${e.taskId} (live now: ${live.size})`);
    }
    if (e.type === 'task-verifying' || e.type === 'task-failed' || e.type === 'task-cancelled') {
      live.delete(e.taskId);
    }
  });

  await orch.start('three-smoke');
  for (const n of ['one', 'two', 'three']) {
    await orch.createTask({
      id: `hello-${n}`,
      title: `Write hello-${n}`,
      prompt: `Create a file named hello-${n}.txt containing exactly the word ${n}. Run \`git add hello-${n}.txt\` and \`git commit -m "add hello-${n}"\`. Then stop. Do nothing else.`,
      scope: { include: [`hello-${n}.txt`] },
      model: 'claude-haiku-4-5-20251001',
      effort: 'low',
      gates: [],
      budgetUsd: 1,
      autoMerge: false,
    });
  }

  const deadline = Date.now() + 8 * 60 * 1000;
  for (;;) {
    const phases = ['one', 'two', 'three'].map((n) => orch.state.tasks[`hello-${n}`]?.phase);
    if (phases.every((p) => p === 'READY' || p === 'FAILED' || p === 'CANCELLED')) {
      break;
    }
    if (Date.now() > deadline) {
      log(`TIMEOUT: phases=${phases.join(',')}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const failures = [];
  const assert = (cond, label) => {
    log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
    if (!cond) {
      failures.push(label);
    }
  };
  assert(peak === 3, `all three agents were alive simultaneously (peak concurrent: ${peak})`);
  for (const n of ['one', 'two', 'three']) {
    const t = orch.state.tasks[`hello-${n}`];
    assert(t.phase === 'READY', `hello-${n} reached READY (got ${t.phase}${t.failureReason ? `: ${t.failureReason}` : ''})`);
    assert(t.worktreePath !== null && existsSync(path.join(t.worktreePath, `hello-${n}.txt`)), `hello-${n}.txt exists in its own worktree`);
  }
  assert(orch.state.fleetCostUsd > 0, `fleet spend accrued ($${orch.state.fleetCostUsd.toFixed(4)})`);

  await orch.dispose();
  if (failures.length > 0) {
    console.error(`\nTHREE-AGENT SMOKE FAILED — ${failures.length} assertion(s)`);
    process.exit(1);
  }
  console.log('\nTHREE-AGENT SMOKE PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('THREE-AGENT SMOKE CRASHED:', err);
  process.exit(1);
});
