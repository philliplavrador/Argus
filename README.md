# Argus

**Run several Claude Code agents on one large repository at the same time —
parallel where the work is separable, serial where it isn't — without them
corrupting each other's work, and answer all of their questions from one
place.** A VS Code extension built on the Claude Agent SDK.

## Argus is for big repos

This is not a general-purpose Claude wrapper. Argus is built for repositories
large enough that three things are true at once:

- **The work is genuinely separable.** There are parts of the tree you can
  change without touching other parts. In a small project there is no separable
  work, so there is nothing to parallelize — one agent in one terminal is
  strictly better, and you should use that instead.
- **Orientation is expensive.** In a large tree, an unscoped agent burns real
  time and tokens working out where things live before it edits anything.
  Scoping an agent to a subtree isn't only a safety mechanism — it makes each
  agent faster and cheaper, because it skips the archaeology.
- **You can't hold it all in your head.** You cannot personally predict whether
  the billing task and the auth task will collide in some shared utility three
  directories away. That's the part Argus is meant to know for you.

If your project is forty files, Argus will cost you more than it saves.

## The two problems it actually solves

**Agents that wander out of their lane.** When you launch "fix billing
rounding" and "add OAuth," you already know those are disjoint — you picked
them. What you can't predict is one agent deciding, forty minutes in, that it
needs to refactor a shared utility the other agent is also rewriting. Argus
runs every task in its own git worktree and checks every write against the
task's declared scope at the moment it happens. A write outside scope doesn't
silently fail and doesn't silently succeed — it becomes a one-click decision in
your inbox, with a warning when the path overlaps another live task's scope.
(In the overnight verification run, this guard caught an agent trying to write
into the primary checkout by absolute path. That is the class of accident it
exists for.)

**Agents that block and nobody notices.** Parallel agents die from unattended
blocking far more often than from file collisions. Three agents in three
terminals means one has been parked on a question for eleven minutes while you
were heads-down elsewhere. In Argus every agent's question lands in one
keyboard-driven inbox; a ★ appears on the task the second it blocks, the item
shows exactly how long the agent has been waiting, and answering resumes the
agent *in its existing session with full context* — the mechanism holds the
agent's tool call open rather than restarting anything.

Three to four concurrent agents is where one person saturates — every agent
eventually needs a decision and you answer them serially. Argus is built for
that number, not for forty.

## What a task gets

- **Its own git worktree** (`.argus/worktrees/<id>`, branch `argus/<id>`) with
  the repo's dependencies installed (~7 seconds on a warm npm cache).
- **A declared write scope** (globs). Inside: recorded. Outside: escalated.
- **Verify gates** — commands that must exit 0 in the worktree before the task
  can merge. A failing gate is a decision (send back / override / abandon),
  not a sentence in a prompt.
- **A serialized merge queue** — one task merges at a time: rebase onto your
  branch, re-run the gates (this catches *semantic* conflicts, which worktrees
  cannot prevent), fast-forward merge, clean up. A rebase conflict surfaces as
  an inbox item; nothing is ever resolved silently.
- **Live telemetry** — phase, current tool activity, elapsed, token/cost
  estimates, honest progress (a real fraction when the agent declares steps,
  never a fake-advancing bar).

## Using it

1. Open a git repository in VS Code, run **Argus: Open Fleet Panel** (the eye
   button in the editor title bar, or the command palette). First open
   scaffolds `.argus/` and adds its state directories to `.gitignore`.
2. **New task** → title, prompt, scope globs, model, effort, verify command,
   budget. Tasks run concurrently up to the configured cap.
3. Watch the Fleet tab; answer from the Inbox tab (`j`/`k` move, `1`–`9`
   choose, `Enter` answers). The Timeline tab is the event log made visible.
4. When a task is READY, **Merge now** (or enable auto-merge).
5. **Argus: Collision Report** shows how often agents actually strayed and
   whether concurrently-running tasks ever touched the same files — the
   measurement that decides whether a conflict-aware scheduler is ever worth
   building.

Settings live in `.argus/config.json` (committed, shared with your team) and
are edited from the Settings tab — including the fleet-wide dual controls:
verbosity and pushback change both the agents' instructions *and* what the
permission layer escalates, and the tab shows the exact system-prompt text
they produce. Nothing about settings is magic.

## What closing things does (honesty section)

- **Closing the panel costs nothing.** The orchestrator lives in the extension
  host; the panel is a pure view. Reopen it and it re-renders from a snapshot.
  This deliberately deviates from "as long as the tab is open, it's running" —
  an accidental Ctrl+W must never destroy in-flight work.
- **Closing the VS Code window ends the agents.** They are child processes;
  no setting can keep them alive, so Argus doesn't offer a fake one. On the
  next start, the event log replays, interrupted tasks are marked honestly
  (worktrees preserved), and leftover worktrees are offered for cleanup.
- **Bash is not path-checked.** ScopeGuard enforces the write tools
  (Edit/Write/NotebookEdit); a shell redirect can bypass it. Every Bash
  command is still logged, and destructive command shapes escalate under the
  `balanced`/`consult` pushback levels.
- **Costs are client-side estimates**, and on a subscription they draw down
  usage rather than dollars.

## Install / develop

```
npm install
npm run compile          # strict typecheck + esbuild (extension + webview)
npm test                 # 243 tests under node:test, no VS Code host needed
npx @vscode/vsce package # build the .vsix
```

Press **F5** in VS Code for a dev host. `SPEC.md` is the architecture
contract; `.argus-build/` holds the overnight build's spike reports, smoke
harnesses, and verification screenshots.

## License

MIT
