# PLAN.md — Build Argus v2

**This file is a prompt.** You are the Claude Code session that builds Argus v2.
Read it fully before touching anything. Delete this file when v2.0 ships
(see §13).

Repo: https://github.com/philliplavrador/Argus · Platform: Windows 11, PowerShell
primary · Author: Phillip Lavrador

---

## 1. The one sentence that governs every decision

> **Argus exists so that one person can run several Claude Code agents against
> one large repository at the same time — parallel where the work is separable,
> serial where it isn't — without those agents corrupting each other's work, and
> answer all of their questions from one place.**

If a feature does not serve *keeping agents out of each other's way* or *getting
a decision out of the human's head and into the fleet faster*, it is out of
scope. A prettier way to launch one agent is not Argus — the Claude Code
extension already exists and is better at it.

### Argus is for big repos. Say so everywhere.

This is not a general-purpose Claude wrapper and the docs must not read like one.
Argus targets repositories large enough that three things are true at once:

1. **The work is genuinely separable.** There are parts of the tree you can
   change without touching other parts. In a small repo there is no separable
   work, so there is nothing to parallelize and one agent in one terminal is
   strictly better.
2. **Orientation is expensive.** In a large tree an unscoped agent burns real
   time and tokens just working out where things live before it edits anything.
   This is the underrated argument for Argus: **scoping an agent to a subtree
   isn't only a safety mechanism, it makes each agent faster and cheaper.** A
   scoped agent skips the archaeology.
3. **You can't hold it all in your head.** You cannot personally predict whether
   the billing task and the auth task will collide in some shared util three
   directories away. That's the part Argus is supposed to know for you.

Lead the README with this. A reader who has a 40-file project should be able to
tell within one paragraph that this tool is not for them.

---

## 2. What exists today, and what happens to it

v0.1 is a **passive viewer**: agents write `STATUS.json` and
`workflow/queue/*.md`, the extension renders them and writes checkbox answers
back. That protocol existed because the extension did not control the agent
processes. It does now, so the protocol dies.

| Path | Fate |
|---|---|
| `src/lib/status.ts`, `src/lib/question.ts`, `src/model.ts` | **Delete.** The file contract they parse is gone. |
| `src/tree.ts`, `src/panel.ts` | **Delete.** Replaced by the webview UI. |
| `src/statusbar.ts` | **Keep the idea, rewrite** against live orchestrator state. |
| `src/lib/render.ts` | Read before deleting — if the progress-bar renderer is good, port it. |
| `SPEC.md` | **Rewrite** as the v2 architecture doc. Do not preserve `spec: 1`. |
| `README.md` | Rewrite for v2, leading with §1's big-repo framing. |
| `argus-0.1.0.vsix` | `git rm`; add `*.vsix` to `.gitignore`. |
| `test/`, `esbuild.mjs`, `tsconfig*.json`, `.vscode/` | Keep the harness, replace contents. |

Keep the `node:test` + strict-TS + esbuild setup. It works. Do not migrate to
vitest/jest — that is churn, not progress.

---

## 3. Non-negotiable design principles

1. **The orchestrator lives in the extension host, not the webview.** The webview
   is a pure view over state it does not own; it must be closable and reopenable
   at any time, re-rendering from scratch, with zero effect on running agents.
   *Deliberate deviation from the original ask:* the author said "as long as I
   have that tab open, it's running." Tying live agents to a tab's lifetime means
   an accidental Ctrl+W destroys in-flight work. Closing the panel hides the
   view; there is an explicit **Stop All** and an `argus.stopAgentsOnWindowClose`
   setting (default `false`). Document this deviation in the README.

2. **The event log is the source of truth.** Every state change is an
   append-only JSONL record in `.argus/state/events.jsonl`; in-memory state is a
   fold over it. Crash recovery, the timeline UI, and the collision analysis in
   §7 all fall out of this for free.

3. **Physical isolation before advisory locks.** Every task runs in its own git
   worktree. Two agents cannot write the same file because they are not in the
   same directory.

4. **Pure core, imperative shell.** The event reducer and the scope/overlap logic
   are pure functions over plain data, in files importing neither `vscode` nor
   the SDK, with exhaustive `node:test` suites. Everything touching a process,
   the filesystem, or the DOM is a thin adapter.

5. **Never silently degrade.** A task that is stuck must *look* stuck, with the
   reason and an action. A user who cannot distinguish "thinking" from "stuck"
   stops trusting the tool, and then the tool is dead no matter how good the
   internals are.

6. **Refuse to fake parallelism.** If two tasks must serialize, say so and name
   the task being waited on. Honesty about serialization is a feature.

7. **Prompt text is a suggestion; gates are enforcement.** This rule decides
   several designs below. Anything the user asserts in the UI — a scope, a
   required test, a pushback level — must be backed by a mechanism that can
   actually stop the task, not merely a sentence appended to a system prompt.

---

## 4. Verified technical foundation

Confirmed against current docs. **Re-verify the exact API surface against the
installed package's `.d.ts` before coding against it** — treat the below as
"this capability exists, go find its current shape."

- **Package:** `@anthropic-ai/claude-agent-sdk`; `query({ prompt, options })`
  returns an async generator of messages, spawning a Claude Code subprocess.
- **Auth is inherited** from the user's `/login` — no API key needed. Caveat:
  `ANTHROPIC_API_KEY` in the environment silently takes precedence and changes
  who gets billed. Detect and warn in the UI.
- **`canUseTool` is an async callback that may block indefinitely.** This is the
  mechanism the entire inbox rests on: agent calls a tool → callback fires →
  Argus posts an inbox item and returns an unresolved promise → human answers →
  promise resolves → agent continues *in the same session with full context*.
  Returns `{ behavior: 'allow' | 'deny' | 'ask', message?, updatedInput? }`.
- **`AskUserQuestion` routes through the permission layer** — the agent's
  structured "I need a decision" channel, and it carries options.
- **Streaming input:** `prompt` accepts `AsyncIterable<SDKUserMessage>`, so you
  can push a message into a live session (steering, follow-ups).
- **Hooks:** `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd`,
  `SubagentStart/Stop`, `TaskCreated/Completed`, and more. `PreToolUse` can deny
  or rewrite a call — **this is the scope-enforcement point** (§6) and the
  instrumentation tap (§7).
- **Sessions:** `sessionId`, `resume`, `forkSession`, `continue`. Session files
  live under `~/.claude/projects/<encoded-cwd>/` and **resume is scoped to
  `cwd`** — which matters because each task's cwd is its worktree.
- **Telemetry:** assistant messages carry `usage` (input/output/cache tokens);
  result messages carry `total_cost_usd` and per-model `modelUsage`. Dedupe by
  message id — parallel tool calls repeat it. These are client-side estimates;
  label them as estimates.
- **Direct setting mappings:** `model`, `effort` (`low|medium|high|xhigh|max`),
  `maxTurns`, `maxBudgetUsd`, `permissionMode`, `allowedTools`/`disallowedTools`,
  `systemPrompt: { type:'preset', preset:'claude_code', append }`,
  `additionalDirectories`, `abortController`, `pathToClaudeCodeExecutable`.

**Undocumented and therefore dangerous:** concurrency limits. Each session is a
subprocess; subscription rate limits are real. Spike it (§8).

---

## 5. Architecture

```
┌─ Extension Host (Node) ─────────────────────────────────────────┐
│  Orchestrator ── owns everything below, survives webview close  │
│    ├── EventLog        append-only JSONL, source of truth       │
│    ├── Store           fold(events) → FleetState (pure)         │
│    ├── ScopeGuard      PreToolUse enforcement + instrumentation │
│    ├── WorktreeManager git worktree add/remove, serialized      │
│    ├── AgentRunner[]   one per task; wraps SDK query()          │
│    ├── Inbox           pending human decisions (held promises)  │
│    ├── MergeQueue      serialized rebase → verify → merge       │
│    ├── RepoProfile     detected layout, scripts, test runners   │
│    └── BudgetGuard     per-task + fleet-wide USD caps           │
└──────────────────┬──────────────────────────────────────────────┘
                   │  postMessage: batched state patches ↓, intents ↑
┌──────────────────▼─── Webview Panel (editor area) ──────────────┐
│  Tabs:  Fleet  ·  Inbox ★3  ·  Timeline  ·  Settings            │
└─────────────────────────────────────────────────────────────────┘
```

**Task lifecycle:** `DRAFT → QUEUED → RUNNING → (BLOCKED ⇄ RUNNING) → VERIFYING
→ READY → MERGING → DONE`, plus `FAILED` and `CANCELLED`.

`BLOCKED` means a human decision is pending — this is what puts the ★ on the row.
The agent process is alive and parked inside `canUseTool`. `MERGING` is strictly
one task at a time across the whole fleet.

---

## 6. The two features that carry the product

Everything else is supporting structure. Get these two right.

### 6.1 The Inbox — one queue for every agent's question

**This is the highest-value feature in the project and it is not close.** Git
worktrees already give physical isolation today; you can run three agents in
three terminals right now and they won't stomp each other's files. What you
cannot do is notice that agent 2 has been parked on a question for eleven
minutes while you were heads-down in window 3. **Parallel agents die from
unattended blocking, not from file collisions.**

One queue, every agent, four item types:

| Type | Raised by | Resolution |
|---|---|---|
| **Question** | agent calls `AskUserQuestion` | pick an option / free text |
| **Scope escalation** | `ScopeGuard` denies a stray write (§6.2) | allow once / deny / expand scope |
| **Verify failure** | a required gate failed (§11.1) | send back to agent / override / abandon |
| **Merge conflict** | MergeQueue rebase failed | agent rebases and fixes / open in editor / abandon |

Requirements: keyboard-first (`j`/`k` to move, `1`–`9` to pick, `Enter` to
submit); show **how long the agent has been parked**, because that number is the
whole argument for the feature; answering resolves the held promise and the agent
resumes immediately in-session.

**Design the inbox for four concurrent items, not forty.** Practical concurrency
is bounded by the human, not by rate limits — every agent eventually needs a
decision and you answer them serially. Three to four concurrent agents is where
one person saturates. Build for that number and it will feel excellent; build for
forty and it will feel like a ticketing system.

### 6.2 ScopeGuard — catch the agent that wanders

The scheduler is *not* the valuable half of conflict management. When you launch
"fix billing rounding" and "add OAuth," you already know those are disjoint —
you picked them. What you cannot predict is agent B deciding, forty minutes in,
that it needs to refactor a shared util that agent A is also rewriting.

**So the load-bearing mechanism is runtime enforcement, not schedule-time
prediction.** A `PreToolUse` hook checks every `Edit`/`Write`/`NotebookEdit`
path against the task's declared scope:

- **Inside scope** → allow, and record the path (§7).
- **Outside scope** → **do not silently deny.** Raise a *scope escalation* inbox
  item: *"`add-oauth` wants to edit `src/lib/date.ts`, outside its scope. Task
  `fix-billing` is currently running and its scope covers that path."* Options:
  allow once · allow and expand scope · deny with a reason passed back to the
  agent. The agent parks in `canUseTool` meanwhile.

This is where the two halves of the product meet: **enforcement generates the
inbox items, and the inbox makes enforcement non-obstructive.** A guard that only
denies would be infuriating in a big repo where legitimate cross-cutting edits
are common. A guard that escalates turns every near-collision into a five-second
decision.

Note the repo shape this must work on: the author's target is *mixed* — several
repos, not all monorepos with clean `packages/*` boundaries. Do not assume
natural boundaries exist. Scope comes from what the human declared at task
creation (§11.1) or a cheap planner pass, and enforcement does the real work.

---

## 7. Instrument before you build the scheduler

You do not know your collision rate. Nobody does. The lease algebra and the
conflict-aware scheduler are the most expensive things anyone has proposed for
this project, and they are built entirely on a guess about how often agents
actually stray. **So measure first.**

v2.0 ships with `ScopeGuard` in **observe-and-escalate** mode, recording to the
event log for every task:

- every path written, with taskid and timestamp
- every path read (weaker signal, still useful for scoping heuristics)
- every scope escalation, and how the human resolved it

Then `argus.collisionReport` computes two **different** numbers that gate two
**different** features:

| Metric | Definition | Gates |
|---|---|---|
| **Stray rate** | % of tasks that attempted a write outside declared scope | Already justified — ScopeGuard ships in v2.0 regardless. Tells you how much friction it causes. |
| **Collision rate** | % of *concurrently running* task pairs whose write sets intersected | The conflict-aware scheduler and lease algebra (v2.3). |

Run v2.0 on real work for a week, then read the report. If collision rate is
high, build the scheduler against observed patterns instead of guesses. If it's
low, you have skipped the hardest module in the project and shipped in a
fraction of the time. **Either outcome is a win; guessing is the only losing
move.**

---

## 8. Spike first

Four independent unknowns can each invalidate the design. Run **four subagents in
parallel**, each writing findings to `.argus-spikes/`. Genuine barrier: read all
four before committing to Phase 1.

- **Spike A — Concurrency ceiling.** 2, 4, 8, 12 concurrent trivial `query()`
  calls from one Node process. Record wall-clock, RSS per subprocess, exact shape
  of rate-limit errors, whether failure is graceful. → default and max for
  `argus.maxConcurrentAgents`, plus 429 backoff policy.
- **Spike B — Blocking `canUseTool`.** Agent calls `AskUserQuestion`; hold the
  promise 3 minutes; resolve. Confirm the session survives with intact context
  and the subprocess doesn't time out. **This is the load-bearing assumption of
  the entire inbox.** If it fails, fall back to abort + `resume` with the answer
  injected, and say so loudly — the product still works, but latency and cost
  change.
- **Spike C — Worktrees on Windows.** Create/destroy 8 worktrees in a loop. Hunt
  `EPERM`/`EBUSY` on removal while a subprocess holds a handle, `MAX_PATH` under
  the `.argus/worktrees/<taskid>/` prefix, and index.lock contention from
  concurrent git calls. **Decide and measure the `node_modules` strategy** (copy
  vs. symlink vs. per-worktree install) — this also determines whether v2.2's
  live preview is affordable. → worktree provisioning strategy.
- **Spike D — UI throughput.** Stream 8 concurrent message flows into a webview.
  Find the rate at which it stays smooth. → batching interval for state patches.
  Assume you must coalesce; do not `postMessage` per token.

---

## 9. `.argus/` layout

`argus.init` scaffolds this. Idempotent; never overwrites an existing
`config.json`.

```
.argus/
  config.json         # COMMITTED — fleet policy + recipes
  profile.json        # COMMITTED — detected repo layout (§11.1), regenerable
  agents/*.md         # COMMITTED — reusable task templates
  state/              # GITIGNORED
    events.jsonl
    tasks/<taskid>.json
  worktrees/          # GITIGNORED — one git worktree per task
  logs/<taskid>.jsonl # GITIGNORED — raw SDK stream, feeds the timeline
```

`init` appends `.argus/state/`, `.argus/worktrees/`, `.argus/logs/` to
`.gitignore` if absent. Policy is committed and shared; process state is not.

---

## 10. The UI

One webview panel, opened by a title-bar button (`editor/title` menu, `$(eye)`,
`navigation` group) and by `argus.open`.

**Fleet** — default view. One row per task:
`★ · title · phase pill · progress · elapsed · $cost · model · scope summary`.
- The **★** marks a task blocked on a human decision; clicking jumps to that
  inbox item. Highest-traffic interaction in the app — make it instant.
- Progress must be honest. Derive it from declared steps completed. If you cannot
  know a percentage, show a phase and an activity indicator — **never a
  fake-advancing bar.**
- Rows expand to a live tail of tool calls (not raw tokens).
- Per-row: pause, stop, **steer** (inject a message into the live session),
  open worktree, view diff.
- Header: N running · M blocked · total spend · concurrency `3/6`.

**Inbox ★N** — §6.1.

**Timeline** — the event log as per-task swimlanes. The debugging surface, and
what justifies the append-only log. Cheap once the log exists; don't skip it.

**Settings** — writes `.argus/config.json`:
- **Verbosity** (`terse | normal | detailed`) — appended to the system prompt.
- **Pushback** (`autonomous | balanced | consult`) — **dual control, both halves
  required.** It appends a directive to the system prompt *and* tightens
  `permissionMode` / the `canUseTool` policy. Per principle 7, the prompt half
  alone is a suggestion; the permission layer is the enforcement.
- **Model** and **Effort** (fleet default, per-task override).
- **Concurrency cap**, **per-task budget**, **fleet budget** (`maxBudgetUsd`).
- **Auto-merge** on/off; the repo's verify command.
- A read-only preview of the resolved system prompt, so settings aren't magic.

**Design:** theme via `var(--vscode-*)` tokens — must look native in light, dark,
and high-contrast. Strict CSP, everything bundled, no CDN. Do not ship
React+Tailwind for four tabs unless you can justify it on build time and bundle
size; plain TypeScript rendering from a state snapshot is likely correct and
makes "close and re-render from scratch" trivial.

---

## 11. Release sequencing

**v2.0 is the whole deliverable for now.** Everything in §11.1–11.3 is deferred
on purpose, and the deferral is the point: v2.3 in particular is gated on data
that does not exist yet.

### Phases for v2.0

| Phase | Work | Parallelism |
|---|---|---|
| **0** | Spikes (§8) | 4 agents in parallel · **barrier** |
| **1** | `src/core/types.ts` — every event variant, `FleetState`, `Task`, `Scope`, `InboxItem`, and the webview↔host protocol | **Serial, you.** Nothing else is written until this is stable. |
| **2** | Pure core: event reducer · path/scope matching · repo-profile detector | 3 agents in parallel, each one file + its own tests |
| **3** | Imperative shell: `AgentRunner` (SDK lifecycle, streaming input, hooks, telemetry) · `WorktreeManager` (git, serialized, per Spike C) · `EventLog` (durable append, crash-safe replay) | 3 agents in parallel |
| **4** | UI: shell + protocol + theme tokens **first (serial)**, then one agent per tab | 1 then 3 |
| **5** | Integration: wire orchestrator↔UI, `argus.init`, title-bar button, status bar, ScopeGuard escalation path, MergeQueue, `argus.collisionReport` | **Serial, you.** |
| **6** | Adversarial verification (§12) | fan-out |
| **7** | Rewrite `SPEC.md` + `README.md`; delete this file | 2 in parallel |

**The rule for fan-out: define the interface serially, then parallelize the
implementations.** A fan-out over an unstable interface produces four
incompatible halves and a merge you do by hand.

### 11.1 — v2.1: the task composer

Today's task creation is a title, a prompt, and a scope. v2.1 makes it
repo-aware. `RepoProfile` detects — per repo, since the target is *mixed* repo
shapes, so detect rather than assume — workspace layout, `package.json` scripts,
Playwright/Vitest/Jest configs, dev-server command, CI workflow, lint/typecheck
commands. `profile.json` caches it and is user-editable.

The composer then offers only what it actually found: *"Run `test:e2e`
(Playwright detected)?"* · *"Run `typecheck` before merge?"* · *"Require lint
clean?"*

**The rule that makes this feature worth building:** per principle 7, **a checked
box creates a gate, not a sentence.** Checking "run e2e" means the task
physically cannot enter `MERGING` until `npm run test:e2e` passes in its
worktree, and a failure becomes a *verify failure* inbox item. If checking the
box only appends "please run the e2e tests" to the prompt, **delete the
feature** — it is strictly worse than typing it yourself, because it looks like
a guarantee and isn't.

Recipes (a named bundle of scope + gates + model + effort, e.g. "frontend page")
live in `config.json` and are shareable across the team.

### 11.2 — v2.2: variant fan-out with live preview

*"Create a new frontend page — give me 3 versions and I'll pick."*

This is the best-fitting feature for Argus specifically, because **variants are
conflict-free by construction**: N agents, N worktrees, same prompt, and at most
one result ever merges. The losers are deleted. It manufactures perfectly
parallel work in a product whose entire purpose is managing contention, and it
terminates in exactly the interaction the inbox already handles — a human
picking a winner.

Confirmed requirement: **live preview per variant**, not diffs. A frontend page
cannot be judged from a diff. Each variant gets an allocated port; Argus boots
the detected dev command in that worktree, health-checks it, and the Inbox shows
N live previews side by side alongside the diffs and each agent's rationale.
Picking a winner sends it to the merge queue and tears down the rest.

Needs, in order: port allocation and collision handling · dev-server lifecycle
with health checks and hard timeouts · per-worktree dependency install (Spike C
decides whether this is seconds or minutes — **if minutes, this feature is not
viable as designed and you must say so rather than shipping something that takes
four minutes to show a preview**) · a hard cap of 4 variants, since cost and
memory are both linear in N.

Spike the dev-server-per-worktree question at the start of v2.2, not now.

### 11.3 — v2.3: the conflict-aware scheduler — **gated**

Do not build this until `argus.collisionReport` (§7) shows a collision rate that
justifies it. If it does: leases as glob sets with `exclusive`/`shared` modes,
conservative overlap detection (**when in doubt, declare a conflict** — a false
conflict costs parallelism, a missed one costs the user's work), and a scheduler
that refuses to co-schedule conflicting tasks and names the blocker in the UI.

If the report says collisions are rare, **write that down in `SPEC.md` and close
the idea.** A documented decision not to build something is a real deliverable.

---

## 12. Verification discipline

- Every parallel implementation phase is followed by a **verifier agent that did
  not write the code**, given the Phase 1 contracts and the acceptance criteria,
  and told to break it — contract violations, unhandled failure paths, lost-update
  races.
- **Adversarially confirm findings before acting:** spawn a second agent prompted
  to *refute* each one. Fix only what survives. This stops you chasing
  plausible-sounding non-bugs.
- Phase 6 fleet, one agent per failure mode: **(a)** kill the extension host
  mid-run — state replays, orphaned worktrees detected on restart; **(b)** answer
  an inbox item after the agent has been parked for minutes — it resumes with
  context; **(c)** an agent writes outside scope — escalation fires, all three
  resolutions behave; **(d)** merge-queue conflict — surfaces rather than
  silently resolving; **(e)** budget exhaustion mid-fleet — stops cleanly, no
  half-writes; **(f)** rate-limit storm — backoff, not cascade failure.
- **A green typecheck is not a completed phase.** Run the thing; the `verify`
  skill exists, use it. A phase is done when you have driven the real behavior
  and observed it — and you report honestly what you observed, including what you
  could not get working.

**Commit discipline:** one commit per phase, conventional-commit style matching
existing history (`feat(core):`, `fix(ui):`, `docs(spec):`). Push after each
phase. Do not build everything and push once.

---

## 13. v2.0 acceptance criteria

On a clean Windows machine with Claude Code logged in:

1. Clone a large repo, click the eye button, hit **Initialize** → `.argus/`
   scaffolded and `.gitignore` updated, idempotently.
2. Create three tasks with declared scopes; they run concurrently in separate
   worktrees with live progress, cost, and phase in the Fleet tab.
3. An agent's question puts a ★ on its row within a second; answering from the
   Inbox resumes that agent in its existing session with context intact.
4. An agent attempting a write outside its scope raises a scope escalation; all
   three resolutions (allow once / expand / deny) behave correctly, and deny
   passes a usable reason back to the agent.
5. Closing and reopening the panel re-renders full live state without disturbing
   a running agent.
6. Killing the window mid-run and reopening replays the event log correctly and
   offers stale-worktree cleanup.
7. Changing model, effort, verbosity, or pushback measurably changes the next
   agent's behavior — demonstrate it, don't assert it.
8. Two completed tasks merge one at a time through the queue; an induced conflict
   surfaces as an inbox item instead of a silent bad merge.
9. Fleet spend is visible and a budget cap stops the fleet.
10. `argus.collisionReport` produces both metrics from §7 over a real session.
11. `npm test` passes, `npm run compile` is clean under strict TS, the packaged
    `.vsix` installs and activates.

**When all of the above pass and are pushed:** rewrite `SPEC.md` and `README.md`
for v2 (leading with §1's big-repo framing), `git rm PLAN.md`, and report to the
author: what works, what you cut, what you could not verify, and what the spikes
revealed. Be specific about anything you could not get working — a known gap is
useful, a confident false claim is not.

---

## 14. Honest notes for whoever builds this

- **The plumbing is not the hard part.** Concurrent sessions, blocking on a
  human, streaming to a webview — all confirmed viable. The hard part is
  **scoping**: producing tasks that are genuinely independent, and catching the
  agent that leaves its lane. That's why ScopeGuard and the inbox are v2.0 and
  the scheduler is gated.
- **Semantic conflicts survive worktrees.** Two agents can each produce a correct
  diff that together produce broken code. Worktrees prevent file stomping, not
  logical collision. The merge queue's rebase-and-verify is the only thing that
  catches this — do not treat it as an afterthought.
- **Argus's value is proportional to how long you trust an agent unattended.** If
  you have to watch each one, you can only watch one, and parallelism buys
  nothing regardless of how good the internals are. This is not a software
  problem you can solve here, but it should shape every default toward *letting
  the agent get further before it needs you*.
- **Parallel agents burn money in parallel.** Budget caps are the thing that
  stops a bad night from costing three figures.
- **Windows will fight you** on worktree removal, path length, and file locks.
  Spike C exists for this. Budget real time for it.
- **The failure mode to design against** is a fleet that looks busy and produces
  nothing. Every stall must be visible, attributed, and actionable.
