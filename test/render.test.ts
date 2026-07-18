import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageMinutes,
  formatAge,
  progressBar,
  questionDescription,
  statusBarText,
  taskDescription,
} from "../src/lib/render";
import { parseStatus, type ParsedStatus } from "../src/lib/status";

const mk = (o: object): ParsedStatus => parseStatus(JSON.stringify(o), "t");

test("progressBar boundaries and rounding", () => {
  assert.equal(progressBar(0), "▕░░░░░░░░▏");
  assert.equal(progressBar(100), "▕████████▏");
  assert.equal(progressBar(47), "▕████░░░░▏"); // round(3.76) = 4
  assert.equal(progressBar(50), "▕████░░░░▏");
  assert.equal(progressBar(99), "▕████████▏");
  assert.equal(progressBar(-20), "▕░░░░░░░░▏");
  assert.equal(progressBar(400), "▕████████▏");
});

test("running task with pct and model", () => {
  const s = mk({ phase: "BUILD", pct: 47, model: "opus-4-8" });
  assert.equal(taskDescription(s), "BUILD ▕████░░░░▏47% · opus-4-8");
});

test("model omitted when absent; bar omitted without pct", () => {
  assert.equal(taskDescription(mk({ phase: "BUILD", pct: 47 })), "BUILD ▕████░░░░▏47%");
  assert.equal(taskDescription(mk({ phase: "SCOPED" })), "SCOPED");
});

test("BLOCKED shows pause glyph and blockedOn.kind", () => {
  const s = mk({ phase: "BLOCKED", blockedOn: { kind: "question", ref: "workflow/queue/x.md" } });
  assert.equal(taskDescription(s), "⏸ BLOCKED · question");
  assert.equal(taskDescription(mk({ phase: "BLOCKED" })), "⏸ BLOCKED");
});

test("terminal and unparsable descriptions", () => {
  assert.equal(taskDescription(mk({ phase: "PUSHED" })), "✓ PUSHED");
  assert.equal(taskDescription(mk({ phase: "FAILED" })), "✗ FAILED");
  assert.equal(taskDescription(parseStatus("garbage", "t")), "⚠ unparsable");
});

test("tier >= 3 watchdog findings append a warning suffix", () => {
  const s = mk({ phase: "BUILD", pct: 10 });
  assert.equal(taskDescription(s, ["STALL"]), "BUILD ▕█░░░░░░░▏10% ⚠ STALL");
  assert.equal(taskDescription(mk({ phase: "PUSHED" }), ["DRIFT"]), "✓ PUSHED ⚠ DRIFT");
});

test("question description", () => {
  assert.equal(questionDescription(true, 12), "blocking · 12m");
  assert.equal(questionDescription(false, 3), "3m");
  assert.equal(questionDescription(true, null), "blocking · ?");
});

test("ageMinutes math and invalid input", () => {
  const now = new Date("2026-07-18T19:00:00Z");
  assert.equal(ageMinutes("2026-07-18T18:12:00Z", now), 48);
  assert.equal(ageMinutes("2026-07-18T19:30:00Z", now), 0); // future → clamp
  assert.equal(ageMinutes("not a date", now), null);
  assert.equal(ageMinutes(null, now), null);
});

test("formatAge scales units", () => {
  assert.equal(formatAge(null), "unknown");
  assert.equal(formatAge(47), "47m");
  assert.equal(formatAge(192), "3h 12m");
  assert.equal(formatAge(3180), "2d 5h");
});

test("status bar text", () => {
  assert.equal(statusBarText(3, 2), "$(eye) 3▶ 2❓");
  assert.equal(statusBarText(0, 0), "$(eye) 0▶ 0❓");
});
