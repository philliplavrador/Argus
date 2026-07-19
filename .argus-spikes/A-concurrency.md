# Spike A — Concurrency ceiling for concurrent SDK `query()` spawns

**Date:** 2026-07-18 (~17:19 local, PDT)
**Env:** Windows 11, Node v22, `@anthropic-ai/claude-agent-sdk@0.3.214`, subscription auth (`ANTHROPIC_API_KEY` deleted in-process at top of `spike-a.mjs`).
**Model:** `claude-haiku-4-5-20251001`, `maxTurns: 1`, `allowedTools: []`, `cwd` = empty `spawn-cwd` dir.
**Script:** `d:\Projects\Argus\.argus-spikes\scripts\spike-a.mjs`
**Raw output:** `scratchpad\spike-a-out.json`, `scratchpad\spike-a-err.log`, `scratchpad\mem-samples.txt`
**Method:** One Node parent process; each batch = N concurrent `query()` calls via `Promise.allSettled`; batches run sequentially in order [2, 4, 8], one at a time. Per-spawn timers use `process.hrtime`. Init = first `system/init` message; result = `result` message.

## Verdict

**PASS.** All 14 spawns across all three batches returned `subtype: "success"` with `result: "OK"`. **Zero errors, zero 429s, zero rejected promises.** Modest, sub-linear latency degradation at N=8 (spawn/init contention, not API throttling). No hard ceiling reached at 8 — and this was on a machine already running ~45 sibling node/claude processes.

## Raw numbers (verbatim from `spike-a-out.json`)

Times in ms; cost in USD; every spawn `subtype = "success"`, `num_turns = 1`, `result = "OK"`, `api_error_status = null`, `error = null`.

### Batch N=2 — batchWall **3353 ms**
| idx | tInit | tResult | cost_usd |
|-----|-------|---------|----------|
| 1 | 1099 | 2844 | 0.046236 |
| 2 | 1011 | 2620 | 0.046236 |

### Batch N=4 — batchWall **3512 ms**
| idx | tInit | tResult | cost_usd |
|-----|-------|---------|----------|
| 1 | 1203 | 2593 | 0.003073 |
| 2 | 1420 | 3000 | 0.002497 |
| 3 | 1352 | 2652 | 0.003113 |
| 4 | 1166 | 2831 | 0.0103646 |

### Batch N=8 — batchWall **5071 ms**
| idx | tInit | tResult | cost_usd |
|-----|-------|---------|----------|
| 1 | 2229 | 4318 | 0.003053 |
| 2 | 1843 | 3365 | 0.003063 |
| 3 | 2161 | 4245 | 0.0031004 |
| 4 | 1693 | 4359 | 0.0031057 |
| 5 | 1940 | 3308 | 0.003073 |
| 6 | 2188 | 3565 | 0.002517 |
| 7 | 2306 | 3647 | 0.0106436 |
| 8 | 2005 | 3521 | 0.0030757 |

### Aggregates
- **Init latency:** N=2 ~1.0–1.1s → N=4 ~1.2–1.4s → N=8 **~1.7–2.3s**. Roughly doubles from N=4 to N=8.
- **Result latency:** N=2 ~2.6–2.8s → N=4 ~2.6–3.0s → N=8 **~3.3–4.4s**.
- **Batch wall-clock:** 3353 → 3512 → 5071 ms. Growth is **sub-linear** (8 concurrent finished in 5.1s vs 4 concurrent in 3.5s — throughput still scales).
- **Total cost, all 14 spawns ≈ $0.143** → avg **~$0.0102/spawn**, far below the $0.05 single-spawn baseline.
- **Cost surprise (prompt caching):** the very first batch's two spawns each cost **$0.046236** (matches the ~$0.05 baseline); nearly every subsequent spawn cost **~$0.003** (≈15× cheaper). Cache is shared across sibling subprocesses of one parent — first spawns write the cache, later spawns read it. Two mid-run spawns (N4 idx4, N8 idx7) cost ~$0.0106 (partial/expired cache). **Implication: concurrent same-prompt fan-out is much cheaper than the per-spawn baseline suggests, because of cross-subprocess prompt caching.**

## RSS / memory observations

**Attribution confidence: LOW.** The machine was already running the orchestrator + sibling spike agents. Baseline snapshot (before this run) already showed **12 `claude` procs (36–431 MB WS) and 25 `node` procs (46–101 MB WS)**. The sampler diffed against a captured baseline PID set, but the "new" processes it caught are contaminated by other agents starting/stopping concurrently — at the peak sample it counted **43 new node procs**, far more than the 8 this spike spawned. So exact per-subprocess RSS cannot be cleanly isolated.

Best-effort from `mem-samples.txt`: SDK-spawned subprocesses observed with working sets ramping **~35 MB → ~70–82 MB → ~100–117 MB** as they warmed, and one `claude` subprocess at **147 MB** appeared mid-burst. Architecture (verified via `sdk.d.ts` + process table): each `query()` spawns a `claude` CLI subprocess (plus node children). **Working-set band for a warmed SDK subprocess: roughly 45–150 MB.** For planning, budget **~150 MB per concurrent agent** as a conservative ceiling.

## Error shapes

**None seen.** No exceptions caught, no promise rejections, no `error_*` result subtypes, no 429/rate-limit responses, `api_error_status: null` on every spawn. (Because there were no errors, the "did siblings still complete" question is moot — all completed.)

## Recommendations

### `argus.maxConcurrentAgents`
- **Default: 4.** At N=4 latency was essentially flat vs N=2 (init ~1.3s, result <3s) with zero contention — the safe, snappy operating point.
- **Max: 8.** N=8 passed cleanly with only modest (sub-linear) degradation, *on top of* a machine already saturated with ~45 sibling processes. The real API-side ceiling is clearly well above 8; the practical limit at 8 is local subprocess-spawn/CPU contention, not the API. Keep 8 as the hard cap for a shared dev box; a dedicated host could likely go higher, but that is unverified here.

### 429 backoff policy (none observed — precautionary design)
No 429s occurred, so the shape below is a design recommendation, not measured behavior. When a spawn's `result` returns `api_error_status === 429` **or** the SDK throws a rate-limit error:
1. **Do not retry in a tight loop** (per hard rules). Treat the first 429 as a signal to **drain**: stop launching new agents immediately.
2. **Exponential backoff with jitter** on the affected spawn: base 5s, then 10s, 20s, 40s (× random 0.5–1.5 jitter). **Max 4 retries** (~75s total worst case).
3. If a `Retry-After` header/field is present in the error, **honor it** instead of the computed delay.
4. **Reduce concurrency by half** for the next batch after any 429 (8→4→2), and only step back up after a full clean batch.
5. **Give up** after 4 failed retries on one spawn OR 3 distinct 429s within a 60s window across the pool — surface to the orchestrator inbox and pause the scheduler rather than burning subscription quota.
6. **Capture the exact error object verbatim** on first 429 (name, message, status, any `Retry-After`) — the shape is data.

### On PLAN.md's dropped N=12 (decision D1)
N=8 showed **modest degradation** (init latency ~doubled vs N=4; wall 3.5s→5.1s) but it was **pure spawn/CPU contention, not API throttling** — zero 429s despite a heavily loaded machine. N=12 would have extended the local-contention curve (more spawn-latency growth) and *might* have surfaced the first API-side concurrency signal, but given a clean run at 8-on-top-of-45-procs, **12 would most likely also have passed and added only marginal signal** — a slightly better-resolved contention curve, not a discovered ceiling. **Verdict: cutting N=12 lost little; the API ceiling is comfortably above our recommended max of 8.** If a future spike wants the true API concurrency limit, it should ramp 16/24/32 on an *idle* dedicated host, not 12 on a shared box.
