# Argus v2 — overnight build report

Good morning. The build is done, and it went unusually well: **v2.0 shipped
complete, verified end to end with real agents, and packaged**, in roughly two
hours of wall-clock instead of twelve. Nothing was rushed to get there — the
work simply went cleanly, and per the plan's own rule I stopped when the state
was coherent rather than inventing work to fill the window. Everything below
is on the `v2` branch, pushed. `main` was never touched. Your Kiosk repo was
never touched (verification pasted verbatim at the bottom).

The one-paragraph version: all four spikes passed and their findings are
encoded in the code; the full slice — create a task, get a worktree, run a
real agent, watch it stream, have it ask a question, see the ★, answer from
the inbox, watch it resume with context intact, pass its gate, and merge
through the serialized queue onto your branch — **ran live against real
Claude agents and passed 17 of 17 assertions**. A second live test drove a
real merge conflict through both back-off and abandon without ever silently
merging. The UI was exercised and screenshotted in Chromium. A real
downloaded VS Code activated the extension and passed 14 of 14 integration
checks. The `.vsix` is in the repo root, packaged and install-verified in a
sandboxed VS Code (not yours, per your instruction). 243 unit tests are
green.

---

## What works — with the command to see each thing

Run these from `d:\Projects\Argus` (the smokes each need
`npx tsc -p tsconfig.test.json` run once first, and a disposable repo path —
use a fresh clone of anything; never the Kiosk original):

| What | How to see it |
|---|---|
| The whole slice, live: question → ★ → answer → resume-with-context → gate → merge | `node .argus-build/smoke/smoke-slice.cjs <disposable-repo>` — spawns two real Haiku agents (~$0.08 usage) |
| Merge conflicts surface, back off, abandon — never silently merge | `node .argus-build/smoke/smoke-conflict.cjs <disposable-repo>` |
| Three real agents running simultaneously, each isolated in its own worktree | `node .argus-build/smoke/smoke-three.cjs <disposable-repo>` |
| Real VS Code: activation, init, panel, collision report | `node .argus-build/integration/run.cjs` (uses the VS Code cached in `.vscode-test/`) |
| The full unit suite (reducer, scope, guard, profile, eventlog, worktrees against real git, agentrunner, orchestrator) | `npm test` — 243 tests |
| The UI, without launching anything | open `.argus-build/screenshots/` — all four tabs, dark + light, against realistic state |
| The UI, interactively in a browser | `node .argus-build/smoke/ui/serve.cjs` then open `http://127.0.0.1:8793/.argus-build/smoke/ui/harness.html` |
| The real thing | press F5, or install `argus-2.0.0.vsix` (your call, deliberately not done for you) — open a git repo, click the eye, create a task |
| The §7 measurement | command palette → **Argus: Collision Report** (verified against a real session log) |

## What the night actually built

- **Contracts first** (`src/core/types.ts`): the event union, `FleetState` as a
  pure fold, four inbox item kinds with typed resolutions, the webview
  protocol. Everything downstream was fanned out against this file frozen.
- **Pure core**: event reducer (crash-restart semantics included), a
  fail-closed glob/scope engine, repo-profile detector, ScopeGuard's verdict
  logic, prompt assembly, the collision-report metrics — all dependency-free
  and exhaustively tested.
- **The shell**: `AgentRunner` (the blocking-inbox mechanism Spike B proved,
  encoded exactly — no bare `allowedTools`, answers via `updatedInput` keyed
  by question text, steers parked at turn boundaries), `WorktreeManager`
  (Spike C's Windows guardrails: `core.longpaths`, kill-then-force removal
  with orphan verification), crash-tolerant `EventLog`, the orchestrator
  (scheduler, held-promise inbox, gates, serialized merge queue, budgets,
  replay recovery).
- **The UI**: one webview, four tabs, plain TypeScript over the same reducer,
  batched postMessage per Spike D (50ms), the full §10.1 Claude visual
  language in both modes with a high-contrast fallback. The ★ is the one loud
  pixel; progress is honest or absent; the inbox is keyboard-first with
  live parked clocks.
- **Docs**: SPEC.md is now the v2 architecture contract; README leads with
  the big-repo framing and has an honesty section about what closing things
  does and what Bash can bypass.

## Bugs the verification caught (the night's best argument for itself)

1. **A real scheduler race** — the very first live smoke run caught `pump()`
   double-scheduling a task (the event making it ineligible folds
   asynchronously); the duplicate worktree provision then failed the task
   while its real agent was still running. Fixed with a synchronous
   reservation; pinned by `test/orchestrator.test.ts`. Unit tests alone had
   missed it; the live smoke found it in its first minute.
2. **A packaging-fatal load error** — the bundled Agent SDK reads
   `import.meta.url`, which esbuild's CJS output turns into `undefined`;
   `createRequire(undefined)` threw the moment real VS Code loaded the
   extension. Every earlier layer (typecheck, tests, bundling) was green.
   Only launching actual VS Code exposed it. Fixed with a define+inject shim.
3. **A live scope catch beyond the script**: during the smoke, one agent
   attempted to write its output file by absolute path into the *primary
   checkout* rather than its worktree. ScopeGuard escalated it, the denial
   reached the agent, and it corrected itself — exactly the accident class
   Argus exists to stop, occurring unprompted on night one.

<!-- ADVERSARIAL_RESULTS -->

## What the spikes found (full reports in `.argus-spikes/`)

- **A — concurrency**: 2/4/8 concurrent spawns all clean, zero 429s; default
  cap 4, max 8; ~150MB RAM per agent budgeted. Surprise: cross-subprocess
  prompt caching makes warm spawns ~15× cheaper (~$0.003) than the plan's
  $0.32 fear — same-prompt fan-out is cheap.
- **B — the blocking inbox**: `canUseTool` parked a real agent 180.0 seconds;
  context survived; the answer channel is `updatedInput.answers` keyed by
  question text. Surprise: bare `allowedTools` entries shadow the callback —
  the plan's own boilerplate would have broken the inbox. Argus sets none.
- **C — worktrees on Windows**: `core.longpaths` is off machine-wide and
  breaks add/status/removal silently past 260 chars — Argus sets it
  per-repo at provisioning. Removal while a process is alive orphans a
  locked directory *deregistered from git* — hence the kill-first ordering
  contract. Surprise: the plan's serialize-worktree-ops assumption was
  refuted (44 concurrent adds, zero lock errors). Per-worktree `npm install`
  on a warm cache is 6.6s — cheaper than copying; junction-sharing is
  confirmed unsafe (write-back through the junction is real). v2.2 live
  preview is affordable.
- **D — UI throughput**: the renderer never buckled — 60fps at 20,000
  events/sec unbatched. Batching exists for extension-host↔webview IPC
  economy, not FPS: 50ms flush, 100-line tails.

## Decisions (full log in `.argus-build/decisions.md`, D1–D14)

Worth your attention in the morning:

- **D5/D11 — honesty over cleverness on crashes**: a restart marks
  previously-live tasks FAILED (worktrees preserved, offered for cleanup)
  rather than attempting resumption; there is deliberately no
  `stopAgentsOnWindowClose` setting because agents are child processes and
  such a setting would be a fake promise. **Flagged for revisit**: session
  ids are recorded, so "resume interrupted task" is buildable in v2.x.
- **D12 — fleet agents run with SDK setting isolation** (no user config, no
  project CLAUDE.md). Reproducible, but on repos where CLAUDE.md carries real
  context this may cost quality. **Flagged for revisit** after real use.
- **D14 — send-back and conflict-fix spawn fresh sessions** with the failure
  context in the prompt, rather than resuming the old session. Worked live;
  costs extra tokens. **Flagged for revisit** as v2.1 polish.
- D1–D4, D6–D10, D13: spike scoping, model ladder economics, glob subset,
  worktree queue, batching numbers, deps-on-provision, and the scheduler race
  — all recorded with reasoning; none need morning action.

## Honest gaps — what was NOT verified

- **A live window-kill mid-run**: crash replay semantics are unit-tested and
  the integration run observed a clean replay, but I never killed a real
  VS Code window with a live fleet.
- **Verbosity/effort behavioral deltas**: enforced-side pushback differences
  are unit-verified (risky Bash escalates under `balanced`, not under
  `autonomous`), and the Settings tab shows the exact prompt text — but I did
  not run A/B agent sessions to demonstrate output-length changes.
- **The webview inside VS Code was never visually inspected** — it is
  verified in Chromium (same engine, real bundle, screenshots committed) and
  the panel/CSP/load path is integration-verified, but no human eye has seen
  the tabs inside an actual VS Code window yet. First F5 is yours.
- **Scale**: everything ran against a 443-file fixture. That tests function,
  not the big-repo value proposition (orientation cost, unpredictable
  collisions). Do not conclude the product works at scale from tonight.
- The task composer's **steer/stop/diff buttons** were exercised through
  their intent plumbing and unit tests, not through a full live UI session.

## Usage and throttling

No throttling was ever observed — no 429s at any point, including the
8-concurrent spike batch. The model ladder never needed a step-down: Fable 5
wrote the contracts, orchestrator, and AgentRunner brief-work; Opus 4.8 ran
all fan-out implementation and review agents; Haiku 4.5 was every live test
agent. Total agent-side usage for the whole night's live testing was under
$0.25 in client-side cost estimates (subscription draw); the sub-agent
fleets consumed roughly 1.1M tokens across ~18 workers.

## The single next thing

**Press F5, open a real repo of yours, and run one real task through the
inbox with your own eyes.** Everything is verified except the part only you
can verify: whether it feels right. (If it does, the second thing is a week
of real use, then **Argus: Collision Report** — that number decides whether
the v2.3 scheduler ever gets built.)

---

## Kiosk read-only verification (verbatim, §0.4)

<!-- KIOSK_VERIFICATION -->
