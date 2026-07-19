# Argus v2 — architecture

Argus runs several Claude Code agents against one repository at the same time:
parallel where the work is separable, serial where it isn't, without the agents
corrupting each other's work, with every question answered from one place. This
document is the v2 architecture contract. (The v0.1 file-polling protocol —
`spec: 1` — is gone; Argus now owns the agent processes via the Claude Agent
SDK.)

## The shape

```
┌─ Extension Host (Node) ─────────────────────────────────────────┐
│  Orchestrator ── owns everything below, survives webview close  │
│    ├── EventLog        append-only JSONL, source of truth       │
│    ├── reduce()        fold(events) → FleetState (pure)         │
│    ├── ScopeGuard      canUseTool policy + instrumentation      │
│    ├── WorktreeManager git worktree add/remove + guardrails     │
│    ├── AgentRunner[]   one per task; wraps SDK query()          │
│    ├── Inbox           held promises awaiting a human           │
│    ├── MergeQueue      serialized rebase → verify → ff-merge    │
│    └── Budgets         per-task (SDK) + fleet-wide (orchestr.)  │
└──────────────────┬──────────────────────────────────────────────┘
                   │  postMessage: snapshot + batched events ↓, intents ↑
┌──────────────────▼─── Webview Panel (editor area) ──────────────┐
│  Tabs:  Fleet  ·  Inbox ★N  ·  Timeline  ·  Settings            │
└─────────────────────────────────────────────────────────────────┘
```

Three design rules carry everything:

1. **The event log is the source of truth.** Every state change is an
   append-only line in `.argus/state/events.jsonl`; in-memory state is a pure
   fold over it (`src/core/reducer.ts`). The webview runs the *same* fold over
   the *same* events. Crash recovery, the Timeline, and the collision report
   all fall out of this.
2. **Physical isolation before advisory locks.** Every task runs in its own
   git worktree under `.argus/worktrees/<taskId>` on branch `argus/<taskId>`.
   Two agents cannot stomp each other's files because they are not in the same
   directory.
3. **Prompt text is a suggestion; gates are enforcement.** Every promise the UI
   makes is backed by a mechanism that can stop the task: scope is enforced in
   `canUseTool`, verify gates physically block `READY`, pushback tightens the
   permission policy, budgets abort sessions.

## Task lifecycle

`DRAFT → QUEUED → RUNNING → (BLOCKED ⇄ RUNNING) → VERIFYING → READY → MERGING → DONE`
plus `FAILED` and `CANCELLED`.

- `BLOCKED` means a human decision is pending; the agent process is alive,
  parked inside `canUseTool`. This is what puts the ★ on the row.
- `VERIFYING` and `MERGING` can also carry a pending decision (`blockedOn`)
  without changing phase — a failed gate or a rebase conflict parks the flow,
  not the agent.
- `MERGING` is held by at most one task fleet-wide.
- A merge attempt that backs off (conflict resolved by hand) returns the task
  to `READY` and releases the merge slot.
- On orchestrator restart, replay marks tasks that were live at the crash as
  `FAILED` ("interrupted … worktree preserved") and voids their pending inbox
  items; leftover worktrees are offered for cleanup. Honest state over clever
  resumption.

## The inbox — one queue, four item kinds

The load-bearing mechanism (verified live, Spike B + the slice smoke): the
SDK's `canUseTool` callback may block indefinitely — "permission prompts have
no park deadline." Argus turns that into a held promise per decision:

| Kind | Raised when | Resolutions |
|---|---|---|
| `question` | agent calls `AskUserQuestion` | pick option(s) / free text |
| `scope-escalation` | a write lands outside the task's scope | allow once · expand scope · deny with reason |
| `verify-failure` | a gate exits non-zero | send back to agent · override · abandon |
| `merge-conflict` | the merge queue's rebase conflicts | let the agent fix it · open in editor · abandon |

Mechanics that matter:

- Questions are answered by returning `{ behavior: 'allow', updatedInput:
  { …input, answers: { [questionText]: answerString } } }` — the SDK
  synthesizes the tool result. Answers key by question *text*; multi-select
  answers are comma-joined.
- Gated tools must **not** appear as bare `allowedTools` entries — bare entries
  are auto-approved before `canUseTool` is consulted. Argus sets no
  `allowedTools` at all.
- `askUserQuestionTimeout` stays at its default `never`.
- A denial carries the human's reason back to the agent as the tool result;
  the agent adjusts instead of dying (no `interrupt`).
- Every decision is measured: the UI shows how long an agent has been parked,
  because unattended blocking — not file collision — is what kills parallel
  fleets.

## ScopeGuard

Runtime enforcement, not schedule-time prediction. On every tool call
(`src/core/guard.ts`, pure and exhaustively tested):

- `Edit` / `Write` / `NotebookEdit` paths resolve against the worktree and are
  matched against the task's scope globs. In scope → allow + `path-write`
  event. Out of scope (or outside the worktree, or unparseable — fail closed)
  → a `scope-escalation` inbox item; the agent parks meanwhile.
- `Read` paths are recorded (`path-read`) via the `PreToolUse` hook — weaker
  signal, useful for scoping heuristics.
- Scope globs support `**`, `*`, `?` only, matched case-insensitively;
  malformed globs match nothing (fail closed). `dir/**` also covers `dir`.
- Under `balanced`/`consult` pushback, destructive Bash shapes (`rm -rf`,
  `git push`, `git checkout`, `npm publish`, …) escalate as decisions too.
- **Known limitation:** Bash is not path-checked — an agent could write via
  shell redirection without tripping ScopeGuard. v2.0 ships observe-and-
  escalate for the write tools, which covers the overwhelmingly common case;
  the raw command of every Bash call is still logged as a `tool-call` event.

Scope expansion is dual-recorded: the runner widens its live gate, and a
`scope-expanded` event amends the task's declared scope in fleet state, so
display and enforcement never drift.

## The merge queue

Strictly one task merges at a time. For a `READY` task:

1. `git rebase <baseBranch>` in the task's worktree (base = the branch the
   primary checkout had when the orchestrator booted).
2. On conflict: capture the conflicted files, `git rebase --abort`, raise a
   `merge-conflict` item. No conflict is ever resolved silently.
3. Re-run the task's gates post-rebase — this is what catches *semantic*
   conflicts, which worktrees cannot prevent.
4. `git merge --ff-only argus/<taskId>` in the primary checkout, then remove
   the worktree and branch.

Verified live: a scripted conflicting history surfaced the item twice, backed
off to `READY` correctly, abandoned honestly, and never touched the base
branch.

## Worktrees on Windows (Spike C, encoded in `WorktreeManager`)

- `core.longpaths true` is set (repo-local) at first provisioning — without it
  deep paths break `git add`, blind `git status` (rc=0!), and break removal.
- Removal ordering is a contract: **stop the agent first**, then plain
  `git worktree remove`, then `--force` (agents always leave untracked files),
  then verify the directory is actually gone — `--force` can deregister yet
  orphan a locked dir — with `rm -rf` + `git worktree prune` as the fallback.
- Concurrent `worktree add` needs no serialization on git 2.51 (44 concurrent
  ops, zero lock errors); Argus serializes anyway as free belt-and-suspenders.
- Fresh worktrees get the repo's dependency install by default (~7s on a warm
  npm cache; `installDepsOnProvision` turns it off). Junction-shared
  `node_modules` is forbidden: write-back through the junction into the shared
  source is confirmed real.

## Telemetry and budgets

Token counts stream per assistant message (deduped by message id); dollar cost
arrives with each session's result message. Both are client-side estimates and
are labeled as such. Per-task budgets ride the SDK's `maxBudgetUsd` (enforced
in-session); the fleet budget is enforced by the orchestrator, which stops
every task when the fleet estimate crosses the cap.

## `.argus/` layout

```
.argus/
  config.json         # COMMITTED — fleet policy (see below)
  profile.json        # COMMITTED — detected repo layout, regenerable
  agents/             # COMMITTED — reserved for reusable task templates (v2.1)
  state/events.jsonl  # GITIGNORED — the event log
  worktrees/<taskId>/ # GITIGNORED — one git worktree per task
  logs/<taskId>.jsonl # GITIGNORED — raw SDK message streams
```

`argus.init` scaffolds this idempotently and appends the three gitignore
entries. `config.json`:

| Field | Default | Meaning |
|---|---|---|
| `maxConcurrentAgents` | `3` | Live-agent cap (Spike A: 8 verified clean; UI caps at 8) |
| `defaultModel` | `claude-opus-4-8` | Fleet default; per-task override in the composer |
| `defaultEffort` | `high` | `low` … `max` |
| `verbosity` | `normal` | Prompt directive: terse / normal / detailed |
| `pushback` | `balanced` | Dual control: prompt directive **and** permission policy |
| `perTaskBudgetUsd` | `10` | SDK-enforced per-session cap; `null` = none |
| `fleetBudgetUsd` | `50` | Orchestrator-enforced fleet cap; `null` = none |
| `autoMerge` | `false` | Enter the merge queue automatically on READY |
| `verifyCommand` | `null` | Repo-wide gate when a task declares none |
| `installDepsOnProvision` | `true` | Run the detected install in fresh worktrees |

## Instrumentation before scheduling (§ the v2.3 gate)

`argus.collisionReport` computes, from the event log:

- **Stray rate** — started tasks that attempted an out-of-scope write. Tells
  you how much friction ScopeGuard causes; ScopeGuard ships regardless.
- **Collision rate** — concurrently-running task pairs whose write sets
  intersected. **This number gates the conflict-aware scheduler.** If a week
  of real use keeps it low, the scheduler does not get built — that decision
  gets written here and the idea closed. Guessing is the only losing move.

## Verification status (2026-07-19 overnight build)

- 243 unit tests (`node:test`, no VS Code host): reducer, scope engine,
  profile detector, guard, EventLog (crash-corruption cases), WorktreeManager
  (against real git), AgentRunner (scripted SDK fake), orchestrator
  (scheduler race, cap, question round-trip, budgets, crash replay).
- Live slice smoke (real SDK agents, subscription auth): question parked 8s →
  answered → session resumed with context intact → in-scope write recorded →
  gate passed → rebased, ff-merged onto the base branch. Concurrent stray
  agent: escalation raised, denial delivered, agent adapted. 17/17.
- Live merge-conflict smoke: 6/6, no silent merges.
- Webview verified in Chromium against reducer-folded fixture state (all four
  tabs, both themes, keyboard answer path); real-VS-Code integration run
  covers activation, init idempotence, panel open/reopen, collision report.
