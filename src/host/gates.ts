/**
 * GateRunner: run one verify gate (a shell command) in a worktree.
 * Gates are user-declared commands (`npm test`, `npm run typecheck`) — they
 * need a shell. Output is capped to the last 4KB, which is what a human needs
 * to act on a failure from the inbox.
 *
 * Two Windows realities from the adversarial review are handled explicitly:
 * a timeout must kill the whole process TREE (node's exec timeout terminates
 * only cmd.exe, orphaning npm/node children that then hold worktree handles),
 * and a maxBuffer overflow must be reported as what it is, not mislabeled as
 * a timeout.
 */

import { exec, execFile } from 'node:child_process';
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
      let timedOut = false;
      const child = exec(
        gate.command,
        { cwd: worktreePath, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          clearTimeout(timer);
          const combined = `${stdout}\n${stderr}`.trim();
          const tail =
            combined.length > OUTPUT_TAIL_BYTES ? combined.slice(-OUTPUT_TAIL_BYTES) : combined;
          const overflow = err !== null && /maxBuffer/i.test(err.message);
          resolve({
            exitCode: timedOut ? 124 : err === null ? 0 : (err.code as number | undefined) ?? 1,
            outputTail: timedOut
              ? `${tail}\n(gate timed out after ${GATE_TIMEOUT_MS / 60000} minutes; process tree killed)`
              : overflow
                ? `${tail}\n(gate output exceeded the 16MB capture buffer — result discarded, treat as failing and reduce output)`
                : tail,
            durationMs: Date.now() - started,
          });
        },
      );
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, GATE_TIMEOUT_MS);
    });
  }
}

/** Kill the whole tree: on Windows `taskkill /T`, elsewhere a plain kill. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}
