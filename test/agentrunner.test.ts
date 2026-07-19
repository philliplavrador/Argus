import { test } from "node:test";
import assert from "node:assert/strict";

import { startAgent } from "../src/host/agentrunner";
import type { AgentRunnerDeps } from "../src/host/agentrunner";
import { buildSystemPromptAppend } from "../src/core/prompt";
import { AGENT_TEXT_CAP, DEFAULT_CONFIG } from "../src/core/types";
import type {
  ArgusConfig,
  ArgusEventBody,
  InboxResolution,
  TaskSpec,
} from "../src/core/types";
import type { AgentHandle, DecisionRequest } from "../src/host/contracts";

// ---------------------------------------------------------------------------
// Harness: a scripted fake queryFn — no real spawns
// ---------------------------------------------------------------------------

type FakeMsg = Record<string, unknown>;

/** Push-driven async iterator standing in for the SDK's Query stream. */
class FakeStream {
  private queue: FakeMsg[] = [];
  private waiter: {
    resolve: (r: IteratorResult<FakeMsg>) => void;
    reject: (e: unknown) => void;
  } | null = null;
  private ended = false;
  private failure: unknown = null;

  push(msg: FakeMsg): void {
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ value: msg, done: false });
      return;
    }
    this.queue.push(msg);
  }

  end(): void {
    this.ended = true;
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ value: undefined, done: true });
    }
  }

  fail(err: unknown): void {
    this.failure = err;
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<FakeMsg> {
    return this;
  }

  next(): Promise<IteratorResult<FakeMsg>> {
    if (this.queue.length > 0) {
      return Promise.resolve({ value: this.queue.shift() as FakeMsg, done: false });
    }
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  return(): Promise<IteratorResult<FakeMsg>> {
    this.ended = true;
    return Promise.resolve({ value: undefined, done: true });
  }
}

const WORKTREE = "D:/wt/task-1";
const LOG_DIR = "D:/argus-logs";

function makeSpec(over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "task-1",
    title: "Test task",
    prompt: "Do the thing.",
    scope: { include: ["src/**"] },
    model: "claude-fable-5",
    effort: "high",
    gates: [],
    budgetUsd: null,
    autoMerge: false,
    ...over,
  };
}

function makeConfig(over: Partial<ArgusConfig> = {}): ArgusConfig {
  return { ...DEFAULT_CONFIG, perTaskBudgetUsd: null, ...over };
}

interface Harness {
  handle: AgentHandle;
  stream: FakeStream;
  events: ArgusEventBody[];
  decideCalls: DecisionRequest[];
  logCalls: { file: string; line: string }[];
  /** User messages the fake consumed from the runner's prompt generator. */
  prompts: FakeMsg[];
  promptDone: Promise<void>;
  /** The options object the runner handed to queryFn. */
  options: Record<string, any>;
}

function startHarness(opts?: {
  spec?: Partial<TaskSpec>;
  config?: Partial<ArgusConfig>;
  decide?: (req: DecisionRequest) => Promise<InboxResolution>;
}): Harness {
  const stream = new FakeStream();
  const h = {
    stream,
    events: [] as ArgusEventBody[],
    decideCalls: [] as DecisionRequest[],
    logCalls: [] as { file: string; line: string }[],
    prompts: [] as FakeMsg[],
    promptDone: Promise.resolve(),
    options: {} as Record<string, any>,
  };

  const decideImpl = opts?.decide ?? (() => new Promise<InboxResolution>(() => {}));

  const queryFn = (params: { prompt: unknown; options?: Record<string, any> }) => {
    h.options = params.options ?? {};
    // Reject the pending stream read on abort, like the real SDK does.
    const controller: AbortController | undefined = h.options.abortController;
    controller?.signal.addEventListener("abort", () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      stream.fail(err);
    });
    // Drain the runner's streaming input so steer semantics are observable.
    if (typeof params.prompt === "object" && params.prompt !== null) {
      h.promptDone = (async () => {
        for await (const m of params.prompt as AsyncIterable<FakeMsg>) {
          h.prompts.push(m);
        }
      })();
    }
    return stream;
  };

  const deps: AgentRunnerDeps = {
    queryFn: queryFn as unknown as AgentRunnerDeps["queryFn"],
    appendLog: (file, line) => h.logCalls.push({ file, line }),
  };

  const handle = startAgent(
    {
      spec: makeSpec(opts?.spec),
      worktreePath: WORKTREE,
      config: makeConfig(opts?.config),
      logDir: LOG_DIR,
      callbacks: {
        emit: (body) => h.events.push(body),
        decide: (req) => {
          h.decideCalls.push(req);
          return decideImpl(req);
        },
      },
    },
    deps,
  );
  return { ...h, handle };
}

let toolUseSeq = 0;

function callCanUseTool(
  h: Harness,
  tool: string,
  input: Record<string, unknown>,
  toolUseID?: string,
): Promise<Record<string, any>> {
  const fn = h.options.canUseTool;
  assert.equal(typeof fn, "function", "options.canUseTool must be set");
  return fn(tool, input, {
    toolUseID: toolUseID ?? `tu-${++toolUseSeq}`,
    requestId: "req-1",
    signal: new AbortController().signal,
  });
}

function callPreToolUse(
  h: Harness,
  toolName: string,
  toolInput: unknown,
  toolUseID?: string,
): Promise<Record<string, any>> {
  const matchers = h.options.hooks?.PreToolUse;
  assert.ok(Array.isArray(matchers) && matchers.length === 1, "one PreToolUse matcher");
  const hook = matchers[0].hooks[0];
  const id = toolUseID ?? `tu-${++toolUseSeq}`;
  return hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: id,
      session_id: "sess-1",
      transcript_path: "",
      cwd: WORKTREE,
    },
    id,
    { signal: new AbortController().signal },
  );
}

function eventsOf(h: Harness, type: string): any[] {
  return h.events.filter((e) => e.type === type);
}

function initMsg(): FakeMsg {
  return {
    type: "system",
    subtype: "init",
    session_id: "sess-1",
    model: "claude-fable-5",
    cwd: WORKTREE,
    tools: [],
  };
}

function assistantMsg(id: string, text: string, usage?: Record<string, number>): FakeMsg {
  return {
    type: "assistant",
    message: {
      id,
      role: "assistant",
      content: [{ type: "text", text }],
      usage: usage ?? {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    },
    parent_tool_use_id: null,
    session_id: "sess-1",
  };
}

function resultMsg(result: string, costUsd: number): FakeMsg {
  return {
    type: "result",
    subtype: "success",
    result,
    total_cost_usd: costUsd,
    is_error: false,
    num_turns: 1,
    session_id: "sess-1",
  };
}

/** Let queued microtasks (generator wakeups, prompt drain) settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Drive a scripted stream to completion and return the outcome. */
async function finish(h: Harness): Promise<Record<string, unknown>> {
  h.stream.end();
  const outcome = await h.handle.done;
  return outcome as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Options assembly
// ---------------------------------------------------------------------------

test("options: model, effort, cwd, maxTurns, permissionMode, settingSources", async () => {
  const h = startHarness();
  assert.equal(h.options.model, "claude-fable-5");
  assert.equal(h.options.effort, "high");
  assert.equal(h.options.cwd, WORKTREE);
  assert.equal(h.options.maxTurns, 200);
  assert.equal(h.options.permissionMode, "default");
  assert.deepEqual(h.options.settingSources, []);
  assert.ok(h.options.abortController instanceof AbortController);
  await finish(h);
});

test("options: systemPrompt is the claude_code preset with the Argus append", async () => {
  const h = startHarness();
  const sp = h.options.systemPrompt;
  assert.equal(sp.type, "preset");
  assert.equal(sp.preset, "claude_code");
  assert.equal(sp.append, buildSystemPromptAppend(makeSpec(), makeConfig()));
  assert.match(sp.append, /src\/\*\*/);
  // The balanced pushback directive rides along.
  assert.match(sp.append, /materially shapes the outcome/);
  await finish(h);
});

test("options: no thinking, allowedTools, disallowedTools, or askUserQuestionTimeout keys", async () => {
  const h = startHarness();
  assert.ok(!("thinking" in h.options), "thinking must not be set");
  assert.ok(!("allowedTools" in h.options), "allowedTools must not be set");
  assert.ok(!("disallowedTools" in h.options), "disallowedTools must not be set");
  assert.ok(!("askUserQuestionTimeout" in h.options), "askUserQuestionTimeout must not be set");
  await finish(h);
});

test("options: env is a copy of process.env without ANTHROPIC_API_KEY", async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test-must-not-leak";
  process.env.ARGUS_TEST_MARKER = "marker";
  try {
    const h = startHarness();
    assert.ok(!("ANTHROPIC_API_KEY" in h.options.env), "API key must be stripped");
    assert.equal(h.options.env.ARGUS_TEST_MARKER, "marker");
    await finish(h);
  } finally {
    if (prev === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = prev;
    }
    delete process.env.ARGUS_TEST_MARKER;
  }
});

test("options: maxBudgetUsd fallback chain spec -> config -> absent", async () => {
  const a = startHarness({ spec: { budgetUsd: 3 }, config: { perTaskBudgetUsd: 7 } });
  assert.equal(a.options.maxBudgetUsd, 3);
  await finish(a);

  const b = startHarness({ spec: { budgetUsd: null }, config: { perTaskBudgetUsd: 7 } });
  assert.equal(b.options.maxBudgetUsd, 7);
  await finish(b);

  const c = startHarness({ spec: { budgetUsd: null }, config: { perTaskBudgetUsd: null } });
  assert.ok(!("maxBudgetUsd" in c.options), "maxBudgetUsd must be omitted when both are null");
  await finish(c);
});

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

const QUESTION_INPUT = {
  questions: [
    {
      question: "Which option do you prefer?",
      header: "Choice",
      multiSelect: false,
      options: [
        { label: "Alpha", description: "The first option" },
        { label: "Bravo", description: "The second option" },
      ],
    },
  ],
};

test("AskUserQuestion: decide gets the DecisionRequest; answers keyed by question text", async () => {
  const h = startHarness({
    decide: async () => ({ rkind: "question", optionLabels: ["Alpha"], freeText: null }),
  });
  const res = await callCanUseTool(h, "AskUserQuestion", { ...QUESTION_INPUT });
  assert.equal(res.behavior, "allow");
  assert.deepEqual(h.decideCalls, [
    {
      kind: "question",
      header: "Choice",
      question: "Which option do you prefer?",
      options: [
        { label: "Alpha", description: "The first option" },
        { label: "Bravo", description: "The second option" },
      ],
      multiSelect: false,
    },
  ]);
  assert.deepEqual(res.updatedInput.answers, { "Which option do you prefer?": "Alpha" });
  // Original questions survive in updatedInput.
  assert.deepEqual(res.updatedInput.questions, QUESTION_INPUT.questions);
  await finish(h);
});

test("AskUserQuestion: multiSelect answers join with ', '", async () => {
  const h = startHarness({
    decide: async () => ({ rkind: "question", optionLabels: ["Alpha", "Bravo"], freeText: null }),
  });
  const input = {
    questions: [{ ...QUESTION_INPUT.questions[0], multiSelect: true }],
  };
  const res = await callCanUseTool(h, "AskUserQuestion", input);
  assert.equal(res.updatedInput.answers["Which option do you prefer?"], "Alpha, Bravo");
  await finish(h);
});

test("AskUserQuestion: freeText is the fallback when no label was chosen", async () => {
  const h = startHarness({
    decide: async () => ({ rkind: "question", optionLabels: [], freeText: "use a third thing" }),
  });
  const res = await callCanUseTool(h, "AskUserQuestion", { ...QUESTION_INPUT });
  assert.equal(res.updatedInput.answers["Which option do you prefer?"], "use a third thing");
  await finish(h);
});

test("AskUserQuestion: label plus freeText combine with an em dash", async () => {
  const h = startHarness({
    decide: async () => ({ rkind: "question", optionLabels: ["Alpha"], freeText: "but rename it" }),
  });
  const res = await callCanUseTool(h, "AskUserQuestion", { ...QUESTION_INPUT });
  assert.equal(
    res.updatedInput.answers["Which option do you prefer?"],
    "Alpha — but rename it",
  );
  await finish(h);
});

test("AskUserQuestion: two questions produce two sequential decides and both answers", async () => {
  const resolutions: InboxResolution[] = [
    { rkind: "question", optionLabels: ["Alpha"], freeText: null },
    { rkind: "question", optionLabels: ["Redis"], freeText: null },
  ];
  const h = startHarness({
    decide: async () => resolutions.shift() as InboxResolution,
  });
  const input = {
    questions: [
      QUESTION_INPUT.questions[0],
      {
        question: "Which cache backend?",
        header: "Cache",
        multiSelect: false,
        options: [
          { label: "Redis", description: "hosted" },
          { label: "In-memory", description: "simple" },
        ],
      },
    ],
  };
  const res = await callCanUseTool(h, "AskUserQuestion", input);
  assert.equal(h.decideCalls.length, 2);
  assert.equal((h.decideCalls[0] as { question?: string }).question, "Which option do you prefer?");
  assert.equal((h.decideCalls[1] as { question?: string }).question, "Which cache backend?");
  assert.deepEqual(res.updatedInput.answers, {
    "Which option do you prefer?": "Alpha",
    "Which cache backend?": "Redis",
  });
  await finish(h);
});

// ---------------------------------------------------------------------------
// Scope policy
// ---------------------------------------------------------------------------

test("scope: in-scope Edit allows and emits path-write", async () => {
  const h = startHarness();
  const input = { file_path: "src/a.ts", old_string: "x", new_string: "y" };
  const res = await callCanUseTool(h, "Edit", input);
  assert.equal(res.behavior, "allow");
  assert.deepEqual(res.updatedInput, input);
  assert.deepEqual(eventsOf(h, "path-write"), [
    { type: "path-write", taskId: "task-1", path: "src/a.ts", tool: "Edit" },
  ]);
  assert.equal(h.decideCalls.length, 0);
  await finish(h);
});

test("scope: out-of-scope Edit escalates; allow-once allows and records the write", async () => {
  const h = startHarness({
    decide: async () => ({ rkind: "scope-escalation", action: "allow-once" }),
  });
  const res = await callCanUseTool(h, "Edit", { file_path: "docs/readme.md" });
  assert.equal(res.behavior, "allow");
  assert.deepEqual(h.decideCalls, [
    { kind: "scope-escalation", tool: "Edit", path: "docs/readme.md" },
  ]);
  assert.deepEqual(eventsOf(h, "path-write"), [
    { type: "path-write", taskId: "task-1", path: "docs/readme.md", tool: "Edit" },
  ]);
  await finish(h);
});

test("scope: expand-scope widens the live gate — same-dir Edit then allows without decide", async () => {
  const h = startHarness({
    decide: async () => ({ rkind: "scope-escalation", action: "expand-scope", glob: "docs/**" }),
  });
  const first = await callCanUseTool(h, "Edit", { file_path: "docs/readme.md" });
  assert.equal(first.behavior, "allow");
  assert.equal(h.decideCalls.length, 1);

  const second = await callCanUseTool(h, "Edit", { file_path: "docs/other.md" });
  assert.equal(second.behavior, "allow");
  assert.equal(h.decideCalls.length, 1, "second write must not re-escalate");
  assert.equal(eventsOf(h, "path-write").length, 2);
  await finish(h);
});

test("scope: deny resolution denies with the reason and no interrupt", async () => {
  const h = startHarness({
    decide: async () => ({
      rkind: "scope-escalation",
      action: "deny",
      reason: "stay out of docs for this task",
    }),
  });
  const res = await callCanUseTool(h, "Edit", { file_path: "docs/readme.md" });
  assert.equal(res.behavior, "deny");
  assert.equal(res.message, "stay out of docs for this task");
  assert.ok(!res.interrupt, "escalation deny must not interrupt");
  await finish(h);
});

test("pushback: risky Bash escalates under balanced, allows under autonomous", async () => {
  const balanced = startHarness({
    config: { pushback: "balanced" },
    decide: async () => ({ rkind: "scope-escalation", action: "deny", reason: "no pushes" }),
  });
  const denied = await callCanUseTool(balanced, "Bash", { command: "git push origin main" });
  assert.equal(denied.behavior, "deny");
  assert.equal(balanced.decideCalls.length, 1);
  assert.equal((balanced.decideCalls[0] as { tool?: string }).tool, "Bash");
  assert.equal(balanced.decideCalls[0].kind, "scope-escalation");
  await finish(balanced);

  const autonomous = startHarness({ config: { pushback: "autonomous" } });
  const allowed = await callCanUseTool(autonomous, "Bash", { command: "git push origin main" });
  assert.equal(allowed.behavior, "allow");
  assert.equal(autonomous.decideCalls.length, 0);
  await finish(autonomous);
});

test("decide rejection: canUseTool denies with interrupt for questions and escalations", async () => {
  const h = startHarness({
    decide: () => Promise.reject(new Error("task cancelled")),
  });
  const q = await callCanUseTool(h, "AskUserQuestion", { ...QUESTION_INPUT });
  assert.equal(q.behavior, "deny");
  assert.equal(q.message, "Task cancelled by operator");
  assert.equal(q.interrupt, true);

  const e = await callCanUseTool(h, "Edit", { file_path: "docs/readme.md" });
  assert.equal(e.behavior, "deny");
  assert.equal(e.message, "Task cancelled by operator");
  assert.equal(e.interrupt, true);
  await finish(h);
});

// ---------------------------------------------------------------------------
// PreToolUse hook
// ---------------------------------------------------------------------------

test("hook: emits tool-call with formatted detail and repo-relative paths", async () => {
  const h = startHarness();
  const out = await callPreToolUse(h, "Edit", {
    file_path: `${WORKTREE}/src/lib/date.ts`,
    old_string: "a",
    new_string: "b",
  });
  assert.deepEqual(out, { continue: true });

  const longCmd = "npm run build && npm test -- --grep something-quite-long-here-to-truncate";
  await callPreToolUse(h, "Bash", { command: longCmd });
  await callPreToolUse(h, "Grep", { pattern: "TODO.*fix" });
  await callPreToolUse(h, "WebSearch", { query: "irrelevant" });

  const calls = eventsOf(h, "tool-call");
  assert.deepEqual(calls[0], {
    type: "tool-call",
    taskId: "task-1",
    tool: "Edit",
    detail: "Edit src/lib/date.ts",
    paths: ["src/lib/date.ts"],
  });
  assert.equal(calls[1].detail, `Bash: ${longCmd.slice(0, 80)}`);
  assert.deepEqual(calls[1].paths, []);
  assert.equal(calls[2].detail, "Grep TODO.*fix");
  assert.equal(calls[3].detail, "WebSearch");
  await finish(h);
});

test("hook: Read under the worktree emits path-read, deduped against canUseTool by toolUseID", async () => {
  const h = startHarness();
  const input = { file_path: `${WORKTREE}/src/a.ts` };

  await callPreToolUse(h, "Read", input, "tu-read-1");
  assert.deepEqual(eventsOf(h, "path-read"), [
    { type: "path-read", taskId: "task-1", path: "src/a.ts" },
  ]);

  // The same call also reaching canUseTool must not double-emit.
  const res = await callCanUseTool(h, "Read", input, "tu-read-1");
  assert.equal(res.behavior, "allow");
  assert.equal(eventsOf(h, "path-read").length, 1);

  // A distinct Read call emits again.
  const res2 = await callCanUseTool(h, "Read", input, "tu-read-2");
  assert.equal(res2.behavior, "allow");
  assert.equal(eventsOf(h, "path-read").length, 2);
  await finish(h);
});

// ---------------------------------------------------------------------------
// Message folding
// ---------------------------------------------------------------------------

test("folding: init, capped agent-text, usage deduped by message id, result usage + success", async () => {
  const h = startHarness();
  h.stream.push(initMsg());
  h.stream.push(assistantMsg("msg_1", "x".repeat(AGENT_TEXT_CAP + 100)));
  h.stream.push(assistantMsg("msg_1", "second block, same api message"));
  h.stream.push(resultMsg("All gates green.", 0.12));
  const outcome = await finish(h);

  assert.deepEqual(eventsOf(h, "agent-init"), [
    { type: "agent-init", taskId: "task-1", sessionId: "sess-1", model: "claude-fable-5" },
  ]);

  const texts = eventsOf(h, "agent-text");
  assert.equal(texts.length, 2);
  assert.equal(texts[0].text.length, AGENT_TEXT_CAP);

  const usages = eventsOf(h, "usage");
  assert.equal(usages.length, 2, "one deduped assistant usage + one result usage");
  assert.deepEqual(usages[0], {
    type: "usage",
    taskId: "task-1",
    costUsdDelta: 0,
    tokensDelta: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 },
  });
  assert.deepEqual(usages[1], {
    type: "usage",
    taskId: "task-1",
    costUsdDelta: 0.12,
    tokensDelta: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });

  assert.deepEqual(outcome, { result: "success", detail: "All gates green." });
});

test("folding: error result subtype maps to an error outcome with brief detail", async () => {
  const h = startHarness();
  h.stream.push(initMsg());
  h.stream.push({
    type: "result",
    subtype: "error_max_turns",
    total_cost_usd: 0.5,
    is_error: true,
    num_turns: 200,
    errors: ["ran out of turns"],
    session_id: "sess-1",
  });
  const outcome = await finish(h);
  assert.deepEqual(outcome, { result: "error", detail: "error_max_turns: ran out of turns" });
});

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

test("steer: queued message is delivered after the result; session continues then ends", async () => {
  const h = startHarness();
  h.stream.push(initMsg());
  await tick();
  await h.handle.steer("Also update the README.");
  h.stream.push(resultMsg("first turn done", 0));
  await tick();
  h.stream.push(resultMsg("second turn done", 0));
  const outcome = await finish(h);
  await h.promptDone;

  assert.equal(h.prompts.length, 2);
  const first = h.prompts[0] as { type: string; parent_tool_use_id: unknown; message: any };
  assert.equal(first.type, "user");
  assert.equal(first.parent_tool_use_id, null);
  assert.deepEqual(first.message.content, [{ type: "text", text: "Do the thing." }]);
  const second = h.prompts[1] as { message: any };
  assert.deepEqual(second.message.content, [{ type: "text", text: "Also update the README." }]);
  assert.deepEqual(outcome, { result: "success", detail: "second turn done" });
});

test("steer: without steering, the input generator ends after the first result", async () => {
  const h = startHarness();
  h.stream.push(initMsg());
  h.stream.push(resultMsg("done", 0));
  await finish(h);
  await h.promptDone;
  assert.equal(h.prompts.length, 1);
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

test("stop: aborts the session, resolves done as aborted, and is idempotent", async () => {
  const h = startHarness();
  h.stream.push(initMsg());
  await tick();

  const stopped = h.handle.stop("operator asked to stop");
  const outcome = await h.handle.done;
  assert.deepEqual(outcome, { result: "aborted", detail: "operator asked to stop" });
  await stopped;

  // Second stop is harmless and keeps the original reason.
  await h.handle.stop("different reason");
  assert.deepEqual(await h.handle.done, { result: "aborted", detail: "operator asked to stop" });
  await h.promptDone;
});

test("stop: steering after the session ended rejects", async () => {
  const h = startHarness();
  h.stream.push(initMsg());
  await h.handle.stop(null);
  await assert.rejects(() => h.handle.steer("too late"));
  assert.deepEqual(await h.handle.done, { result: "aborted", detail: null });
});

// ---------------------------------------------------------------------------
// Raw log
// ---------------------------------------------------------------------------

test("raw log: appendLog called once per message with valid JSON lines", async () => {
  const h = startHarness();
  h.stream.push(initMsg());
  h.stream.push(assistantMsg("msg_1", "hello"));
  h.stream.push(resultMsg("done", 0.01));
  await finish(h);

  assert.equal(h.logCalls.length, 3);
  for (const call of h.logCalls) {
    assert.ok(
      call.file.replace(/\\/g, "/").endsWith("task-1.jsonl"),
      `log file path ${call.file} must be <logDir>/<taskId>.jsonl`,
    );
    const parsed = JSON.parse(call.line);
    assert.equal(typeof parsed.type, "string");
  }
  const kinds = h.logCalls.map((c) => JSON.parse(c.line).type);
  assert.deepEqual(kinds, ["system", "assistant", "result"]);
});
