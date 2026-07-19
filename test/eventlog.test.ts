import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlEventLog } from "../src/host/eventlog";
import type { ArgusEvent, ArgusEventBody } from "../src/core/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "argus-eventlog-"));
}

/** A minimal, contract-valid event body. */
function body(taskId = "t1"): ArgusEventBody {
  return { type: "task-queued", taskId };
}

/** A fixed-step clock: ts1, ts2, ... so timestamps are assertable. */
function fakeClock(): () => string {
  let n = 0;
  return () => `2026-01-01T00:00:0${n++}.000Z`;
}

async function readLines(file: string): Promise<string[]> {
  const content = await readFile(file, "utf8");
  return content.split("\n").filter((l) => l.trim() !== "");
}

// ---------------------------------------------------------------------------
// append: stamping + disk shape
// ---------------------------------------------------------------------------

test("append stamps seq 1,2,3 and ts from injected now", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "state", "events.jsonl");
    const log = new JsonlEventLog(file, { now: fakeClock() });

    const e1 = await log.append(body());
    const e2 = await log.append(body());
    const e3 = await log.append(body());

    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.equal(e3.seq, 3);
    assert.equal(e1.ts, "2026-01-01T00:00:00.000Z");
    assert.equal(e2.ts, "2026-01-01T00:00:01.000Z");
    assert.equal(e3.ts, "2026-01-01T00:00:02.000Z");
    assert.equal(e1.type, "task-queued");

    await log.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lines on disk are valid JSONL matching returned events", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "events.jsonl");
    const log = new JsonlEventLog(file, { now: fakeClock() });

    const returned = [
      await log.append(body("a")),
      await log.append(body("b")),
      await log.append(body("c")),
    ];
    await log.close();

    const lines = await readLines(file);
    assert.equal(lines.length, 3);
    const onDisk = lines.map((l) => JSON.parse(l) as ArgusEvent);
    assert.deepEqual(onDisk, returned);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("append lazily creates the parent directory", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "deep", "nested", "events.jsonl");
    const log = new JsonlEventLog(file, { now: fakeClock() });
    assert.equal(existsSync(join(dir, "deep")), false);

    await log.append(body());
    assert.equal(existsSync(file), true);

    await log.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

test("replay of a fresh/missing dir yields empty, 0 skipped", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "does", "not", "exist.jsonl");
    const log = new JsonlEventLog(file, { now: fakeClock() });
    const { events, skippedLines } = await log.replay();
    assert.deepEqual(events, []);
    assert.equal(skippedLines, 0);
    await log.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("append-then-replay round-trip", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "events.jsonl");
    const log = new JsonlEventLog(file, { now: fakeClock() });
    const appended = [
      await log.append(body("a")),
      await log.append(body("b")),
    ];

    const { events, skippedLines } = await log.replay();
    assert.equal(skippedLines, 0);
    assert.deepEqual(events, appended);

    await log.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt file: bad lines counted, good events kept, seq continues", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "events.jsonl");
    await mkdir(dir, { recursive: true });

    // Two valid events (seq 1, 2), a garbage line in the middle, a blank line,
    // and a truncated final line (crash mid-write). The blank line is NOT
    // counted; the garbage and truncated lines ARE.
    const good1 = JSON.stringify({ seq: 1, ts: "x", type: "task-queued", taskId: "a" });
    const good2 = JSON.stringify({ seq: 2, ts: "x", type: "task-queued", taskId: "b" });
    const garbage = "{not valid json";
    const truncated = '{"seq":3,"ts":"x","type":"task-que'; // cut off mid-write
    const contents = [good1, garbage, "", good2, truncated].join("\n");
    await writeFile(file, contents, "utf8");

    const log = new JsonlEventLog(file, { now: fakeClock() });
    const { events, skippedLines } = await log.replay();

    assert.equal(events.length, 2);
    assert.equal(events[0].seq, 1);
    assert.equal(events[1].seq, 2);
    assert.equal(skippedLines, 2); // garbage + truncated, blank not counted

    // lastSeq continued from max valid seq (2) → next append is 3.
    const next = await log.append(body("c"));
    assert.equal(next.seq, 3);

    await log.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replay: a line lacking a numeric seq is skipped and counted", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "events.jsonl");
    await mkdir(dir, { recursive: true });
    const noSeq = JSON.stringify({ ts: "x", type: "task-queued", taskId: "a" });
    const strSeq = JSON.stringify({ seq: "2", ts: "x", type: "task-queued", taskId: "b" });
    const good = JSON.stringify({ seq: 5, ts: "x", type: "task-queued", taskId: "c" });
    await writeFile(file, [noSeq, strSeq, good].join("\n") + "\n", "utf8");

    const log = new JsonlEventLog(file, { now: fakeClock() });
    const { events, skippedLines } = await log.replay();
    assert.equal(events.length, 1);
    assert.equal(events[0].seq, 5);
    assert.equal(skippedLines, 2);

    const next = await log.append(body("d"));
    assert.equal(next.seq, 6); // continues from max seen (5)

    await log.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Concurrency: no interleaving, distinct sequential seqs
// ---------------------------------------------------------------------------

test("50 concurrent appends produce 50 distinct sequential seqs, no interleaving", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "events.jsonl");
    const log = new JsonlEventLog(file, { now: fakeClock() });

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => log.append(body(`t${i}`))),
    );
    await log.close();

    const seqs = results.map((e) => e.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1));

    // 50 well-formed lines on disk, each parseable, seqs 1..50.
    const lines = await readLines(file);
    assert.equal(lines.length, 50);
    const diskSeqs = lines
      .map((l) => (JSON.parse(l) as ArgusEvent).seq)
      .sort((a, b) => a - b);
    assert.deepEqual(diskSeqs, Array.from({ length: 50 }, (_, i) => i + 1));

    // Disk order matches issue order (serialized, no interleaving).
    const diskInOrder = lines.map((l) => (JSON.parse(l) as ArgusEvent).seq);
    assert.deepEqual(diskInOrder, Array.from({ length: 50 }, (_, i) => i + 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

test("listeners fire after the write, in registration order", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "events.jsonl");
    const log = new JsonlEventLog(file, { now: fakeClock() });

    const calls: string[] = [];
    log.onEvent((e) => {
      // The write must have resolved before firing: line is already on disk.
      const onDisk = existsSync(file);
      calls.push(`A:${e.seq}:${onDisk}`);
    });
    log.onEvent((e) => calls.push(`B:${e.seq}`));

    await log.append(body());
    await log.append(body());
    await log.close();

    assert.deepEqual(calls, ["A:1:true", "B:1", "A:2:true", "B:2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disposed listener stops firing", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "events.jsonl");
    const log = new JsonlEventLog(file, { now: fakeClock() });

    const seen: number[] = [];
    const sub = log.onEvent((e) => seen.push(e.seq));

    await log.append(body());
    sub.dispose();
    await log.append(body());
    await log.close();

    assert.deepEqual(seen, [1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a throwing listener does not break the chain or other listeners", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "events.jsonl");
    const log = new JsonlEventLog(file, { now: fakeClock() });

    const seen: number[] = [];
    log.onEvent(() => {
      throw new Error("boom");
    });
    log.onEvent((e) => seen.push(e.seq));

    const e1 = await log.append(body());
    const e2 = await log.append(body());
    await log.close();

    // Other listener still saw both events...
    assert.deepEqual(seen, [1, 2]);
    // ...and the append chain kept working (seqs advanced, both durable).
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    const lines = await readLines(file);
    assert.equal(lines.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

test("close then append rejects", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "events.jsonl");
    const log = new JsonlEventLog(file, { now: fakeClock() });
    await log.append(body());
    await log.close();

    await assert.rejects(() => log.append(body()), /closed/);

    // The pre-close append is still on disk; close did not lose it.
    const lines = await readLines(file);
    assert.equal(lines.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("close drains appends enqueued before it", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "events.jsonl");
    const log = new JsonlEventLog(file, { now: fakeClock() });

    // Fire several appends without awaiting, then close immediately.
    const pending = Array.from({ length: 10 }, (_, i) => log.append(body(`t${i}`)));
    await log.close();

    const events = await Promise.all(pending);
    assert.equal(events.length, 10);

    const lines = await readLines(file);
    assert.equal(lines.length, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
