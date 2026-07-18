# Argus

A cockpit for a multi-agent Claude Code fleet, as a VS Code extension.

**Files are the contract.** Agents write their state to disk
(`STATUS.json` per task, one markdown file per question); Argus renders
that state in an activity-bar view and a status bar item. When an agent
needs a human decision, it drops a question file into a queue folder —
Argus toasts you, shows the options as radio buttons, and writes your
answer back as a checkbox edit (`- [ ]` → `- [x]`) that the asking agent
polls for. Argus never runs agents, and it never moves, renames, or
deletes their files.

The full file contract lives in `SPEC.md` (`spec: 1`).

## What you get

- **Fleet tree** (eye icon in the activity bar): every task with phase,
  a unicode progress bar, model, and blocked/finished markers; every open
  question, oldest first. Clicking a task opens its `PROGRESS.md`;
  clicking a question opens the answer panel.
- **Answer panel**: the question's context rendered as markdown (with
  screenshots), options as a radio group with the recommended choice
  preselected, and a notes box. Submit edits the file in place,
  byte-preserving — the agent wakes on its next poll (≤15s).
- **Status bar**: `👁 3▶ 1❓` — active tasks and unanswered questions at
  a glance; hover lists blocked tasks; click focuses the fleet view.
- **Toasts** when a new question arrives while VS Code is open.

## Install

```
code --install-extension argus-0.1.0.vsix
```

Build the .vsix yourself with:

```
npm install
npx @vscode/vsce package --allow-missing-repository
```

## Development (F5 loop)

1. `npm install`
2. Open this folder in VS Code and press **F5** — a second window starts
   with Argus loaded (the launch config compiles first).
3. In that window, open any workspace containing `.scratch/fleet/` or
   `workflow/queue/` and watch the view populate.

`npm run compile` typechecks (strict) and bundles to `dist/extension.js`
via esbuild; `npm test` runs the pure-logic unit suite under `node:test`
(no VS Code host needed); `npm run watch` rebuilds on change.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `argus.stateRoot` | `.scratch/fleet` | Where agents write machine state (`tasks/*/STATUS.json`, `watchdog/sweep.json`) |
| `argus.questionRoot` | `workflow` | The human question queue (`queue/*.md`, `resolved/`, `assets/`) |

Both are workspace-relative. Single-folder workspaces are the target; in a
multi-root workspace Argus uses the first folder containing either root.

## Adopting Argus in a project

Have your agents write the two file shapes described in
`SPEC.md`: a `STATUS.json` per task under
`<stateRoot>/tasks/<id>/`, rewritten at every phase transition, and a
front-matter + Context/Options/Notes markdown file per question under
`<questionRoot>/queue/`. The asking agent polls its question file for
`[x]` and archives it to `<questionRoot>/resolved/` once consumed. That's
the whole integration — no sockets, no RPC, no extension API.
