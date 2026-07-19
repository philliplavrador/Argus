# Overnight build state — Argus v2

- **Wall-clock start:** 2026-07-18 17:13 (UTC-7). **Now:** 18:10 — 57 minutes in. Window to 05:13.
- **Branch:** `v2`, pushed through d78ce81 (+ vsix + docs pending final commit).

## Resume protocol ("resume overnight")
1. FIRST: `git -C "D:/Projects/Kosik's Kiosk" status --porcelain` → exactly ` M .claude/settings.json`, branch `feat/restructure`.
2. This file → `git log --oneline v2` → decisions.md. Tree wins.
3. Continue from **Next action**. Never re-run spikes/smokes already recorded. Ask nothing.

## Phase status — EVERYTHING THROUGH PACKAGING IS DONE AND VERIFIED
- Spikes: 4/4 PASS (committed). Pure core, shell, orchestrator, extension, four tabs: committed.
- 243 unit tests green (`npm test`). `npm run compile` clean.
- **Live slice smoke PASSED 17/17** (`node .argus-build/smoke/smoke-slice.cjs <fixture>`): real agents, question parked 8s → resumed with context → gate → merge onto base. First run caught a real scheduler race (fixed, decision D13, pinned in orchestrator.test.ts).
- **Live merge-conflict smoke PASSED 6/6** (`node .argus-build/smoke/smoke-conflict.cjs <fixture>`).
- **Chromium UI harness verified** — 6 screenshots in `.argus-build/screenshots/`.
- **Real VS Code integration PASSED 14/14** (`node .argus-build/integration/run.cjs`) after fixing a packaging-fatal import.meta.url bug (esbuild shim).
- **argus-2.0.0.vsix packaged (367KB) and install-verified in the sandboxed VS Code** (never the author's).
- SPEC.md + README.md rewritten for v2 (committed d78ce81).

## In flight RIGHT NOW
- **Adversarial review workflow `wf_22caf8ca-c76`** (task wqk5eub4x): 4 Opus breakers over orchestrator / agentrunner / core+UI / windows-edges, findings then refuted by 2 skeptics each. If resuming after death: read the journal in the transcript dir; act only on findings marked surviving; then proceed to Next action.

## Next action (after the review returns)
1. Fix confirmed findings (if any), re-run `npm test` + the affected smoke, commit.
2. `git rm PLAN.md`.
3. Kiosk read-only verification, output verbatim into REPORT.md.
4. Write `.argus-build/REPORT.md` per PLAN §0.10, final commit + push. Stop cleanly.

## Verified vs unverified (for the report's honesty section)
- Everything in "Phase status" above is verified by observation (tool output in this session).
- Honest partials: 2 concurrent live agents demonstrated (not 3); live window-kill crash test not performed (crash semantics unit-tested + integration-observed via replay); verbosity/effort behavioral deltas shown via prompt preview, not A/B agent runs; eye button contributed but never physically clicked (command path verified).
