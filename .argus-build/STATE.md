# Overnight build state — Argus v2

- **Wall-clock start:** 2026-07-18 17:13 (UTC-7). 12h window ends ~05:13; build stops ~03:13.
- **Last updated:** 2026-07-18 18:12 (UTC-7) — ~1h in.
- **Branch:** `v2`, pushed through dca6cb3 (+ pending 5b commit).

## Resume protocol ("resume overnight")
1. FIRST: `git -C "D:/Projects/Kosik's Kiosk" status --porcelain` → exactly ` M .claude/settings.json`, branch `feat/restructure`.
2. This file → `git log --oneline v2` → decisions.md. Tree wins over this file.
3. Continue from **Next action**. Never re-run spikes. Ask nothing.

## Fixture
- Clone at `<scratchpad>\kiosk-fixture` (Spike C mutated it and restored it clean on feat/restructure). Original READ-ONLY.

## Phase status
- **Phase 0 spikes: DONE, all four PASS** (committed 618e1be). Key: canUseTool inbox works (answers via updatedInput, no bare allowedTools); concurrency default 4 max 8; worktrees need core.longpaths + kill-then-force removal; UI batch 50ms.
- **Phase 1 contracts: DONE** (137ef8e + additions).
- **Phase 2 pure core: DONE, verified by me** (2deaf7c).
- **Phase 3 shell: DONE, verified by me** — 235/235 tests green (dca6cb3). AgentRunner reviewed line-by-line.
- **Phase 5a spine: DONE** (e12e81a) — orchestrator, gates, panel, webview skeleton, dual esbuild.
- **Phase 4 tabs: RUNNING in background** — workflow `wf_85c499e3-125` (task w4crlt37s), 4 Opus agents on tabs/{fleet,inbox,timeline,settings}. Settings already landed on disk.
- **Phase 5b: JUST FINISHED (uncommitted at last write)** — new extension.ts (activation, init scaffolding, panel host intents, status bar, collision report command), package.json v2.0.0 manifest, v0.1 sources deleted (tree/panel/statusbar/model/lib + 3 old test files), markdown-it dependency dropped. Typecheck green.

## Verified vs unverified
- Verified by observation: all committed tests (235 passing when last run by me); dual esbuild builds; typecheck green after v0.1 deletion.
- Written-but-unverified: extension.ts activation (never launched in a VS Code host yet); orchestrator task lifecycle (no live agent run through it yet); panel/webview rendering (never opened); everything Phase 4 agents are writing.

## Next action
1. Commit Phase 5b (extension.ts + package.json + deletions) — files: src/extension.ts, src/host/panel.ts, package.json, package-lock.json + staged deletions.
2. When Phase 4 workflow completes: typecheck + esbuild + review the four tabs, commit.
3. Phase 6a: launch the F5 dev host against a THROWAWAY test repo (NOT the Kiosk original; use a fresh scratch clone of the fixture) and drive the slice live: create task → worktree → agent → ★ → answer → resume → verify → merge. Use Playwright/chrome-devtools if the webview is drivable, else drive orchestrator headless via a node script first (orchestrator is fully injectable — a headless smoke can run without VS Code).
4. Then acceptance criteria sweep (§13), REPORT.md.

## Half-done / must finish or revert
- Phase 4 workflow in flight (`wf_85c499e3-125`). If dead: check src/webview/tabs/*.ts on disk; resume the workflow or finish tabs by hand.
- Nothing else half-done.
