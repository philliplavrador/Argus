# Argus

**Run several Claude Code agents on one large repository at the same time —
parallel where the work is separable, serial where it isn't — without them
corrupting each other's work.** A VS Code extension.

## Argus is for big repos

This is not a general-purpose Claude wrapper. Argus is built for repositories
large enough that three things are true at once:

- **The work is genuinely separable.** There are parts of the tree you can change
  without touching other parts. In a small project there is no separable work, so
  there is nothing to parallelize — one agent in one terminal is strictly better,
  and you should use that instead.
- **Orientation is expensive.** In a large tree, an unscoped agent burns real
  time and tokens just working out where things live before it edits anything.
  Scoping an agent to a subtree isn't only a safety mechanism — it makes each
  agent faster and cheaper, because it skips the archaeology.
- **You can't hold it all in your head.** You cannot personally predict whether
  the billing task and the auth task will collide in some shared utility three
  directories away. That's the part Argus is meant to know for you.

If your project is forty files, Argus will cost you more than it saves.

## The two problems it actually solves

**Agents that wander out of their lane.** When you launch "fix billing rounding"
and "add OAuth," you already know those are disjoint — you picked them. What you
can't predict is one agent deciding, forty minutes in, that it needs to refactor
a shared utility the other agent is also rewriting. Argus runs every task in its
own git worktree and checks each write against the task's declared scope at the
moment it happens. A write outside scope doesn't fail silently and doesn't
silently succeed — it becomes a decision you make in one click.

**Agents that block and nobody notices.** Parallel agents die from unattended
blocking far more often than from file collisions. Three agents in three
terminals means one of them has been parked on a question for eleven minutes
while you were heads-down in another window. Argus gives every agent one shared
inbox: a ★ appears on the task, you answer from a single keyboard-driven queue,
and the agent resumes in its existing session with full context.

Realistically, three to four concurrent agents is where one person saturates —
every agent eventually needs a decision, and you answer them serially. Argus is
built for that number, not for forty.

## Status

**Shipped today (v0.1)** — a passive viewer. Agents write state files
(`STATUS.json` per task, one markdown file per question); Argus renders them in
an activity-bar tree and a status bar item, and writes your answers back as
checkbox edits the agent polls for. It never runs agents. The file contract is
in `SPEC.md`.

**In progress (v2)** — Argus takes ownership of the agent processes via the
Claude Agent SDK, which makes the file-polling protocol unnecessary: worktree
isolation per task, scope enforcement at write time, a single live inbox, a
webview cockpit with per-task progress and spend, model/effort/verbosity/pushback
settings, and a serialized merge queue that rebases and verifies before
integrating. The build plan is in `PLAN.md`, which is deleted when v2.0 lands.

v2 deliberately ships *without* a conflict-aware scheduler. That feature is gated
on measurement: v2.0 instruments every path each agent touches, and the scheduler
gets built only if the observed collision rate justifies it. Guessing at it first
would mean building the most expensive module in the project on an assumption.

## Install

```
code --install-extension argus-0.1.0.vsix
```

Build it yourself:

```
npm install
npx @vscode/vsce package --allow-missing-repository
```

## Development

1. `npm install`
2. Open this folder in VS Code and press **F5** — a second window starts with
   Argus loaded.
3. Open any workspace containing `.scratch/fleet/` or `workflow/queue/`.

`npm run compile` typechecks (strict) and bundles via esbuild; `npm test` runs
the pure-logic suite under `node:test` with no VS Code host; `npm run watch`
rebuilds on change.

## Settings (v0.1)

| Setting | Default | Meaning |
|---|---|---|
| `argus.stateRoot` | `.scratch/fleet` | Where agents write machine state |
| `argus.questionRoot` | `workflow` | The human question queue |

Both workspace-relative. Single-folder workspaces are the target; in a multi-root
workspace Argus uses the first folder containing either root.

## License

MIT
