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
