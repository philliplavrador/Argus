import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AlreadyAnsweredError,
  isAnswered,
  isTemplatePlaceholder,
  NotesConflictError,
  parseQuestion,
  serializeAnswer,
  StaleQuestionError,
} from "../src/lib/question";

const LF_FIXTURE =
  [
    "---",
    "task: supplier-dedupe-rule",
    "agent: supplier-dedupe-rule",
    "title: Match duplicate suppliers on catalog number or name?",
    "blocking: true",
    "asked: 2026-07-18T18:12:00Z",
    "---",
    "",
    "## Context",
    "One short paragraph. May embed images, e.g. ../assets/supplier-dedupe-rule-match/shot-1.png",
    "",
    "## Options",
    "- [ ] **Catalog #** — exact, no false merges *(recommended)*",
    "- [ ] **Name** — catches typo'd catalog numbers",
    "- [ ] **Both** — merge only if both agree",
    "",
    "## Notes",
  ].join("\n") + "\n";

const CRLF_FIXTURE = LF_FIXTURE.replace(/\n/g, "\r\n");

/** Positions where two equal-length strings differ. */
function diffPositions(a: string, b: string): number[] {
  assert.equal(a.length, b.length, "diffPositions requires equal lengths");
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      out.push(i);
    }
  }
  return out;
}

test("parses front-matter keys as flat strings and booleans", () => {
  const q = parseQuestion(LF_FIXTURE);
  assert.equal(q.frontmatter.task, "supplier-dedupe-rule");
  assert.equal(q.frontmatter.agent, "supplier-dedupe-rule");
  assert.equal(q.title, "Match duplicate suppliers on catalog number or name?");
  assert.equal(q.frontmatter.blocking, true);
  assert.equal(q.frontmatter.asked, "2026-07-18T18:12:00Z");
});

test("extracts context, options, recommended marker, and notes", () => {
  const q = parseQuestion(LF_FIXTURE);
  assert.match(q.context, /^One short paragraph/);
  assert.equal(q.options.length, 3);
  assert.equal(q.options[0].text, "**Catalog #** — exact, no false merges *(recommended)*");
  assert.equal(q.options[1].text, "**Name** — catches typo'd catalog numbers");
  assert.equal(q.options[0].recommended, true);
  assert.equal(q.options[1].recommended, false);
  assert.equal(q.recommendedIndex, 0);
  assert.equal(q.answeredIndex, null);
  assert.equal(q.notes, "");
  assert.equal(q.eol, "\n");
});

test("detects CRLF files and parses them identically", () => {
  const q = parseQuestion(CRLF_FIXTURE);
  assert.equal(q.eol, "\r\n");
  assert.equal(q.options.length, 3);
  assert.equal(q.recommendedIndex, 0);
  assert.equal(q.answeredIndex, null);
});

test("answeredIndex reflects a ticked checkbox", () => {
  const answered = LF_FIXTURE.replace("- [ ] **Name**", "- [x] **Name**");
  const q = parseQuestion(answered);
  assert.equal(q.answeredIndex, 1);
  assert.equal(isAnswered(answered), true);
  assert.equal(isAnswered(LF_FIXTURE), false);
});

test("LF: ticking with no notes changes exactly one byte", () => {
  const out = serializeAnswer(LF_FIXTURE, 0, "");
  assert.equal(out.length, LF_FIXTURE.length);
  const diffs = diffPositions(LF_FIXTURE, out);
  assert.equal(diffs.length, 1);
  assert.equal(LF_FIXTURE[diffs[0]], " ");
  assert.equal(out[diffs[0]], "x");
  assert.equal(parseQuestion(out).answeredIndex, 0);
});

test("CRLF: ticking with no notes changes exactly one byte", () => {
  const out = serializeAnswer(CRLF_FIXTURE, 2, "");
  assert.equal(out.length, CRLF_FIXTURE.length);
  const diffs = diffPositions(CRLF_FIXTURE, out);
  assert.equal(diffs.length, 1);
  assert.equal(out[diffs[0]], "x");
  assert.equal(parseQuestion(out).answeredIndex, 2);
});

test("CRLF: notes are inserted with CRLF endings, everything before Notes untouched", () => {
  const out = serializeAnswer(CRLF_FIXTURE, 1, "Prefer catalog #.\nName merging felt risky.");
  const q = parseQuestion(CRLF_FIXTURE);
  assert.ok(q.notesBodyStart !== null);
  const expectedPrefix =
    CRLF_FIXTURE.slice(0, q.options[1].checkboxOffset) +
    "x" +
    CRLF_FIXTURE.slice(q.options[1].checkboxOffset + 1, q.notesBodyStart!);
  assert.ok(out.startsWith(expectedPrefix), "prefix through ## Notes must be byte-identical bar the tick");
  assert.ok(out.endsWith("Prefer catalog #.\r\nName merging felt risky.\r\n"));
  assert.equal(/(?<!\r)\n/.test(out), false, "no lone LF may appear in a CRLF file");
  const reparsed = parseQuestion(out);
  assert.equal(reparsed.answeredIndex, 1);
  assert.equal(reparsed.notes, "Prefer catalog #.\nName merging felt risky.");
});

test("LF: notes are inserted with LF endings", () => {
  const out = serializeAnswer(LF_FIXTURE, 0, "Go with the exact key.");
  assert.ok(out.endsWith("## Notes\nGo with the exact key.\n"));
  assert.equal(out.includes("\r"), false);
});

test("prefilled notes: resubmitting identical notes leaves the region untouched", () => {
  const withNotes = LF_FIXTURE + "Existing note.\n";
  const out = serializeAnswer(withNotes, 0, "Existing note.");
  const diffs = diffPositions(withNotes, out);
  assert.equal(diffs.length, 1, "only the checkbox byte may change");
});

test("prefilled notes: changed notes replace only the notes body", () => {
  const withNotes = LF_FIXTURE + "Existing note.\n";
  const out = serializeAnswer(withNotes, 0, "Rewritten note.");
  const q = parseQuestion(withNotes);
  const expectedPrefix =
    withNotes.slice(0, q.options[0].checkboxOffset) +
    "x" +
    withNotes.slice(q.options[0].checkboxOffset + 1, q.notesBodyStart!);
  assert.ok(out.startsWith(expectedPrefix));
  assert.ok(out.endsWith("## Notes\nRewritten note.\n"));
});

test("notes heading at EOF without a line break still gets notes", () => {
  const noTrailing = LF_FIXTURE.replace(/\n$/, "");
  assert.ok(noTrailing.endsWith("## Notes"));
  const out = serializeAnswer(noTrailing, 0, "hi");
  assert.ok(out.endsWith("## Notes\nhi\n"));
});

test("re-submitting the already-ticked option is a no-op for the checkbox", () => {
  const answered = serializeAnswer(LF_FIXTURE, 1, "");
  const again = serializeAnswer(answered, 1, "");
  assert.equal(again, answered);
});

test("ticking a different option than the existing tick throws AlreadyAnsweredError", () => {
  const answered = serializeAnswer(LF_FIXTURE, 1, "");
  assert.throws(() => serializeAnswer(answered, 0, ""), AlreadyAnsweredError);
});

test("out-of-range option index throws RangeError", () => {
  assert.throws(() => serializeAnswer(LF_FIXTURE, 7, ""), RangeError);
});

test("a UTF-8 BOM is tolerated and preserved", () => {
  const withBom = "﻿" + LF_FIXTURE;
  const q = parseQuestion(withBom);
  assert.equal(q.title, "Match duplicate suppliers on catalog number or name?");
  assert.equal(q.options.length, 3);
  const out = serializeAnswer(withBom, 0, "");
  assert.equal(out[0], "﻿");
  const diffs = diffPositions(withBom, out);
  assert.equal(diffs.length, 1);
});

test("file without front-matter or sections parses without crashing", () => {
  const q = parseQuestion("just some text\nno structure here\n");
  assert.equal(q.title, "");
  assert.equal(q.options.length, 0);
  assert.equal(q.answeredIndex, null);
});

// --- adversarial-review regressions ---

const CATALOG_LINE = "- [ ] **Catalog #** — exact, no false merges *(recommended)*";
const NAME_LINE = "- [ ] **Name** — catches typo'd catalog numbers";

test("identity guard: an option reorder between render and submit is rejected", () => {
  const rendered = parseQuestion(LF_FIXTURE);
  const clickedText = rendered.options[1].text; // **Name** …
  // Dispatcher status sweep reorders recommended-first equivalent: swap 0 and 1.
  const mutated = LF_FIXTURE.replace(
    `${CATALOG_LINE}\n${NAME_LINE}`,
    `${NAME_LINE}\n${CATALOG_LINE}`,
  );
  assert.notEqual(mutated, LF_FIXTURE, "fixture mutation must apply");
  // Same index now holds a different option → refuse, never silently mis-tick.
  assert.throws(() => serializeAnswer(mutated, 1, "", { expectedOptionText: clickedText }), StaleQuestionError);
  // The identity check keys on text, so the option at its NEW index is fine.
  const ok = serializeAnswer(mutated, 0, "", { expectedOptionText: clickedText });
  assert.equal(parseQuestion(ok).options[0].checked, true);
});

test("notes guard: concurrently written notes are a conflict, never an overwrite", () => {
  const baselineAtRender = parseQuestion(LF_FIXTURE).notes; // ""
  const fileGainedNotes = LF_FIXTURE + "Concurrent note from the dispatcher.\n";
  assert.throws(
    () => serializeAnswer(fileGainedNotes, 0, "my stale typed notes", { notesBaseline: baselineAtRender }),
    NotesConflictError,
  );
  // Submitting exactly what the file now holds is not a conflict…
  const same = serializeAnswer(fileGainedNotes, 0, "Concurrent note from the dispatcher.", {
    notesBaseline: baselineAtRender,
  });
  assert.ok(same.includes("Concurrent note from the dispatcher."));
  // …and an unchanged file accepts freshly typed notes.
  const fresh = serializeAnswer(LF_FIXTURE, 0, "fresh notes", { notesBaseline: baselineAtRender });
  assert.ok(fresh.endsWith("fresh notes\n"));
});

test("multi-tick answers surface every ticked option, case-insensitively", () => {
  const multi = LF_FIXTURE.replace("- [ ] **Catalog #**", "- [x] **Catalog #**").replace(
    "- [ ] **Both**",
    "- [X] **Both**",
  );
  const q = parseQuestion(multi);
  assert.deepEqual(q.answeredIndices, [0, 2]);
  assert.equal(q.answeredIndex, 0);
  assert.equal(isAnswered(multi), true);
});

test("multi-tick: submitting a ticked option is a no-op; an unticked one still throws", () => {
  const multi = LF_FIXTURE.replace("- [ ] **Catalog #**", "- [x] **Catalog #**").replace(
    "- [ ] **Both**",
    "- [X] **Both**",
  );
  assert.equal(serializeAnswer(multi, 2, ""), multi);
  assert.equal(serializeAnswer(multi, 0, ""), multi);
  assert.throws(() => serializeAnswer(multi, 1, ""), AlreadyAnsweredError);
});

test("template placeholder signature is detected; real questions are not", () => {
  const template =
    [
      "---",
      "task: <taskid>",
      "agent: <agentName from your current STATUS.json>",
      "title: <the question — one sentence, ≤15 words, one decision, ends in ?>",
      "blocking: true|false",
      "asked: <ISO now>",
      "---",
      "",
      "## Context",
      "<≤1 short paragraph.>",
      "",
      "## Options",
      "- [ ] **<label ≤5 words>** — <why, ≤10 words> *(recommended)*",
      "- [ ] **<label>** — <why>",
      "",
      "## Notes",
    ].join("\n") + "\n";
  assert.equal(isTemplatePlaceholder(parseQuestion(template)), true);
  assert.equal(isTemplatePlaceholder(parseQuestion(LF_FIXTURE)), false);
  // A placeholder title alone is enough to lock the file.
  const titleOnly = LF_FIXTURE.replace(
    "title: Match duplicate suppliers on catalog number or name?",
    "title: <fill me in>",
  );
  assert.equal(isTemplatePlaceholder(parseQuestion(titleOnly)), true);
});
