# Spike B — canUseTool as a blocking inbox for AskUserQuestion

**Verdict: PASS.** A `canUseTool` callback can hold an agent's `AskUserQuestion`
tool call for a full 180 seconds, then resolve it; the session survives with
context intact and the chosen answer reaches the agent. This validates the
load-bearing assumption of Argus v2.

All claims below are grounded in verbatim output from two runs on
`claude-haiku-4-5-20251001`, subscription auth, `ANTHROPIC_API_KEY` unset.
Scripts: `d:\Projects\Argus\.argus-spikes\scripts\spike-b.mjs` (primary, 180s hold)
and `spike-b2.mjs` (confirmation, no bare allowedTools, 8s hold).
Full message logs: `.argus-spikes\logs\spike-b-messages.jsonl`,
`spike-b2-messages.jsonl`.

---

## The API shapes (from the installed .d.ts — trusted over assumption)

`CanUseTool` (`sdk.d.ts:206`) — `(toolName, input, options) => Promise<PermissionResult | null>`.
The callback is `async` and the SDK awaits it, so an `await setTimeout(...)`
inside it parks the tool call indefinitely. The doc comment confirms this
explicitly: *"permission prompts have no park deadline"* (`sdk.d.ts:204`).

`PermissionResult` (`sdk.d.ts:2087`):
```
{ behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?; toolUseID?; decisionClassification? }
| { behavior: 'deny'; message: string; interrupt?; toolUseID?; decisionClassification? }
```

`AskUserQuestionInput` (`sdk-tools.d.ts:847`): `{ questions: [{ question, header, options:[{label,description,preview?}] , multiSelect }] }` — 1-4 questions, 2-4 options each.

`AskUserQuestionOutput` (`sdk-tools.d.ts:3395`) carries the answer field:
`answers: { [k: string]: string }` — *"question text -> answer string; multi-select answers are comma-separated"* (`sdk-tools.d.ts:3552`). This is the field the host fills in.

There is also an `askUserQuestionTimeout` option, enum `["60s","5m","10m","never"]`,
**default `"never"`** — *"Idle time before Claude's questions auto-continue with any
answers selected so far."* Default never = no auto-continue, which is exactly what a
blocking inbox needs.

---

## The answer mechanism that worked

Return from `canUseTool`, for the `AskUserQuestion` call:

```js
return {
  behavior: 'allow',
  updatedInput: { ...input, answers: { [question.question]: chosenLabel } },
};
```

i.e. take the tool's own `input` (the questions), add an `answers` map keyed by
**question text → chosen option label**, and pass it back as `updatedInput`. The
SDK's AskUserQuestion executor reads `answers` and synthesizes the tool_result
that the agent sees. No separate output channel, no MCP tool, no resume needed.

### Verbatim round-trip (primary run)

Agent emits the tool call (t = 3.9s):
```json
{
  "type": "tool_use",
  "id": "toolu_016ikWaFaimoegxsfDgaypW5",
  "name": "AskUserQuestion",
  "input": { "questions": [ { "question": "Which option do you prefer?", "header": "Choice",
    "multiSelect": false, "options": [
      { "label": "Alpha", "description": "The first option" },
      { "label": "Bravo", "description": "The second option" } ] } ] },
  "caller": { "type": "direct" }
}
```

`canUseTool` fires, holds 180s, then resolves with:
```json
{ "behavior": "allow",
  "updatedInput": { "questions": [ ... ],
    "answers": { "Which option do you prefer?": "Alpha" } } }
```

Tool result delivered back to the agent (t = 183.9s — immediately after the hold released):
```json
[
  {
    "type": "tool_result",
    "content": "Your questions have been answered: \"Which option do you prefer?\"=\"Alpha\". You can now continue with these answers in mind.",
    "tool_use_id": "toolu_016ikWaFaimoegxsfDgaypW5"
  }
]
```

Final assistant text: **`ZEBRA-42 Alpha`** — codeword survived (context intact) and
the option THIS callback chose (`Alpha`) is named (answer channel works).

---

## Success criteria (all three met)

| Criterion | Result |
|---|---|
| (1) No timeout/disconnect during 3-min hold | `holdAchieved = 180.001s`; `result.subtype = "success"`, `is_error = false` |
| (2) Final text contains ZEBRA-42 (context survived) | `hasCodeword = true`; final text `"ZEBRA-42 Alpha"` |
| (3) Final text names the option the callback chose | `hasChosen = true`; chose `Alpha`, text names `Alpha` |

Timeline proof the stream was genuinely blocked (not polling): `canUseTool.enter`
logged at 3.9s, next stream event (`tool_result`) at 183.9s. The 180s gap is the
hold; nothing streamed during it and everything resumed the instant the callback
returned.

### Primary run key numbers (180s hold)
- Hold achieved: **180.001 s**
- Session: `1099d6ca-3d7d-4f27-894a-5175d33b6dd8`, survived
- `num_turns`: 2 · `duration_ms`: 184876 · `total_cost_usd`: **$0.0529**
- usage: output 296 tok, cache_read 23930, cache_creation 24183

### Confirmation run (spike-b2, no bare allowedTools, 8s hold)
- Hold achieved: **8.014 s**, VERDICT PASS, final text `"ZEBRA-42 Alpha"`
- `total_cost_usd`: **$0.0149** · `num_turns`: 2 · `duration_ms`: 12559

---

## SURPRISE / important caveat — the `allowedTools` shadow warning

The prompt's prescribed options used `allowedTools: ['AskUserQuestion']`. That run
printed at startup:

```
(node:28700) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be
invoked for: AskUserQuestion. Bare allowedTools entries auto-approve the whole tool
before the callback is consulted. To gate every tool call, use a PreToolUse hook; or
remove the bare names from allowedTools so they fall through to canUseTool.
```

Empirically the callback **still fired and still gated** the 180s hold in that run
(AskUserQuestion appears to always route through the permission path because it
inherently needs an answer). **But the warning is a real design risk** — relying on
a documented-as-shadowed path is fragile. The confirmation run
(`spike-b2.mjs`) removed `AskUserQuestion` from `allowedTools` (used
`allowedTools: []`):
- **No shadow warning** was printed.
- The tool was still available to the agent, the callback still fired, still gated,
  and the answer still reached the agent (PASS).

**Recommendation for Argus v2: do NOT put `AskUserQuestion` (nor any tool you want
the inbox to gate) as a bare entry in `allowedTools`.** Leave it out so every call
falls through to `canUseTool`, or gate via a `PreToolUse` hook. The clean pattern is
proven and warning-free.

Other notes:
- Answer keying is by **question text**, not index. If two questions share identical
  text this map would collide — use distinct question strings.
- The agent gets a *paraphrased* tool_result (`"Your questions have been
  answered: ... You can now continue"`), not the raw `answers` object. That is
  sufficient — the agent correctly extracted `Alpha`.
- `askUserQuestionTimeout` defaults to `"never"`; keep it there for a blocking inbox
  so questions never auto-continue with a default answer.

## Experiment 2 (deny-message / resume fallback)
**Not run** — Experiment 1's answer channel succeeded, so per the spike spec the
fallback was unnecessary. If ever needed, note the `deny` variant carries a
`message: string` field (`sdk.d.ts:2095`) that would surface to the agent as the
tool_result, and `query()` accepts `resume: <session_id>` for the abort-and-reinject
path.

---

## Bottom line for the blocking-inbox design
**PASS — the design is sound.** A `canUseTool` callback is a valid multi-minute
blocking inbox for `AskUserQuestion`: it parks with no deadline, the session and
context survive, and injecting `updatedInput.answers` is the working answer channel.
The one required deviation from the prompt's boilerplate: keep gated tools OUT of the
bare `allowedTools` list.
