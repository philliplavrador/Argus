// Spike B - canUseTool blocking-inbox test for AskUserQuestion.
// Holds the AskUserQuestion permission request for 180s, then resolves with the
// chosen answer injected via updatedInput.answers, and verifies context + answer channel.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';

const SCRATCH = 'C:\\Users\\phill\\AppData\\Local\\Temp\\claude\\d--Projects-Argus\\0636ba7b-5673-4655-ba57-197243db7acd\\scratchpad';
const CWD = SCRATCH + '\\spawn-cwd-b';
const LOG_DIR = 'D:\\Projects\\Argus\\.argus-spikes\\logs';
mkdirSync(CWD, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
const JSONL = LOG_DIR + '\\spike-b-messages.jsonl';
writeFileSync(JSONL, '');

const CHOSEN = 'Alpha'; // the option THIS callback selects
const HOLD_MS = 180000;
const t0 = Date.now();
const ts = () => new Date().toISOString();
const rel = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
function log(obj) {
  const line = JSON.stringify({ ts: ts(), rel: rel(), ...obj });
  appendFileSync(JSONL, line + '\n');
  console.log('[' + rel() + '] ' + (obj.tag || obj.type || ''));
}

if (process.env.ANTHROPIC_API_KEY) {
  console.log('FATAL: ANTHROPIC_API_KEY is set; refusing to run.');
  process.exit(2);
}

let holdAchieved = 0;
let callbackFired = false;
let resolvedInput = null;

const canUseTool = async (toolName, input, opts) => {
  callbackFired = true;
  const hb = Date.now();
  log({ tag: 'canUseTool.enter', toolName, input, opts_keys: Object.keys(opts || {}), toolUseID: opts?.toolUseID, requestId: opts?.requestId });
  if (toolName !== 'AskUserQuestion') {
    log({ tag: 'canUseTool.non-ask-allow', toolName });
    return { behavior: 'allow', updatedInput: input };
  }
  // HOLD for 180s
  await new Promise((r) => setTimeout(r, HOLD_MS));
  holdAchieved = (Date.now() - hb) / 1000;
  // Build answers map keyed by question text -> chosen option label.
  const answers = {};
  try {
    for (const q of input.questions || []) answers[q.question] = CHOSEN;
  } catch (e) { log({ tag: 'answers.build.err', err: String(e) }); }
  const updatedInput = { ...input, answers };
  resolvedInput = updatedInput;
  log({ tag: 'canUseTool.resolve', holdAchieved, behavior: 'allow', updatedInput });
  return { behavior: 'allow', updatedInput };
};

let sessionId = null, result = null, finalText = '';
try {
  const q = query({
    prompt: 'Remember this codeword: ZEBRA-42. Ask me ONE question using the AskUserQuestion tool with exactly two options labeled Alpha and Bravo. After you receive my answer, reply with one line containing the codeword and the option I chose, then stop.',
    options: {
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 4,
      allowedTools: ['AskUserQuestion'],
      cwd: CWD,
      canUseTool,
    },
  });

  for await (const msg of q) {
    // Log every streamed message.
    log({ tag: 'stream', type: msg.type, subtype: msg.subtype, session_id: msg.session_id, msg });
    if (msg.type === 'system' && msg.session_id) sessionId = msg.session_id;
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'text') finalText += block.text + '\n';
      }
    }
    if (msg.type === 'user') {
      // tool_result comes back as a user message; capture verbatim already logged above.
    }
    if (msg.type === 'result') result = msg;
  }
} catch (e) {
  log({ tag: 'FATAL.err', name: e?.name, message: String(e?.message || e), stack: e?.stack });
}

const hasCodeword = /ZEBRA-42/.test(finalText);
const hasChosen = new RegExp(CHOSEN, 'i').test(finalText);
const summary = {
  tag: 'SUMMARY',
  callbackFired,
  holdAchieved,
  sessionId,
  hasCodeword,
  hasChosen,
  chosen: CHOSEN,
  finalText: finalText.trim(),
  result_subtype: result?.subtype,
  is_error: result?.is_error,
  num_turns: result?.num_turns,
  total_cost_usd: result?.total_cost_usd,
  duration_ms: result?.duration_ms,
  usage: result?.usage,
  resolvedInput,
  VERDICT: (holdAchieved >= 179 && hasCodeword && hasChosen) ? 'PASS' : 'FAIL',
};
log(summary);
console.log('\n===SUMMARY===\n' + JSON.stringify(summary, null, 2));
