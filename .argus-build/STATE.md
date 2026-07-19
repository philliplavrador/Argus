# Overnight build state — Argus v2

- **Wall-clock start:** 2026-07-18 17:13 (UTC-7). 12h window ends ~05:13; build stops ~03:13 for integration/verification/report.
- **Last updated:** 2026-07-18 17:38 (UTC-7)
- **Branch:** `v2`, pushed. Commits so far: 245835a (scaffolding), 137ef8e (core types).

## Resume protocol (fresh session, "resume overnight")
1. FIRST verify the Kiosk source untouched:
   `git -C "D:/Projects/Kosik's Kiosk" status --porcelain` → exactly ` M .claude/settings.json`, branch `feat/restructure`.
2. Read this file → `git log --oneline v2` → `.argus-build/decisions.md`.
3. Trust the working tree over this file.
4. Continue from **Next action**. Do not re-run recorded spikes. Ask nothing.

## Fixture
- Clone at `C:\Users\phill\AppData\Local\Temp\claude\d--Projects-Argus\0636ba7b-5673-4655-ba57-197243db7acd\scratchpad\kiosk-fixture` (feat/restructure, clean, 443 files). Original is READ-ONLY forever.

## Pre-flight (verified live before go-word)
- SDK 0.3.214 + CLI 2.1.214 + Node 22.19.0; query() end-to-end on subscription auth 2.9s/$0.052 (haiku). Author confirmed: no permission prompts, login holds, machine stays awake.

## Phase status
- **Phase 0 spikes: RUNNING in background.** Workflow run `wf_f2ad55bf-4e4` (task wr8cpfnjs), 4 Opus agents → `.argus-spikes/{A-concurrency,B-canusetool,C-worktrees,D-ui-throughput}.md`. BARRIER: read all four before Phase 3 briefs are final.
- **Phase 1 types: DONE (verified: `npm run typecheck` clean, commit 137ef8e).** `src/core/types.ts` is the immutable contract for all fan-out agents.
- **Phase 2 pure core: RUNNING in background.** Workflow run `wf_e6dab8e9-332` (task ws9tebo0e), 3 Opus agents writing reducer/scope/profile + tests. Launched before the spike barrier deliberately (decision D4).
- Phases 3–7: not started.

## Verified vs unverified
- Verified by observation: pre-flight SDK spawn; types.ts typechecks clean.
- Written-but-unverified: nothing (Phase 2 agent output not yet reviewed/run by me).

## Spike results
- (none returned yet)

## Next action
Wait for the two background workflows. On spike completion: read all four reports, update decisions.md, adjust types/constants if contradicted. On Phase 2 completion: run `npm run typecheck` + full `npm test` myself, review the three modules, commit as `feat(core)`. Then write Phase 3 briefs (AgentRunner/WorktreeManager/EventLog) incorporating spike B/C findings and launch Phase 3.

## Half-done / must finish or revert
- Two background workflows in flight (ids above). If resuming after death: check `.argus-spikes/*.md` and `src/core/{reducer,scope,profile}.ts` on disk to see what actually landed; workflow results are also in the journal at the transcript dirs recorded in this file's git history.
