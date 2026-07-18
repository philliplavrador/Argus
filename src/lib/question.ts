/**
 * Pure question-file logic: front-matter parsing, section extraction, and the
 * checkbox-tick answer serialization. No `vscode` imports — unit-testable
 * under node:test.
 *
 * The serializer is the heart of the answer contract (SPEC.md): it must flip
 * exactly one checkbox and insert notes under `## Notes`, preserving every
 * other byte of the file — line endings included — because the asking agent
 * polls the file for `[x]` and may diff or re-read it at any time.
 */

export interface QuestionOption {
  /** Option text after the checkbox, e.g. `**Catalog #** — exact *(recommended)*`. */
  text: string;
  checked: boolean;
  /** Absolute offset in the raw string of the checkbox state char (between `[` and `]`). */
  checkboxOffset: number;
  recommended: boolean;
}

export interface ParsedQuestion {
  frontmatter: Record<string, string | boolean>;
  title: string;
  /** Raw markdown body of the `## Context` section, trimmed. */
  context: string;
  options: QuestionOption[];
  /** Trimmed current contents of the `## Notes` body. */
  notes: string;
  /** Index of the ticked option, or null when unanswered. */
  answeredIndex: number | null;
  /** Index of the first option marked `*(recommended)*`, or null. */
  recommendedIndex: number | null;
  /** Dominant line ending of the file. */
  eol: "\n" | "\r\n";
  /** Absolute offset where the `## Notes` body starts (past the heading's line break). */
  notesBodyStart: number | null;
  /** Absolute offset where the `## Notes` body ends (EOF or the next heading). */
  notesBodyEnd: number | null;
  /** True when the `## Notes` heading is the last line and has no trailing line break. */
  notesHeadingAtEof: boolean;
}

export class AlreadyAnsweredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlreadyAnsweredError";
  }
}

interface Line {
  /** Line content without the terminator (and without a trailing \r). */
  text: string;
  /** Absolute offset of the first char of the line. */
  start: number;
  /** Absolute offset just past the line terminator (or EOF). */
  end: number;
}

function splitLines(raw: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\n") {
      lines.push({ text: raw.slice(start, i).replace(/\r$/, ""), start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < raw.length) {
    lines.push({ text: raw.slice(start), start, end: raw.length });
  }
  return lines;
}

function parseFrontmatter(lines: Line[]): { data: Record<string, string | boolean>; bodyStartLine: number } {
  const data: Record<string, string | boolean> = {};
  if (lines.length === 0 || lines[0].text.replace(new RegExp("^\\uFEFF"), "").trim() !== "---") {
    return { data, bodyStartLine: 0 };
  }
  let i = 1;
  for (; i < lines.length; i++) {
    const t = lines[i].text;
    if (t.trim() === "---") {
      i++;
      break;
    }
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(t);
    if (!m) {
      continue; // tolerate malformed lines; keys are flat strings/bools
    }
    let value = m[2].trim();
    if ((/^".*"$/.test(value) || /^'.*'$/.test(value)) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (value === "true") {
      data[m[1]] = true;
    } else if (value === "false") {
      data[m[1]] = false;
    } else {
      data[m[1]] = value;
    }
  }
  return { data, bodyStartLine: i };
}

export function parseQuestion(raw: string): ParsedQuestion {
  const eol: "\n" | "\r\n" = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(raw);
  const { data, bodyStartLine } = parseFrontmatter(lines);

  type Section = "none" | "context" | "options" | "notes";
  let section: Section = "none";
  const contextParts: string[] = [];
  const notesParts: string[] = [];
  const options: QuestionOption[] = [];
  let notesBodyStart: number | null = null;
  let notesBodyEnd: number | null = null;
  let notesHeadingAtEof = false;

  for (let i = bodyStartLine; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^##\s+(.+?)\s*$/.exec(line.text);
    if (heading) {
      // Any heading closes an open notes region.
      if (section === "notes" && notesBodyStart !== null && notesBodyEnd === raw.length) {
        notesBodyEnd = line.start;
      }
      const name = heading[1].toLowerCase();
      if (name === "context") {
        section = "context";
      } else if (name === "options") {
        section = "options";
      } else if (name === "notes") {
        section = "notes";
        const hasTerminator = line.end > line.start && raw[line.end - 1] === "\n";
        notesHeadingAtEof = !hasTerminator;
        notesBodyStart = line.end;
        notesBodyEnd = raw.length;
      } else {
        section = "none";
      }
      continue;
    }
    if (section === "context") {
      contextParts.push(line.text);
    } else if (section === "options") {
      const m = /^(\s*-\s*\[)( |x|X)(\]\s?)(.*)$/.exec(line.text);
      if (m) {
        options.push({
          text: m[4],
          checked: m[2] !== " ",
          checkboxOffset: line.start + m[1].length,
          recommended: /\(recommended\)/i.test(m[4]),
        });
      }
    } else if (section === "notes") {
      notesParts.push(line.text);
    }
  }

  const answered = options.findIndex((o) => o.checked);
  const recommended = options.findIndex((o) => o.recommended);
  return {
    frontmatter: data,
    title: typeof data.title === "string" ? data.title : "",
    context: contextParts.join("\n").trim(),
    options,
    notes: notesParts.join("\n").trim(),
    answeredIndex: answered === -1 ? null : answered,
    recommendedIndex: recommended === -1 ? null : recommended,
    eol,
    notesBodyStart,
    notesBodyEnd,
    notesHeadingAtEof,
  };
}

export function isAnswered(raw: string): boolean {
  return parseQuestion(raw).answeredIndex !== null;
}

/**
 * Produce the answered file content: tick option `optionIndex` and write
 * `notes` under `## Notes`. Every byte outside the flipped checkbox char and
 * the notes body region is preserved exactly (CRLF/LF, BOM, trailing
 * whitespace — everything).
 *
 * Throws RangeError for an out-of-range option, AlreadyAnsweredError when a
 * *different* option is already ticked (re-submitting the same one is a no-op
 * for the checkbox).
 */
export function serializeAnswer(raw: string, optionIndex: number, notes: string): string {
  const q = parseQuestion(raw);
  const opt = q.options[optionIndex];
  if (!opt) {
    throw new RangeError(`option index ${optionIndex} out of range (${q.options.length} options)`);
  }
  if (q.answeredIndex !== null && q.answeredIndex !== optionIndex) {
    throw new AlreadyAnsweredError("a different option is already ticked");
  }

  interface TextEdit {
    start: number;
    end: number;
    text: string;
  }
  const edits: TextEdit[] = [];

  if (!opt.checked) {
    edits.push({ start: opt.checkboxOffset, end: opt.checkboxOffset + 1, text: "x" });
  }

  const trimmedNotes = notes.replace(/\s+$/, "");
  if (trimmedNotes.trim() !== q.notes) {
    const body =
      trimmedNotes === ""
        ? ""
        : trimmedNotes.replace(/\r\n/g, "\n").split("\n").join(q.eol) + q.eol;
    if (q.notesBodyStart !== null && q.notesBodyEnd !== null) {
      const lead = q.notesHeadingAtEof && body !== "" ? q.eol : "";
      edits.push({ start: q.notesBodyStart, end: q.notesBodyEnd, text: lead + body });
    } else if (body !== "") {
      // Defensive: no ## Notes section in the file — append one at EOF.
      const lead = raw.endsWith("\n") ? "" : q.eol;
      edits.push({ start: raw.length, end: raw.length, text: `${lead}## Notes${q.eol}${body}` });
    }
  }

  // Apply highest-offset first so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = raw;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}
