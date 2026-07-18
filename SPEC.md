# Argus file contract

```
spec: 1
```

This document is the canonical contract between a multi-agent Claude Code
fleet and Argus. **Files are the contract**: agents write state files to
disk; Argus only reads state and writes answers. Argus never runs agents,
and never moves, renames, or deletes any fleet file.

## Roots

Two roots inside the consuming workspace, both configurable via VS Code
settings:

| Setting | Default | Contents |
|---|---|---|
| `argus.stateRoot` | `.scratch/fleet` | Machine state written by agents |
| `argus.questionRoot` | `workflow` | Human-facing question queue |

Single-folder workspaces are the target. In a multi-root workspace, Argus
uses the first folder containing either root.

## Task state — `<stateRoot>/tasks/*/STATUS.json`

One file per task, rewritten in full by its agent at every transition:

```json
{
  "id": "supplier-dedupe-rule",
  "title": "Dedupe supplier rows on catalog number",
  "phase": "BUILD",
  "pct": 47, "etaMin": 9,
  "stepsDone": 2, "stepsTotal": 5,
  "tree": "worktree",
  "branch": "task/supplier-dedupe-rule",
  "agentName": "supplier-dedupe-rule",
  "model": "opus-4-8",
  "startedAt": "2026-07-18T18:11:04Z",
  "updatedAt": "2026-07-18T18:39:51Z",
  "heartbeatAt": "2026-07-18T18:41:12Z",
  "progressToken": "build:resolver:3of5",
  "blockedOn": null,
  "locks": [], "lease": ["app/backend/lib/suppliers/**"],
  "lastEvent": "3 of 5 resolvers rewritten; unit suite green",
  "acknowledged": false
}
```

### Phases

`phase` ∈ `QUEUED`, `SCOPED`, `LEASED`, `DESIGN`, `BUILD`, `SELF-VERIFY`,
`REVIEW`, `GATE`, `HANDOFF`, `LANDED`, `MERGED`, `PUSHED`, `BLOCKED`,
`FAILED`.

- **`PUSHED`** is terminal-success; **`FAILED`** is terminal-failure.
- **`BLOCKED`** means the task is waiting — see `blockedOn`.
- Every other phase counts as running/live.

### `blockedOn`

`null`, or:

```json
{ "kind": "question" | "lock" | "dependency" | "permission", "ref": "...", "since": "<ISO>" }
```

When `kind` is `"question"`, `ref` is the queue file path **relative to the
workspace root**, e.g. `workflow/queue/supplier-dedupe-rule-match.md`.

### Field semantics

- `model` is optional. **Any field may be missing on a malformed write** —
  consumers must parse defensively and never crash on bad JSON. Argus shows
  an unreadable STATUS.json as `⚠ unparsable` rather than dropping it.
- `acknowledged: true` means the author has dismissed the task; Argus drops
  it from the tree. Finished (`PUSHED`/`FAILED`) rows with
  `acknowledged: false` are **never** hidden or auto-removed — dismissal
  happens elsewhere; Argus just renders.
- All timestamps are ISO-8601 UTC.
- `PROGRESS.md`, if present as a sibling of STATUS.json, is the task's
  human-readable progress log; clicking a task row opens it (falling back to
  the STATUS.json itself).

## Watchdog sweep — `<stateRoot>/watchdog/sweep.json` (optional)

```json
{ "openFindings": [ { "taskid": "...", "detector": "...", "tier": 3 } ] }
```

If a task has a finding with `tier >= 3`, Argus appends the detector name
(upper-cased) as a `⚠ DETECTOR` warning suffix on the task row. Malformed
sweeps are ignored.

## Questions — `<questionRoot>/queue/*.md`

Front-matter plus three sections:

```markdown
---
task: supplier-dedupe-rule
agent: supplier-dedupe-rule
title: Match duplicate suppliers on catalog number or name?
blocking: true
asked: 2026-07-18T18:12:00Z
---

## Context
One short paragraph. May embed images with paths relative to this file,
e.g. ../assets/<taskid>-<slug>/shot-1.png

## Options
- [ ] **Catalog #** — exact, no false merges *(recommended)*
- [ ] **Name** — catches typo'd catalog numbers
- [ ] **Both** — merge only if both agree

## Notes
```

- Front-matter keys are flat strings/booleans (`true`/`false`).
- Options are `- [ ]` checkboxes; at most one is marked `*(recommended)*`.
- `## Notes` is free text the author may add when answering.

## The answer contract

The author (through Argus or by hand) ticks **exactly one** `- [ ]` →
`- [x]` and optionally writes free text under `## Notes`, then saves. The
asking agent polls the file for `\[x\]` (or the file's disappearance).

Therefore any tool writing an answer MUST:

1. Flip only the chosen checkbox's state character (` ` → `x`).
2. Insert the notes text under `## Notes` and nothing else.
3. Preserve every other byte of the file — line endings included (files may
   be CRLF on Windows), BOM included.

And MUST NOT move, rename, or delete a queue file. The **asking agent**
archives the file to `<questionRoot>/resolved/` after consuming the answer.

A file that already contains `[x]` is answered: render it read-only with the
recorded choice highlighted.

## What Argus renders (informative)

- **Tree** (activity bar, `eye` icon): a Tasks group (one row per
  non-acknowledged STATUS.json — label `id`, description
  `PHASE ▕████░░░░▏47% · model`, `⏸ BLOCKED · kind`, `✓ PUSHED`,
  `✗ FAILED`, or `⚠ unparsable`; sorted running → blocked → finished, by
  `startedAt` within each) and a Questions group (one row per queue file,
  oldest first by `asked`).
- **Watcher**: both roots watched for create/change/delete; refresh is
  debounced ~300 ms; also refreshes when the settings change.
- **Toast** on a queue file created while the window is open (never for
  pre-existing files): *Fleet question: <title>* with Answer / Later.
- **Answer panel**: Context rendered as markdown (bundled markdown-it,
  strict CSP, relative images resolved against the file), Options as a
  radio group in file order with the recommended one marked and
  preselected, Notes prefilled, Submit performing the answer contract via
  the workspace fs API. After a successful write: "Answered — the team
  wakes on its next poll (≤15s)."
- **Status bar**: `$(eye) N▶ M❓` — N tasks in non-terminal phases, M
  unanswered queue files; click focuses the Argus view; tooltip lists
  blocked tasks.

## Versioning

This is `spec: 1`. Breaking changes to file shapes or the answer contract
bump the number; Argus releases state which spec versions they consume.
