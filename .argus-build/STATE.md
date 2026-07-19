# Overnight build state — Argus v2

- **Wall-clock start:** 2026-07-18 17:13 (UTC-7). 12h window ends ~05:13; build stops ~03:13 for integration/verification/report.
- **Last updated:** 2026-07-18 17:16 (UTC-7)
- **Branch:** `v2` (created from `main` @ 0a9f8d3). `main` untouched all night.

## Resume protocol (for a fresh session after "resume overnight")
1. FIRST: verify the Kiosk source repo untouched:
   `git -C "D:/Projects/Kosik's Kiosk" status --porcelain` → must show exactly ` M .claude/settings.json`, branch `feat/restructure`.
2. Read this file, then `git log --oneline v2`, then `.argus-build/decisions.md`.
3. Trust the working tree over this file if they disagree.
4. Continue from **Next action** below. Do not re-run recorded spikes. Ask nothing.

## Fixture
- Kiosk fixture cloned (--no-hardlinks) to:
  `C:\Users\phill\AppData\Local\Temp\claude\d--Projects-Argus\0636ba7b-5673-4655-ba57-197243db7acd\scratchpad\kiosk-fixture`
  On `feat/restructure`, clean, 443 files. The source's uncommitted `.claude/settings.json` change is NOT in the clone (expected; work around in the clone if ever needed).
- The ORIGINAL at `D:/Projects/Kosik's Kiosk` is READ-ONLY. Never a cwd, never passed to agents, never written.

## Pre-flight (verified live 17:05–17:10, before go-word)
- SDK `@anthropic-ai/claude-agent-sdk@0.3.214` installed in repo; CLI 2.1.214; Node 22.19.0.
- `query()` end-to-end on subscription auth (ANTHROPIC_API_KEY unset): init→result 2.9s, haiku, cost $0.052, modelUsage present. Script: scratchpad/sdk-preflight.mjs.
- Author confirmed: session won't prompt for permissions; login holds overnight; machine stays awake.

## Phase status
- **Phase 0 (spikes): IN PROGRESS** — about to launch 4 spike agents (A concurrency, B canUseTool hold, C worktrees, D UI throughput) via Workflow, results to `.argus-spikes/`.
- Phases 1–7: not started.

## Verified vs unverified
- Verified by observation: SDK spawn works (see pre-flight above); fixture clone clean on feat/restructure.
- Written-but-unverified: nothing yet.

## Spike results
- (none yet)

## Next action
Launch the Phase 0 spike workflow (4 parallel agents, Opus 4.8, writing to `.argus-spikes/A-concurrency.md` etc.), then draft `src/core/types.ts` while they run. Barrier: read all 4 spike reports before finalizing Phase 1 types.

## Half-done / must finish or revert
- Nothing in flight.
