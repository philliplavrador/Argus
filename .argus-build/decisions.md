# Overnight decisions — Argus v2

One entry per decision, newest last. Format: what · why · what would justify revisiting.

## D1 — Spike A runs 2/4/8 concurrent spawns, not 2/4/8/12
PLAN §8 lists 12, but §4.0 establishes per-spawn cost is the dominant constant and warns against "spawn 12 agents to see what happens"; the product's practical cap is 3–4 concurrent (§6.1) with a settings max around 6. 8 already exceeds any real cap. Saves ~12 spawns of subscription usage.
Revisit if: 8 shows no degradation at all and the ceiling question stays open.

## D2 — Spike agents run on claude-opus-4-8, not fable-5
Spike work is empirical scripting (write node script, run, record numbers), not contract design. §0.5 reserves Fable for architecture/contracts/integration/verification; Opus is the step-down that is "still excellent." Conserves Fable usage for the long night.
Revisit if: a spike agent visibly misreads results — rerun that spike's analysis on Fable.

## D3 — Spike D (UI throughput) measured in headless Chromium, not a real VS Code webview
No way to drive a real webview headless overnight. VS Code webviews are Chromium iframes; a Playwright page receiving synthetic postMessage floods and rendering DOM rows is a close proxy for the render-side cost. The number it produces (batching interval) is a config default, cheap to change later.
Revisit if: real-webview testing in Phase 6 shows different behavior.

## D4 — Phase 2 (pure core) launched before the spike barrier
PLAN §8 says read all four spikes before committing to Phase 1. The reducer, scope matcher, and profile detector depend only on types.ts, not on any spike outcome (concurrency ceilings, canUseTool mechanics, worktree timings, and batch intervals all live in the shell). Waiting would idle ~1h of the window. The barrier still gates Phase 3, whose briefs need Spikes B and C.
Revisit if: a spike somehow invalidates a core contract — then the affected module is redone against the corrected types.

## D5 — Crash semantics: a restart fails live tasks instead of resuming them
On replay, an `orchestrator-started` event mid-log marks any then-live task FAILED ("interrupted; worktree preserved") and voids its pending inbox items. SDK sessions are in principle resumable, so a future version could offer "resume interrupted task", but v2.0 keeps recovery honest and simple: state is never silently wrong, worktrees survive for inspection, and acceptance criterion 6 (replay + stale-worktree cleanup) is satisfied.
Revisit when: v2.x adds session-resume UX.

## D6 — Hand-rolled glob subset for scope matching, no dependency
Scope globs support `**`, `*`, `?` only, matched case-insensitively, malformed-glob fails closed (treated as out of scope → escalates). Avoids shipping picomatch into both host and webview bundles and keeps the security-relevant matcher small and exhaustively tested. UI will steer users toward `dir/**` scopes.
Revisit if: real usage needs braces/negation — swap in picomatch behind the same pathInScope signature.
