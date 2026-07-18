import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categoryOf,
  compareTasks,
  isTerminal,
  parseStatus,
  parseSweep,
  warningDetectors,
  type ParsedStatus,
} from "../src/lib/status";

const FULL = JSON.stringify({
  id: "supplier-dedupe-rule",
  title: "Dedupe supplier rows on catalog number",
  phase: "BUILD",
  pct: 47,
  etaMin: 9,
  stepsDone: 2,
  stepsTotal: 5,
  tree: "worktree",
  branch: "task/supplier-dedupe-rule",
  agentName: "supplier-dedupe-rule",
  model: "opus-4-8",
  startedAt: "2026-07-18T18:11:04Z",
  updatedAt: "2026-07-18T18:39:51Z",
  heartbeatAt: "2026-07-18T18:41:12Z",
  progressToken: "build:resolver:3of5",
  blockedOn: null,
  locks: [],
  lease: ["app/backend/lib/suppliers/**"],
  lastEvent: "3 of 5 resolvers rewritten; unit suite green",
  acknowledged: false,
});

test("parses the full contract example", () => {
  const s = parseStatus(FULL, "dir-name");
  assert.equal(s.ok, true);
  if (!s.ok) return;
  assert.equal(s.id, "supplier-dedupe-rule");
  assert.equal(s.phase, "BUILD");
  assert.equal(s.pct, 47);
  assert.equal(s.model, "opus-4-8");
  assert.equal(s.blockedOn, null);
  assert.deepEqual(s.lease, ["app/backend/lib/suppliers/**"]);
  assert.equal(s.acknowledged, false);
});

test("malformed JSON yields ok:false with the directory name as id", () => {
  const s = parseStatus("{not json", "my-task");
  assert.equal(s.ok, false);
  assert.equal(s.id, "my-task");
});

test("non-object JSON yields ok:false", () => {
  assert.equal(parseStatus("[1,2,3]", "t").ok, false);
  assert.equal(parseStatus("42", "t").ok, false);
  assert.equal(parseStatus("null", "t").ok, false);
});

test("missing fields fall back to safe defaults", () => {
  const s = parseStatus("{}", "fallback-id");
  assert.equal(s.ok, true);
  if (!s.ok) return;
  assert.equal(s.id, "fallback-id");
  assert.equal(s.phase, "UNKNOWN");
  assert.equal(s.pct, null);
  assert.equal(s.model, null);
  assert.equal(s.blockedOn, null);
  assert.deepEqual(s.locks, []);
  assert.equal(s.acknowledged, false);
});

test("wrong-typed fields are dropped, not thrown", () => {
  const s = parseStatus(
    JSON.stringify({ id: 12, phase: ["BUILD"], pct: "47", blockedOn: "question", locks: "nope" }),
    "dir",
  );
  assert.equal(s.ok, true);
  if (!s.ok) return;
  assert.equal(s.id, "dir");
  assert.equal(s.phase, "UNKNOWN");
  assert.equal(s.pct, null);
  assert.equal(s.blockedOn, null);
  assert.deepEqual(s.locks, []);
});

test("pct is clamped to 0..100", () => {
  const over = parseStatus(JSON.stringify({ pct: 150 }), "t");
  const under = parseStatus(JSON.stringify({ pct: -5 }), "t");
  assert.ok(over.ok && over.pct === 100);
  assert.ok(under.ok && under.pct === 0);
});

test("phase is upper-cased defensively", () => {
  const s = parseStatus(JSON.stringify({ phase: "build" }), "t");
  assert.ok(s.ok && s.phase === "BUILD");
});

test("blockedOn parses kind/ref/since", () => {
  const s = parseStatus(
    JSON.stringify({
      phase: "BLOCKED",
      blockedOn: { kind: "question", ref: "workflow/queue/x.md", since: "2026-07-18T18:12:00Z" },
    }),
    "t",
  );
  assert.ok(s.ok);
  if (!s.ok) return;
  assert.deepEqual(s.blockedOn, {
    kind: "question",
    ref: "workflow/queue/x.md",
    since: "2026-07-18T18:12:00Z",
  });
});

test("terminal phases and categories", () => {
  assert.equal(isTerminal("PUSHED"), true);
  assert.equal(isTerminal("FAILED"), true);
  assert.equal(isTerminal("BLOCKED"), false);
  assert.equal(isTerminal("BUILD"), false);

  const mk = (o: object): ParsedStatus => parseStatus(JSON.stringify(o), "t");
  assert.equal(categoryOf(mk({ phase: "BUILD" })), "running");
  assert.equal(categoryOf(mk({ phase: "QUEUED" })), "running");
  assert.equal(categoryOf(mk({ phase: "BLOCKED" })), "blocked");
  assert.equal(categoryOf(mk({ phase: "PUSHED" })), "finished");
  assert.equal(categoryOf(mk({ phase: "FAILED" })), "finished");
  assert.equal(categoryOf(parseStatus("oops", "t")), "unparsable");
});

test("sort order: running (by startedAt) then blocked then finished then unparsable", () => {
  const mk = (o: object): ParsedStatus => parseStatus(JSON.stringify(o), "t");
  const runLate = mk({ id: "run-late", phase: "BUILD", startedAt: "2026-07-18T12:00:00Z" });
  const runEarly = mk({ id: "run-early", phase: "DESIGN", startedAt: "2026-07-18T09:00:00Z" });
  const runNoStart = mk({ id: "run-nostart", phase: "QUEUED" });
  const blocked = mk({ id: "blk", phase: "BLOCKED", startedAt: "2026-07-18T08:00:00Z" });
  const pushed = mk({ id: "done", phase: "PUSHED", startedAt: "2026-07-18T07:00:00Z" });
  const bad = parseStatus("nope", "zzz");

  const sorted = [pushed, bad, runLate, blocked, runNoStart, runEarly].sort(compareTasks);
  assert.deepEqual(
    sorted.map((s) => s.id),
    ["run-early", "run-late", "run-nostart", "blk", "done", "zzz"],
  );
});

test("parseSweep tolerates garbage and filters malformed findings", () => {
  assert.deepEqual(parseSweep("not json"), []);
  assert.deepEqual(parseSweep("null"), []);
  assert.deepEqual(parseSweep(JSON.stringify({ openFindings: "x" })), []);
  const findings = parseSweep(
    JSON.stringify({
      openFindings: [
        { taskid: "a", detector: "stall", tier: 3 },
        { taskid: "a", detector: 5, tier: 3 },
        "junk",
        { taskid: "b", detector: "drift", tier: 2 },
      ],
    }),
  );
  assert.equal(findings.length, 2);
});

test("warningDetectors keeps tier >= 3 for the task, upper-cased", () => {
  const findings = parseSweep(
    JSON.stringify({
      openFindings: [
        { taskid: "a", detector: "stall", tier: 3 },
        { taskid: "a", detector: "drift", tier: 2 },
        { taskid: "b", detector: "scopecreep", tier: 4 },
      ],
    }),
  );
  assert.deepEqual(warningDetectors(findings, "a"), ["STALL"]);
  assert.deepEqual(warningDetectors(findings, "b"), ["SCOPECREEP"]);
  assert.deepEqual(warningDetectors(findings, "c"), []);
});
