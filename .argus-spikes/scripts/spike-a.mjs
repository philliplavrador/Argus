// Spike A - Concurrency ceiling for concurrent SDK query() spawns from one Node process.
// Ensures subscription auth: ANTHROPIC_API_KEY must be unset.
delete process.env.ANTHROPIC_API_KEY;

import { query } from '@anthropic-ai/claude-agent-sdk';

const SCRATCH = process.env.SPIKE_SCRATCH;
if (!SCRATCH) { console.error('SPIKE_SCRATCH env not set'); process.exit(1); }
const SPAWN_CWD = SCRATCH + '\\spawn-cwd';

const MODEL = 'claude-haiku-4-5-20251001';

function nowMs() { return Number(process.hrtime.bigint() / 1000000n); }

async function runOne(idx) {
  const t0 = nowMs();
  const rec = {
    idx,
    tInitMs: null,
    tResultMs: null,
    subtype: null,
    total_cost_usd: null,
    error: null,
    resultText: null,
    api_error_status: undefined,
    num_turns: null,
  };
  try {
    const q = query({
      prompt: 'Reply with exactly: OK',
      options: {
        model: MODEL,
        maxTurns: 1,
        allowedTools: [],
        cwd: SPAWN_CWD,
      },
    });
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init' && rec.tInitMs === null) {
        rec.tInitMs = nowMs() - t0;
      }
      if (msg.type === 'result') {
        rec.tResultMs = nowMs() - t0;
        rec.subtype = msg.subtype;
        rec.total_cost_usd = msg.total_cost_usd;
        rec.num_turns = msg.num_turns;
        if ('result' in msg) rec.resultText = msg.result;
        if ('api_error_status' in msg) rec.api_error_status = msg.api_error_status;
        if ('errors' in msg && msg.errors && msg.errors.length) rec.errorsArr = msg.errors;
      }
    }
  } catch (err) {
    rec.error = {
      name: err && err.name,
      message: err && err.message,
      stack: err && err.stack,
      // capture any extra enumerable props verbatim
      raw: (() => { try { return JSON.stringify(err, Object.getOwnPropertyNames(err)); } catch { return String(err); } })(),
    };
  }
  return rec;
}

async function runBatch(n) {
  const batchT0 = nowMs();
  const results = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => runOne(i + 1))
  );
  const batchWall = nowMs() - batchT0;
  return { n, batchWall, results: results.map(r => r.status === 'fulfilled' ? r.value : { rejected: true, reason: String(r.reason) }) };
}

const batches = [];
for (const n of [2, 4, 8]) {
  console.error(`=== starting batch N=${n} ===`);
  const b = await runBatch(n);
  batches.push(b);
  console.error(`=== done batch N=${n} wall=${b.batchWall}ms ===`);
}

console.log(JSON.stringify({ model: MODEL, spawnCwd: SPAWN_CWD, batches }, null, 2));
