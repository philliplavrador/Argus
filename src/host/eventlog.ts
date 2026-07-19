/**
 * Durable append-only EventLog over a JSONL file (`.argus/state/events.jsonl`).
 *
 * Every append stamps a monotonic `seq` and an ISO `ts`, writes exactly one
 * `JSON.stringify(event) + '\n'` line, and — only after that write resolves —
 * notifies listeners in registration order. All appends funnel through a single
 * internal promise chain, so lines never interleave and listeners always fire
 * in append order. Replay tolerates a truncated final line (the process may have
 * died mid-write) and any garbage line by skipping and counting it.
 *
 * Host-only module: imports node builtins, never `vscode` or the SDK.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ArgusEvent, ArgusEventBody } from '../core/types';
import type { Disposable, EventLog } from './contracts';

/** Injectable clock, so tests can assert deterministic timestamps. */
type NowFn = () => string;

export class JsonlEventLog implements EventLog {
  private readonly filePath: string;
  private readonly now: NowFn;

  private readonly listeners = new Set<(e: ArgusEvent) => void>();

  /** Serializes every append; also the thing `close()` drains. Never rejects. */
  private chain: Promise<void> = Promise.resolve();

  /** Highest seq committed to disk. Advanced by append and by replay. */
  private lastSeq = 0;

  /** Set once the parent dir has been ensured, to avoid repeat mkdir calls. */
  private dirReady = false;

  private closed = false;

  constructor(filePath: string, opts?: { now?: NowFn }) {
    this.filePath = filePath;
    this.now = opts?.now ?? (() => new Date().toISOString());
  }

  append(body: ArgusEventBody): Promise<ArgusEvent> {
    if (this.closed) {
      return Promise.reject(new Error('JsonlEventLog is closed'));
    }
    const task = this.chain.then(() => this.doAppend(body));
    // Keep the chain alive regardless of this append's outcome: a failed write
    // must not poison later appends, and close() must still be able to drain.
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async doAppend(body: ArgusEventBody): Promise<ArgusEvent> {
    const seq = this.lastSeq + 1;
    const ts = this.now();
    const event = { seq, ts, ...body } as ArgusEvent;
    const line = JSON.stringify(event) + '\n';

    await this.ensureDir();
    await appendFile(this.filePath, line, 'utf8');
    // Commit the seq only after the write is durable.
    this.lastSeq = seq;

    // Notify after the write resolves, in registration order. A throwing
    // listener must not break the chain or starve later listeners.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Swallow: listener faults are their own problem.
      }
    }
    return event;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) {
      return;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    this.dirReady = true;
  }

  async replay(): Promise<{ events: ArgusEvent[]; skippedLines: number }> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { events: [], skippedLines: 0 };
      }
      throw err;
    }

    const events: ArgusEvent[] = [];
    let skippedLines = 0;
    let maxSeq = this.lastSeq;

    for (const raw of content.split('\n')) {
      // Empty / whitespace-only segments (e.g. the tail after a trailing
      // newline, or intentional blank lines) are not content — skip silently.
      if (raw.trim() === '') {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        skippedLines += 1;
        continue;
      }
      if (!hasNumericSeq(parsed)) {
        skippedLines += 1;
        continue;
      }
      const event = parsed as ArgusEvent;
      events.push(event);
      if (event.seq > maxSeq) {
        maxSeq = event.seq;
      }
    }

    // Continue the sequence from the highest seq observed on disk.
    this.lastSeq = maxSeq;
    return { events, skippedLines };
  }

  onEvent(listener: (e: ArgusEvent) => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    // Drain any appends already enqueued; the chain never rejects.
    await this.chain;
  }
}

/** A parsed line is a usable event only if it carries a finite numeric `seq`. */
function hasNumericSeq(value: unknown): value is { seq: number } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const seq = (value as Record<string, unknown>).seq;
  return typeof seq === 'number' && Number.isFinite(seq);
}
