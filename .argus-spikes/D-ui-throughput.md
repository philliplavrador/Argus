# Spike D — Webview render throughput → Argus state-patch batching interval

**Date:** 2026-07-18
**Decision context:** D3 — no real VS Code webview is drivable headless overnight. VS Code webviews are Chromium, so **headless Chromium (via Playwright MCP) is the accepted proxy.** See *Caveats* — this proxy under-measures the very cost that batching exists to reduce (extension-host↔webview `postMessage` IPC), which only strengthens the batching recommendation.

## Method

- Harness: `.argus-spikes/scripts/spike-d.html` — a synthetic Argus fleet UI: **8 task cards**, each with a rolling tool-call tail (`<pre>`-style `textContent`, default 20-line cap), a progress bar, a tool label, and an elapsed counter.
- A driver generates synthetic events at a configurable **aggregate** rate across the 8 cards in two modes:
  - **naive** — `applyEvent` (DOM write) per event, as events are generated.
  - **batched** — events enqueued; queue flushed every `I` ms via `setInterval`.
- Instrumentation: a `requestAnimationFrame` loop counts frames and flags **long frames (inter-frame Δt > 50 ms)** only during a phase's measurement window. Reported: rolling FPS = frames / phase-seconds, long-frame count, long-frames/s, events processed, achieved throughput.
- A later hardening pass added an optional **forced synchronous reflow** per event (`void tailEl.offsetHeight; void root.offsetHeight;` after each write) — the classic naive-render killer — and much higher aggregate rates, to try to *find* where naive falls over.
- Auto-run sweep on load; results accumulate into `window.__results` (JSON) and `window.__done = true` at the end.
- Served over `http://127.0.0.1:8791/` by `.argus-spikes/scripts/serve.js` because **Playwright MCP blocks the `file:` protocol** (verified error: `Access to "file:" protocol is blocked`). Driven with `browser_navigate` / `browser_evaluate`. `ANTHROPIC_API_KEY` left unset.
- Only console error across all runs: `favicon.ico 404` (harmless).

## Results — Run 1 (spec sweep), all at 60 fps

**Naive, per-event DOM write, tail cap 20 (3 s each):**

| rate (ev/s) | events processed | throughput/s | frames | fps | long frames |
|---|---|---|---|---|---|
| 10   | 30   | 10.0   | 180 | 60.0 | 0 |
| 50   | 150  | 50.0   | 181 | 60.3 | 0 |
| 100  | 300  | 100.0  | 180 | 60.0 | 0 |
| 200  | 600  | 199.8  | 181 | 60.3 | 0 |
| 500  | 1500 | 499.9  | 180 | 60.0 | 0 |
| 1000 | 3000 | 999.8  | 181 | 60.3 | 0 |

**Batched, tail cap 20 (3 s each):**

| rate | I (ms) | events | throughput/s | fps | long frames |
|---|---|---|---|---|---|
| 500  | 16  | 1504 | 499.9 | 60.2 | 0 |
| 500  | 50  | 1500 | 499.9 | 60.3 | 0 |
| 500  | 100 | 1500 | 499.9 | 60.0 | 0 |
| 500  | 250 | 1500 | 499.9 | 60.0 | 0 |
| 1000 | 16  | 3008 | 999.8 | 59.8 | 0 |
| 1000 | 50  | 3000 | 999.7 | 60.0 | 0 |
| 1000 | 100 | 3000 | 999.7 | 60.0 | 0 |
| 1000 | 250 | 3001 | 999.7 | 60.0 | 0 |

**Tail-length cliff probe — batched I=100 @ 1000 ev/s, tail cap 200:**

| rate | I | tail cap | events | throughput/s | fps | long frames |
|---|---|---|---|---|---|---|
| 1000 | 100 | **200** | 3000 | 999.5 | **60.0** | **0** |

→ **No cliff at 200 lines.** 60 fps held.

## Results — Run 2 (stress: trying to break naive)

**Naive, very high aggregate rate, tail cap 20, no forced reflow:**

| rate (ev/s) | events | throughput/s | fps | long frames |
|---|---|---|---|---|
| 2000   | 6003   | 1999.9  | 60.0 | 0 |
| 5000   | 15003  | 5000.0  | 60.0 | 0 |
| 10000  | 30009  | 9999.3  | 60.0 | 0 |
| **20000** | **60014** | **19999.3** | **60.0** | **0** |

**Naive WITH forced synchronous reflow per event (worst-case naive), tail cap 20:**

| rate | events | throughput/s | fps | long frames |
|---|---|---|---|---|
| 200  | 600  | 199.9  | 60.3 | 0 |
| 500  | 1500 | 500.0  | 60.0 | 0 |
| 1000 | 3000 | 999.6  | 60.0 | 0 |
| 2000 | 6001 | 1999.4 | 60.0 | 0 |

**Batched I=100 @ 2000 ev/s WITH forced reflow:** 6000 events, 1992.2/s, **59.8 fps, 0 long frames.**

## Where does naive fall over?

**It does not — not within any rate this spike could drive, and not even with forced synchronous layout per event.** Across 24 phases the *lowest* FPS observed was **59.8** and the long-frame count was **0 in every single phase**, from 10 ev/s up to **20,000 ev/s naive**, and up to **2,000 ev/s naive + forced reflow per event**.

The reason is structural and worth stating plainly: this UI shape (8 cards, ≤200-line `textContent` tails, progress-bar width writes, no per-event heavy layout) has a tiny DOM. The browser **coalesces all DOM writes between paints** — layout/paint runs once per rAF regardless of how many `textContent` assignments happened in the interval — and reflowing 8 small cards costs microseconds. So the fleet UI **is not DOM-render-bound at any plausible Argus event rate.** Batching does not measurably help *webview FPS* here because webview FPS was never the constraint.

## Interpretation — what actually justifies batching

Batching's real payoff is **invisible to this harness** and lives on the axis the headless-Chromium proxy cannot see:

1. **`postMessage` IPC volume.** In real Argus, every state patch crosses the extension-host↔webview boundary with structured-clone serialization. Naive = one `postMessage` per event; at 1000 aggregate ev/s that is 1000 cross-boundary messages/s **per window**, each with handler + serialization overhead. Batching every `I` ms collapses that to `1000/s → 1000/(I ms flushes)`. At I=50 ms that is ~20 messages/s carrying ~50 patches each — a **~50× reduction** in IPC and handler churn. This is the dominant real cost, and it is exactly what this in-page synthetic generator omits.
2. **Main-thread task churn / battery / headroom on weaker hardware.** The dev box here never dropped a frame, but coalescing keeps CPU wake-ups and GC pressure low, preserving headroom for larger fleets and lower-end laptops.
3. **Perceived latency budget.** The flush interval adds at most `I` ms of latency before an event is visible. Keeping `I` under the ~100 ms human "feels instantaneous" threshold means batching is free perceptually.

So the batch interval is chosen on **IPC economy vs. perceived latency**, not on FPS.

## Recommendations

### 1. Default `postMessage` batch interval for Argus: **50 ms** (coalescing flush; ~20 fps of UI updates)

- At 1000 aggregate ev/s, I=50 ms cuts cross-boundary messages from ~1000/s to ~20/s (~50× fewer) while adding ≤50 ms latency — well under the ~100 ms perceptual threshold, so the UI still reads as live.
- Verified to hold 60 fps at 500 and 1000 ev/s in the batched sweep (fps 60.3 / 60.0). I=16 ms also holds 60 fps but wastes the coalescing win (≈3× more IPC than 50 ms for no visible benefit); I=100/250 ms hold 60 fps too and cut IPC further but start to feel less immediate for the fast-moving tool-tail.
- **Guidance:** default **50 ms**; make it configurable. If a very large fleet or a low-end host shows IPC/CPU pressure, raising to **100 ms** is safe and roughly halves IPC again with still-acceptable latency (100 ms held 60 fps at 1000 ev/s).

### 2. Max live-tail lines per task card: **100 lines** (hard cap; 200 is safe but unnecessary)

- No DOM-size cliff was found even at **200 lines** (60 fps, 0 long frames at batched I=100 @ 1000 ev/s). So 200 is *safe on this hardware*.
- However, the tail is a single node whose **entire** string is rebuilt on each flush (`textContent = tail.join('\n')`), so per-update cost and retained memory grow linearly with the cap. **100 lines** keeps that cost and 8×100=800-line total footprint modest while leaving ~2× measured headroom below the 200-line point that still held 60 fps. It is also plenty of scrollback for a live tool tail.
- **Guidance:** cap at **100 lines/card**, drop-oldest. Overflow history (if wanted) belongs in an on-demand full-log view, not the always-rendered live card.

## Caveats

- **D3 proxy caveat (important).** Headless Chromium is a fair proxy for the webview's *rendering engine*, but **not** for the VS Code extension-host↔webview `postMessage` channel. The single most important cost that batching addresses — structured-clone serialization + IPC across that boundary — is **not exercised** by an in-page synthetic event generator. Every number here therefore *understates* the case for batching. FPS-wise, treat "naive is fine to 20k ev/s" as an upper bound of what the renderer can absorb, not as license to skip batching.
- Measured on one dev box (Windows 11, headless Chromium via Playwright MCP). FPS is derived as frames/elapsed over a 3 s window (a rolling average, not a min); no per-frame histogram was captured, but the long-frame counter (Δt > 50 ms) was **0 everywhere**, which rules out sustained stalls.
- The synthetic generator is driven by a 4 ms `setInterval`, so sub-4-ms burst microstructure is smoothed; this matches how a real message-pump batches within a task and is representative, but it is not an adversarial single-frame flood.

## Artifacts

- Harness: `d:\Projects\Argus\.argus-spikes\scripts\spike-d.html`
- Static server: `d:\Projects\Argus\.argus-spikes\scripts\serve.js`
- Raw JSON: embedded in the result tables above (captured from `window.__results`).
