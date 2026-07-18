# PLAN.md — Build Argus v2

**This file is a prompt.** You are the Claude Code session that builds Argus v2.
Read it fully before touching anything. Delete this file in your final commit
(see §11).

Repo: https://github.com/philliplavrador/Argus · Platform: Windows 11, PowerShell
primary · Author: Phillip Lavrador

---

## 1. The one sentence that governs every decision

> **Argus exists so that a human can run many Claude Code agents against one
> repository at the same time without those agents corrupting each other's work,
> and answer all of their questions from one place.**

If a feature does not serve *contention management* or *the single human inbox*,
it is out of scope. A prettier way to launch one agent is not Argus — the Claude
Code extension already exists and is better at it. **Argus's product is the
scheduler, not the chat window.**

Every time you are about to add something, ask: *does this stop two agents from
getting in each other's way, or does it get a decision out of the human's head
and into the fleet faster?* If neither — cut it.

---

## 2. What exists today, and what happens to it

v0.1 is a **passive viewer**. Agents write `STATUS.json` and
`workflow/queue/*.md`; the extension renders them and writes checkbox answers
back. `SPEC.md` documents that file contract.

The file-shuffling protocol is **being deleted**, because Argus now *owns* the
agent processes and can hold their state in memory and talk to them directly.
Polling a markdown file for `[x]` was a workaround for not controlling the
process. You control the process now.

| Path | Fate |
|---|---|
| `src/lib/status.ts`, `src/lib/question.ts`, `src/model.ts` | **Delete.** The file contract they parse is gone. |
| `src/tree.ts`, `src/panel.ts` | **Delete.** Replaced by the webview UI. |
| `src/statusbar.ts` | **Keep the idea, rewrite.** Status bar now reads live orchestrator state. |
| `src/lib/render.ts` | Read it before deleting — if the unicode progress-bar renderer is good, port it to the webview. |
| `SPEC.md` | **Rewrite completely** as the v2 architecture doc. Do not preserve `spec: 1`. |
| `README.md` | Rewrite for v2. |
| `argus-0.1.0.vsix` | Delete from git; add `*.vsix` to `.gitignore`. |
| `test/*.test.ts`, `esbuild.mjs`, `tsconfig*.json`, `.vscode/` | Keep the harness. Replace test contents. |

Keep the `node:test` + strict-TS + esbuild setup. It works. Do not migrate to
vitest/jest — that is churn, not progress.

---

## 3. Non-negotiable design principles

1. **The orchestrator lives in the extension host, not the webview.** The
   webview is a pure view over state it does not own. It must be able to be
   closed and reopened at any time and re-render from scratch, with zero effect
   on running agents.
   *Deliberate deviation from the original ask:* the author said "as long as I
   have that tab open, it's running." Tying live agent processes to a UI tab's
   lifetime means an accidental Ctrl+W destroys in-flight work. Instead: agents
   run in the extension host, closing the tab only hides the view, and there is
   an explicit **Stop All** button plus an `argus.stopAgentsOnWindowClose`
   setting (default `false`). Surface this decision in the README.

2. **The event log is the source of truth.** Every state change is an append-only
   JSONL record in `.argus/events.jsonl`. All in-memory state is a fold over that
   log. This gives you crash recovery, a real timeline UI, and debuggability for
   free. Do not put authoritative state in a mutable object you also render from.

3. **Physical isolation before advisory locks.** Every task runs in its own git
   worktree. Two agents cannot write the same file because they are not in the
   same directory. Leases exist on top of that to prevent *semantic* collisions
   (two tasks that will both rewrite the same module conflict at merge time even
   though they never share a file handle).

4. **Pure core, imperative shell.** Scheduler, lease algebra, and the event
   reducer are pure functions over plain data, in files that import neither
   `vscode` nor the SDK. They get exhaustive unit tests. Everything that touches
   a process, the filesystem, or the DOM is a thin adapter around them. This is
   what makes the hard logic testable without a VS Code host.

5. **Never silently degrade.** If Argus cannot get a lease, cannot create a
   worktree, or hits a rate limit, it says so in the UI with the reason. A task
   that is stuck must look stuck. Silent stalling is the single worst failure
   mode for this product.

6. **Refuse to fake parallelism.** If the planner decomposes work into units
   that all lease the same paths, Argus must say "these 4 tasks conflict; they
   will run serially" — not pretend to run them at once and produce a merge
   catastrophe. Honesty about serialization is a feature.

---

## 4. Verified technical foundation

These are confirmed against current docs. **Re-verify the exact API surface
against the installed package's `.d.ts` before you code against it** — do not
trust the snippets below as literal API truth, treat them as "this capability
exists, go find its current shape."

- **Package:** `@anthropic-ai/claude-agent-sdk`, `query({ prompt, options })`
  returns an async generator of messages. Spawns a Claude Code subprocess.
- **Auth is inherited.** If the user is logged into Claude Code via `/login`
  with a subscription, the SDK uses it. No API key needed. Caveat:
  `ANTHROPIC_API_KEY` in the environment silently takes precedence — detect this
  and warn in the UI, because it changes who gets billed.
- **`canUseTool` is an async callback that may block indefinitely.** This is the
  mechanism that makes the inbox work: agent calls a tool → Argus's callback
  fires → Argus posts a question to the inbox and returns a promise → the human
  answers in the UI → the promise resolves → the agent continues *in the same
  session with full context*. No file polling, no restart, no latency floor.
  Returns `{ behavior: 'allow' | 'deny' | 'ask', message?, updatedInput? }`.
- **`AskUserQuestion` always routes through the permission layer** — that is the
  agent's structured "I need a decision" channel, and it carries options.
- **Streaming input:** `prompt` accepts an `AsyncIterable<SDKUserMessage>`, so
  you can push a new user message into a live session (steering, follow-ups).
- **Hooks** are available programmatically: `PreToolUse`, `PostToolUse`, `Stop`,
  `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `TaskCreated`,
  `TaskCompleted`, and more. `PreToolUse` can deny or rewrite a call — this is
  your **lease enforcement point**: reject an Edit/Write whose path falls outside
  the task's lease.
- **Sessions:** `sessionId`, `resume`, `forkSession`, `continue`. Session files
  live under `~/.claude/projects/<encoded-cwd>/`, and **resume is scoped to
  `cwd`** — which matters because each task's cwd is its worktree.
- **Telemetry:** assistant messages carry `usage` (`input_tokens`,
  `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`);
  result messages carry `total_cost_usd` and per-model `modelUsage`. Dedupe by
  message id — parallel tool calls repeat the id. Cost figures are client-side
  estimates; label them as estimates in the UI.
- **Controls that map straight to settings:** `model`, `effort`
  (`low | medium | high | xhigh | max`), `maxTurns`, `maxBudgetUsd`,
  `permissionMode`, `allowedTools` / `disallowedTools`,
  `systemPrompt: { type:'preset', preset:'claude_code', append }`,
  `additionalDirectories`, `abortController`, `pathToClaudeCodeExecutable`.

**Undocumented and therefore dangerous:** concurrency limits. Nothing states how
many simultaneous sessions are safe. Each is a subprocess. Subscription rate
limits are real. **Spike this first (§7).**

---

## 5. Architecture

```
┌─ Extension Host (Node) ─────────────────────────────────────────┐
│                                                                 │
│  Orchestrator ── owns everything below, survives webview close  │
│    ├── EventLog        append-only JSONL, source of truth       │
│    ├── Store           fold(events) → FleetState (pure)         │
│    ├── LeaseManager    glob conflict algebra (pure)             │
│    ├── Scheduler       which QUEUED task may start now (pure)   │
│    ├── WorktreeManager git worktree add/remove, serialized      │
│    ├── AgentRunner[]   one per task; wraps SDK query()          │
│    ├── Inbox           pending human decisions (promises)       │
│    ├── MergeQueue      serialized integration back to main      │
│    └── BudgetGuard     per-task + fleet-wide USD caps           │
│                                                                 │
└──────────────────┬──────────────────────────────────────────────┘
                   │  postMessage: state patches down, intents up
┌──────────────────▼─── Webview Panel (editor area) ──────────────┐
│  Tabs:  Fleet  ·  Inbox ★3  ·  Timeline  ·  Settings            │
└─────────────────────────────────────────────────────────────────┘
```

**Task lifecycle:**
`DRAFT → PLANNING → QUEUED → LEASED → RUNNING → (BLOCKED ⇄ RUNNING) → VERIFYING
→ READY → MERGING → DONE` with `FAILED` and `CANCELLED` as terminals.

- `PLANNING` — a cheap planner pass produces a scope, a file-glob lease request,
  and an acceptance check. Approving the plan is an inbox item if pushback is
  high.
- `QUEUED → LEASED` is the scheduler's decision point: leases are free, the
  concurrency cap has room, the budget has room.
- `BLOCKED` means a human decision is pending — this is what puts the ★ on the
  row. The agent process is alive and parked inside `canUseTool`.
- `MERGING` is strictly one-at-a-time across the whole fleet.

**Lease algebra** (pure, heavily tested): a lease is a set of glob patterns plus
a mode (`exclusive` | `shared`). Two lease sets conflict if any exclusive pattern
in one can match a path also matched by a pattern in the other. Overlap detection
between two globs without touching the filesystem is the interesting problem —
solve it conservatively: **when in doubt, declare a conflict.** A false conflict
costs parallelism; a missed conflict costs the user's work.

Enforce leases twice: the scheduler won't co-schedule conflicting tasks, and a
`PreToolUse` hook denies any write outside the lease at runtime. Belt and
braces — the agent may try to edit something it never declared.

**The merge queue** is where honesty matters. When a task reaches `READY`,
serialize: rebase its branch on current `main`, run the repo's verify command, and
only then fast-forward. On conflict, do not have the merge-queue robot silently
resolve it — mark the task `BLOCKED` with a `merge-conflict` inbox item that
offers *Have the agent rebase and fix it* / *Open in editor* / *Abandon*.

---

## 6. `.argus/` layout

`argus.init` scaffolds this. The command must be idempotent and must never
overwrite an existing `config.json`.

```
.argus/
  config.json         # COMMITTED — shared fleet policy
  agents/*.md         # COMMITTED — reusable task templates
  state/              # GITIGNORED — machine-local runtime
    events.jsonl
    tasks/<taskid>.json
    sessions/<taskid>.json
  worktrees/          # GITIGNORED — one git worktree per task
  logs/<taskid>.jsonl # GITIGNORED — raw SDK stream, for the timeline
```

`init` appends `.argus/state/`, `.argus/worktrees/`, `.argus/logs/` to
`.gitignore` if absent. Config committed, runtime state not — so a team shares
policy but not each other's process state.

`config.json` holds the settings from §8. Workspace VS Code settings may override
per-user; `.argus/config.json` is the project default.

---

## 7. Spike first — do this before writing production code

Four independent unknowns can each invalidate the design. Run **four subagents in
parallel**, each producing a short findings file under `.argus-spikes/`. This is a
genuine barrier: read all four results before you commit to Phase 1.

- **Spike A — Concurrency ceiling.** Launch 2, 4, 8, 12 concurrent trivial
  `query()` calls from one Node process. Record: wall-clock, RSS per subprocess,
  rate-limit errors and their exact shape, whether failures are graceful.
  **Deliverable:** the default and maximum for `argus.maxConcurrentAgents`, and
  the retry/backoff policy for a 429.
- **Spike B — Blocking `canUseTool`.** Run an agent that calls
  `AskUserQuestion`. Hold the callback promise unresolved for 3 minutes, then
  resolve it. Confirm the session survives, resumes with intact context, and the
  subprocess doesn't time out. **This is the load-bearing assumption of the whole
  inbox. If it fails, fall back to abort + `resume` with the answer injected, and
  say so loudly.**
- **Spike C — Worktrees on Windows.** Create and destroy 8 worktrees in a loop.
  Hunt: `EPERM`/`EBUSY` on removal while a subprocess holds a handle, `MAX_PATH`
  issues under a deep `.argus/worktrees/<taskid>/` prefix, index.lock contention
  from concurrent git invocations, and whether `node_modules` needs seeding per
  worktree (it does — decide: copy, symlink, or per-worktree install, and measure
  each). **Deliverable:** the worktree provisioning strategy.
- **Spike D — UI throughput.** Stream 8 concurrent token-level message flows into
  a webview. Find the update rate at which the panel stays smooth. **Deliverable:**
  the batching/coalescing interval for state patches (start by assuming you must
  batch — do not postMessage per token).

---

## 8. The UI

One webview panel, opened by a title-bar button (`editor/title` menu, `$(eye)`
icon, `navigation` group) and by `argus.open`. Four tabs.

**Fleet** — the default view. One row per task:
`★ · title · phase pill · progress bar · elapsed · $cost · model · lease summary`.
- The **★** appears when the task is `BLOCKED` on a human decision. Clicking it
  jumps to that inbox item. This is the highest-traffic interaction in the app;
  make it instant and make it obvious.
- Progress is honest: derive it from planner-declared steps completed, not from a
  timer. If you cannot know the percentage, show a phase and an activity
  indicator, **never a fake-advancing bar.**
- Row expands to a live tail of the agent's current activity (tool calls, not raw
  tokens).
- Per-row controls: pause, stop, steer (inject a user message into the live
  session via the streaming-input generator), open worktree, view diff.
- A fleet header: N running · M blocked · total spend · concurrency `3/6`.
- Conflicting queued tasks visibly say *waiting on lease held by `<task>`*.

**Inbox ★N** — the single place every human decision lands, from any agent.
Question text, the asking task, options as buttons, a free-text box, and *how
long the agent has been parked*. Keyboard-first: `j`/`k` to move, `1`–`9` to
pick an option, `Enter` to submit. Answering resolves the `canUseTool` promise
and the agent resumes immediately. Types of inbox item: agent question, plan
approval, permission escalation, merge conflict.

**Timeline** — the event log rendered as a per-task swimlane. This is the
debugging surface and it justifies the append-only log. Cheap to build once the
log exists; do not skip it.

**Settings** — writes `.argus/config.json`:
- **Verbosity** (`terse | normal | detailed`) — controls how much the agent
  narrates. Appended to the system prompt.
- **Pushback** (`autonomous | balanced | consult`) — how eagerly agents stop to
  ask. This is a *dual* control and both halves are required: it appends an
  explicit directive to the system prompt (*"decide routine tradeoffs yourself"*
  vs *"confirm any non-obvious interface change"*) **and** it tightens the
  `canUseTool` / `permissionMode` policy. A prompt directive alone is a
  suggestion; the permission layer is enforcement.
- **Model** (per-fleet default, overridable per task) and **Effort**.
- **Concurrency cap**, **per-task budget**, **fleet budget** (`maxBudgetUsd`).
- **Auto-merge** on/off, and the repo's verify command.
- Show the resolved system prompt in a read-only preview so the settings are not
  magic.

**Design:** match VS Code's theme via `var(--vscode-*)` tokens — it must look
native in light, dark, and high-contrast. Strict CSP, no CDN, everything
bundled. Do not ship a React+Tailwind stack for four tabs unless you can justify
it on build time and bundle size; plain TypeScript with a tiny render function
over a state snapshot is likely correct here, and it makes the "close and
re-render from scratch" requirement trivial.

---

## 9. Build phases, and how to parallelize them

You have subagents. Use them where the work is genuinely independent, and do not
use them where it isn't — a fan-out over a shared, unstable interface produces
four incompatible halves and a merge you have to do by hand.

**The rule: define the interface serially, then fan out on the implementations.**

- **Phase 0 — Spikes.** 4 agents in parallel (§7). Barrier: read all findings
  before proceeding.
- **Phase 1 — Contracts.** *Serial, you do this yourself.* Write `src/core/types.ts`:
  every event variant, `FleetState`, `Task`, `Lease`, `InboxItem`, and the
  webview↔host message protocol. Nothing else gets written until this file is
  stable. This is the load-bearing document for every fan-out that follows.
- **Phase 2 — Pure core.** 3 agents in parallel, each owning one file with no
  imports of `vscode` or the SDK, each shipping its own `node:test` suite:
  reducer (`fold(events) → FleetState`), lease algebra, scheduler. Property-style
  tests: random event sequences must never yield a state where two conflicting
  leases are simultaneously held.
- **Phase 3 — Imperative shell.** 3 agents in parallel against the Phase 1
  contracts: `AgentRunner` (SDK lifecycle, streaming input, hooks, telemetry),
  `WorktreeManager` (git, serialized, using Spike C's strategy), `EventLog`
  (durable append, crash-safe replay).
- **Phase 4 — UI.** 1 agent does the shell, protocol wiring, and theme tokens
  **first**; then 3 agents in parallel, one per tab (Fleet, Inbox+Timeline,
  Settings).
- **Phase 5 — Integration.** *Serial, you.* Wire orchestrator to UI, implement
  `argus.init`, the title-bar button, the status bar, and the merge queue.
- **Phase 6 — Adversarial verification.** See below.
- **Phase 7 — Docs.** Rewrite `SPEC.md` (v2 architecture) and `README.md` in
  parallel. Delete this file.

**Verifier discipline — this is not optional:**

- Every parallel implementation phase is followed by a **verifier agent that did
  not write the code.** Its job is to break it, not to admire it. Give it the
  Phase 1 contracts and the acceptance criteria, and tell it to hunt for
  contract violations, unhandled failure paths, and lost-update races.
- Findings get **adversarially confirmed** before you act: spawn a second agent
  prompted to *refute* each finding. Fix only what survives. This keeps you from
  chasing plausible-sounding non-bugs.
- The Phase 6 verifier fleet targets the failure modes that actually matter here,
  one agent each: **(a)** two tasks with overlapping leases — prove they never run
  concurrently; **(b)** kill the extension host mid-run — prove state replays and
  orphaned worktrees are detected on restart; **(c)** answer an inbox item after
  the agent has already been parked for minutes — prove it resumes with context;
  **(d)** a merge-queue conflict — prove it surfaces rather than silently
  resolving; **(e)** budget exhaustion mid-fleet — prove it stops cleanly instead
  of half-writing; **(f)** rate-limit storm — prove backoff, not cascade failure.
- **Do not mark a phase complete on a green typecheck.** Run the thing. The
  `verify` skill exists; use it. A phase is done when you have driven the actual
  behavior and observed it, and you report honestly what you observed — including
  what you could not get working.

**Commit discipline:** one commit per phase, conventional-commit style, matching
the existing history (`feat(core):`, `fix(ui):`, `docs(spec):`). Push after each
phase. Do not build the whole thing and push once.

---

## 10. Acceptance criteria

Argus v2 is done when, on a clean Windows machine with Claude Code logged in:

1. Cloning a repo, clicking the eye button, and hitting **Initialize** scaffolds
   `.argus/` and updates `.gitignore` — idempotently.
2. Three tasks can be created from the UI. Two with disjoint leases run
   concurrently in separate worktrees; the third, whose lease conflicts, sits in
   `QUEUED` and **states which task it is waiting on**.
3. An agent asking a question puts a ★ on its row within a second. Answering from
   the Inbox resumes that agent in its existing session, with context intact.
4. Closing the panel and reopening it re-renders full live state and never
   disturbs a running agent.
5. Killing the window mid-run and reopening replays the event log: tasks are
   correctly `FAILED`/orphaned, and stale worktrees are detected and offered for
   cleanup.
6. Changing model, effort, verbosity, or pushback in Settings measurably changes
   the next agent's behavior — demonstrate this, don't assert it.
7. Two completed tasks merge cleanly through the queue one at a time; an induced
   conflict surfaces as an inbox item instead of a silent bad merge.
8. Fleet spend is visible and a budget cap stops the fleet.
9. `npm test` passes; `npm run compile` is clean under strict TS; the packaged
   `.vsix` installs and activates.

---

## 11. Finishing

When every acceptance criterion above is met and pushed:

1. Rewrite `SPEC.md` and `README.md` for v2.
2. `git rm PLAN.md` — delete this file as part of the final commit.
3. Open a summary PR or push to `main`, and report to the author: what works,
   what you cut, what you could not verify, and what the spikes revealed. **Be
   specific about anything you could not get working.** A known gap is useful; a
   confident false claim is not.

---

## 12. Honest notes for whoever builds this

- **The plumbing is not the hard part.** Concurrent sessions, blocking on a
  human, streaming to a webview — all confirmed viable. The hard part is
  **decomposition**: producing tasks that are genuinely independent. If the
  planner does that badly, Argus is overhead on top of one agent. Invest in the
  planner and the lease declaration; they are where the product lives or dies.
- **Merge conflicts are the real boss.** Worktrees prevent file stomping, not
  semantic collision. Two agents can each produce a correct diff that together
  produce broken code. The merge queue's rebase-and-verify step is what catches
  this, so do not treat it as an afterthought.
- **Parallel agents burn money in parallel.** Budget caps are not a nice-to-have,
  they are the thing that stops a bad night from costing three figures.
- **Windows will fight you** on worktree removal, path length, and file locks.
  Spike C exists because of this. Budget real time for it.
- **The honest failure mode to design against** is a fleet that looks busy and
  produces nothing. Every stall must be visible, attributed, and actionable in
  the UI. A user who cannot tell the difference between "thinking" and "stuck"
  will stop trusting the tool, and then the tool is dead regardless of how good
  the scheduler is.
