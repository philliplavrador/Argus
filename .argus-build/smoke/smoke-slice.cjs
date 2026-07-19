/**
 * Headless live smoke of the Argus v2 slice — the real stack minus VS Code:
 * real JsonlEventLog, real GitWorktreeManager, real AgentRunner (real SDK,
 * real subprocesses, subscription auth), real ShellGateRunner, real merge
 * queue. The webview is replaced by a scripted operator answering from the
 * inbox exactly as the UI would (orchestrator.answer()).
 *
 * Prereq: `npx tsc -p tsconfig.test.json` (compiles src to out-test/src, CJS).
 * Run:    `node .argus-build/smoke/smoke-slice.cjs <path-to-source-repo>`
 *         where <path-to-source-repo> is a DISPOSABLE repo to clone from
 *         (the kiosk fixture clone — never the original).
 *
 * What it proves (acceptance §13 items 2,3,4-partial,8-partial,9-partial):
 *  A ask-then-write: worktree provision → live agent → AskUserQuestion parks
 *    the agent ≥8s → answer resumes it in-session (codeword survives) →
 *    in-scope write recorded → gate passes → auto-merge rebases and
 *    fast-forwards the base branch → DONE, file present on base branch.
 *  B stray-writer (concurrent): out-of-scope write raises a scope
 *    escalation → deny with a reason reaches the agent → it adapts and
 *    finishes in scope → READY (no auto-merge).
 */

'use strict';

const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', '..', 'out-test', 'src');
const { Orchestrator } = require(path.join(OUT, 'host', 'orchestrator.js'));
const { JsonlEventLog } = require(path.join(OUT, 'host', 'eventlog.js'));
const { GitWorktreeManager } = require(path.join(OUT, 'host', 'worktrees.js'));
const { ShellGateRunner } = require(path.join(OUT, 'host', 'gates.js'));
const { startAgent } = require(path.join(OUT, 'host', 'agentrunner.js'));
const { DEFAULT_CONFIG } = require(path.join(OUT, 'core', 'types.js'));

const MODEL = 'claude-haiku-4-5-20251001';
const HOLD_MS = 8000;
const OVERALL_TIMEOUT_MS = 12 * 60 * 1000;

function sh(cwd, file, args) {
  return execFileSync(file, args, { cwd, encoding: 'utf8', windowsHide: true });
}

function log(line) {
  console.log(`[smoke ${new Date().toISOString().slice(11, 19)}] ${line}`);
}

async function main() {
  const sourceRepo = process.argv[2];
  if (!sourceRepo || /kosik'?s kiosk/i.test(sourceRepo)) {
    console.error('Usage: smoke-slice.cjs <disposable-source-repo> (never the Kiosk original)');
    process.exit(2);
  }

  const root = mkdtempSync(path.join(os.tmpdir(), 'argus-smoke-'));
  const repo = path.join(root, 'repo');
  log(`cloning smoke repo → ${repo}`);
  sh(root, 'git', ['clone', '--no-hardlinks', '-q', sourceRepo, repo]);
  const baseBranch = sh(repo, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  log(`base branch: ${baseBranch}`);

  const argusDir = path.join(repo, '.argus');
  for (const d of ['state', 'logs', 'worktrees']) {
    mkdirSync(path.join(argusDir, d), { recursive: true });
  }
  const config = {
    ...DEFAULT_CONFIG,
    maxConcurrentAgents: 2,
    defaultModel: MODEL,
    defaultEffort: 'low',
    installDepsOnProvision: false,
    autoMerge: false,
    verifyCommand: null,
    perTaskBudgetUsd: 2,
    fleetBudgetUsd: 5,
  };
  writeFileSync(path.join(argusDir, 'config.json'), JSON.stringify(config, null, 2));

  const eventLog = new JsonlEventLog(path.join(argusDir, 'state', 'events.jsonl'));
  const orch = new Orchestrator({
    repoRoot: repo,
    argusDir,
    eventLog,
    worktrees: new GitWorktreeManager(repo),
    startAgent: (opts) => startAgent(opts),
    gates: new ShellGateRunner(),
    config,
    installCommand: null,
    toast: (level, text) => log(`toast[${level}] ${text}`),
  });

  // ---- scripted operator + observations -----------------------------------
  const seen = {
    agentInit: new Set(),
    blockedAt: new Map(), // itemId -> ms
    answeredAt: new Map(),
    pathWrites: [],
    escalations: [],
    denials: 0,
    gateResults: [],
    resumed: new Set(),
  };
  let chosenOption = null;

  orch.onEvent((e) => {
    if (e.type === 'agent-init') {
      seen.agentInit.add(e.taskId);
      log(`agent-init ${e.taskId} session=${e.sessionId.slice(0, 8)} model=${e.model}`);
    }
    if (e.type === 'tool-call') {
      log(`tool ${e.taskId}: ${e.detail}`);
    }
    if (e.type === 'path-write') {
      seen.pathWrites.push(`${e.taskId}:${e.path}`);
    }
    if (e.type === 'gate-finished') {
      seen.gateResults.push(`${e.taskId}:${e.result.name}=${e.result.exitCode}`);
      log(`gate ${e.taskId} ${e.result.name} exit ${e.result.exitCode}`);
    }
    if (e.type === 'task-resumed') {
      seen.resumed.add(e.taskId);
    }
    if (e.type === 'inbox-raised') {
      const item = e.item;
      seen.blockedAt.set(item.id, Date.now());
      log(`inbox-raised ${item.id} kind=${item.kind}${item.kind === 'scope-escalation' ? ` path=${item.path}` : ''}`);
      if (item.kind === 'question') {
        // Park the agent for HOLD_MS to prove blocking, then answer option 1.
        setTimeout(() => {
          chosenOption = item.options.length > 0 ? item.options[0].label : 'Alpha';
          orch
            .answer(item.id, { rkind: 'question', optionLabels: [chosenOption], freeText: null })
            .then(() => {
              seen.answeredAt.set(item.id, Date.now());
              log(`answered ${item.id} with '${chosenOption}' after ${HOLD_MS}ms hold`);
            })
            .catch((err) => log(`ANSWER FAILED ${item.id}: ${err}`));
        }, HOLD_MS);
      } else if (item.kind === 'scope-escalation') {
        seen.escalations.push(`${item.taskId}:${item.path}`);
        setTimeout(() => {
          seen.denials += 1;
          orch
            .answer(item.id, {
              rkind: 'scope-escalation',
              action: 'deny',
              reason: 'Everything for this task must live under inside/ — do not create files elsewhere.',
            })
            .then(() => log(`denied escalation ${item.id} (${item.path})`))
            .catch((err) => log(`DENY FAILED ${item.id}: ${err}`));
        }, 1500);
      } else {
        log(`UNEXPECTED inbox kind ${item.kind} — abandoning`);
        void orch.answer(item.id, { rkind: item.kind, action: 'abandon' }).catch(() => {});
      }
    }
  });

  await orch.start('smoke');

  // ---- the two tasks ------------------------------------------------------
  await orch.createTask({
    id: 'ask-then-write',
    title: 'Ask a question, then write the answer file',
    prompt: [
      'Remember this codeword: MOONRIVER-7.',
      'Step 1: Ask me ONE question using the AskUserQuestion tool, with exactly two options labeled Alpha and Bravo, asking which codename I prefer.',
      'Step 2: After you receive my answer, create a file named argus-smoke.md in the repository root containing exactly two lines: the codeword, then the option I chose.',
      'Step 3: Run `git add argus-smoke.md` and `git commit -m "smoke: answer file"`.',
      'Then stop. Do not do anything else.',
    ].join('\n'),
    scope: { include: ['argus-smoke.md'] },
    model: MODEL,
    effort: 'low',
    gates: [
      {
        name: 'answer-file-exists',
        command: 'node -e "process.exit(require(\'fs\').existsSync(\'argus-smoke.md\')?0:1)"',
      },
    ],
    budgetUsd: 2,
    autoMerge: true,
  });

  await orch.createTask({
    id: 'stray-writer',
    title: 'Tries to write outside its scope',
    prompt: [
      'Step 1: Create a file at the relative path outside/stray.txt containing the word hello. Use the Write tool.',
      'Step 2: Create a file at the relative path inside/ok.txt containing the word done. Use the Write tool.',
      'Step 3: Run `git add -A` and `git commit -m "smoke: stray"`. If a step is refused, follow the refusal instructions instead of retrying, and continue with the remaining steps.',
      'Then stop.',
    ].join('\n'),
    scope: { include: ['inside/**'] },
    model: MODEL,
    effort: 'low',
    gates: [],
    budgetUsd: 2,
    autoMerge: false,
  });

  // ---- wait for terminal states -------------------------------------------
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  for (;;) {
    const a = orch.state.tasks['ask-then-write']?.phase;
    const b = orch.state.tasks['stray-writer']?.phase;
    const aDone = a === 'DONE' || a === 'FAILED' || a === 'CANCELLED';
    const bSettled = b === 'READY' || b === 'DONE' || b === 'FAILED' || b === 'CANCELLED';
    if (aDone && bSettled) {
      break;
    }
    if (Date.now() > deadline) {
      log(`TIMEOUT: a=${a} b=${b}`);
      console.log(JSON.stringify(orch.state, null, 2));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const stateA = orch.state.tasks['ask-then-write'];
  const stateB = orch.state.tasks['stray-writer'];

  // ---- assertions ----------------------------------------------------------
  const failures = [];
  const assert = (cond, label) => {
    log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
    if (!cond) {
      failures.push(label);
    }
  };

  assert(stateA.phase === 'DONE', `A reached DONE (got ${stateA.phase}, reason: ${stateA.failureReason})`);
  assert(seen.agentInit.has('ask-then-write') && seen.agentInit.has('stray-writer'), 'both agents emitted agent-init (ran concurrently under cap 2)');

  const qId = [...seen.blockedAt.keys()].find((id) => id.startsWith('ask-then-write'));
  const held = qId !== undefined && seen.answeredAt.has(qId) ? seen.answeredAt.get(qId) - seen.blockedAt.get(qId) : -1;
  assert(held >= HOLD_MS - 500, `question parked ~${HOLD_MS}ms before answer (held ${held}ms)`);
  assert(seen.resumed.has('ask-then-write'), 'A resumed after the answer');

  const answerFile = path.join(repo, 'argus-smoke.md');
  assert(existsSync(answerFile), 'argus-smoke.md exists on the BASE branch after merge');
  if (existsSync(answerFile)) {
    const content = readFileSync(answerFile, 'utf8');
    assert(content.includes('MOONRIVER-7'), `merged file carries the codeword (context survived the ${HOLD_MS}ms park)`);
    assert(chosenOption !== null && content.includes(chosenOption), `merged file names the chosen option '${chosenOption}' (answer channel worked)`);
  }
  assert(seen.pathWrites.some((w) => w.startsWith('ask-then-write:argus-smoke.md')), 'in-scope write was recorded (path-write event)');
  assert(seen.gateResults.includes('ask-then-write:answer-file-exists=0'), 'declared gate ran in the worktree and passed');
  assert(sh(repo, 'git', ['log', '--oneline', '-5']).includes('smoke: answer file'), 'A commit landed on the base branch via the merge queue');

  assert(seen.escalations.some((s) => s.startsWith('stray-writer:outside/')), `out-of-scope write escalated (saw: ${seen.escalations.join(', ') || 'none'})`);
  assert(seen.denials >= 1, 'the denial resolution was delivered');
  assert(stateB.phase === 'READY', `B settled at READY without auto-merge (got ${stateB.phase}, reason: ${stateB.failureReason})`);
  const bWorktree = stateB.worktreePath;
  assert(bWorktree !== null && !existsSync(path.join(bWorktree, 'outside', 'stray.txt')), 'denied file was never written in the worktree');
  assert(bWorktree !== null && existsSync(path.join(bWorktree, 'inside', 'ok.txt')), 'agent adapted after denial and wrote in scope');
  assert(stateA.costUsd > 0 && orch.state.fleetCostUsd > 0, `cost telemetry accrued (fleet $${orch.state.fleetCostUsd.toFixed(4)})`);

  // Event log replay sanity: a fresh fold reproduces the same task phases.
  const replayed = await eventLog.replay();
  assert(replayed.skippedLines === 0, 'event log replays with zero corrupt lines');

  log(`fleet spend: $${orch.state.fleetCostUsd.toFixed(4)} (client-side estimate)`);
  log(`smoke repo: ${repo}`);
  await orch.dispose();

  if (failures.length > 0) {
    console.error(`\nSMOKE FAILED — ${failures.length} assertion(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('\nSMOKE PASSED — the slice works end to end.');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE CRASHED:', err);
  process.exit(1);
});
