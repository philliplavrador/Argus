/**
 * GateRunner: run one verify gate (a shell command) in a worktree.
 * Gates are user-declared commands (`npm test`, `npm run typecheck`) — they
 * need a shell. Output is capped to the last 4KB, which is what a human needs
 * to act on a failure from the inbox.
 */

import { exec } from 'node:child_process';
import type { GateRunner } from './contracts';

const OUTPUT_TAIL_BYTES = 4096;
const GATE_TIMEOUT_MS = 15 * 60 * 1000;

export class ShellGateRunner implements GateRunner {
  run(
    worktreePath: string,
    gate: { name: string; command: string },
  ): Promise<{ exitCode: number; outputTail: string; durationMs: number }> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = exec(
        gate.command,
        { cwd: worktreePath, timeout: GATE_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const combined = `${stdout}\n${stderr}`.trim();
          const outputTail =
            combined.length > OUTPUT_TAIL_BYTES ? combined.slice(-OUTPUT_TAIL_BYTES) : combined;
          const timedOut = err !== null && child.killed;
          resolve({
            exitCode: timedOut ? 124 : err === null ? 0 : (err.code as number | undefined) ?? 1,
            outputTail: timedOut ? `${outputTail}\n(gate timed out after ${GATE_TIMEOUT_MS / 60000} minutes)` : outputTail,
            durationMs: Date.now() - started,
          });
        },
      );
    });
  }
}
