/**
 * GitWorktreeManager — the `git worktree` lifecycle under `.argus/worktrees/`.
 *
 * This is the host-side adapter behind the WorktreeManager contract. It bakes
 * in the four Spike C verdicts (see `.argus-spikes/C-worktrees.md`), which are
 * the real spec for the tricky parts:
 *
 *   1. Concurrent `worktree add` is safe on git 2.51 — serialization is NOT
 *      load-bearing. We keep an internal promise-chain anyway (decision D7,
 *      belt-and-suspenders) so that ordering is deterministic and cheap.
 *   2. Removal must tolerate untracked files (agents always leave some) and
 *      the Windows "deregistered-but-orphaned" failure: `--force` can drop the
 *      worktree from git metadata yet fail to delete the directory. So we
 *      always verify the directory is actually gone and fall back to `fs.rm`
 *      + `git worktree prune`.
 *   3. `core.longpaths` is off by default and breaks add / blinds status /
 *      breaks removal on deep paths. We enable it once per manager instance on
 *      win32 before the first `worktree add`.
 *   4. Provisioning strategy (node_modules) is out of scope for this class —
 *      the orchestrator installs deps; we only own the worktree + branch.
 *
 * Host-only. Imports node builtins exclusively — never `vscode`, never the SDK.
 */

import { execFile } from 'node:child_process';
import { stat, rm } from 'node:fs/promises';
import * as path from 'node:path';

import type { TaskId } from '../core/types';
import type { WorktreeInfo, WorktreeManager } from './contracts';

// ---------------------------------------------------------------------------
// Exec injection
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code; captured, never thrown on non-zero. */
  exitCode: number;
}

/**
 * A single subprocess invocation. Injectable so unit tests can stub git, but
 * most tests should drive the real thing (git is fast at this scale — Spike C
 * measured ~300 ms per add).
 */
export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string },
) => Promise<ExecResult>;

/**
 * Default ExecFn: wraps `child_process.execFile`. Never uses a shell (no
 * `shell: true` — args are passed as an array, immune to quoting/injection),
 * always `windowsHide: true`, and RESOLVES on non-zero exit with the code
 * captured rather than throwing. Only a genuine spawn failure (e.g. git not on
 * PATH → ENOENT, a string `code`) rejects.
 */
const defaultExec: ExecFn = (file, args, opts) =>
  new Promise<ExecResult>((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code !== 'number') {
          // Spawn failure (ENOENT, EACCES, …) — genuinely exceptional.
          reject(error);
          return;
        }
        const exitCode =
          error && typeof (error as { code?: number }).code === 'number'
            ? (error as { code: number }).code
            : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      },
    );
  });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Task-id shape allowed on the filesystem. Kebab slug, no dots/slashes/upper. */
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Relative location of the worktree pool under the repo root. */
const POOL_REL = ['.argus', 'worktrees'];

// ---------------------------------------------------------------------------
// GitWorktreeManager
// ---------------------------------------------------------------------------

export class GitWorktreeManager implements WorktreeManager {
  private readonly repoRoot: string;
  private readonly exec: ExecFn;

  /** Serializing tail — every op chains off this (Spike C: not load-bearing). */
  private queue: Promise<unknown> = Promise.resolve();

  /** `core.longpaths` set once per instance on win32 before the first add. */
  private longpathsEnsured = false;

  constructor(repoRoot: string, opts?: { exec?: ExecFn }) {
    this.repoRoot = repoRoot;
    this.exec = opts?.exec ?? defaultExec;
  }

  // -- public contract ------------------------------------------------------

  provision(taskId: TaskId): Promise<WorktreeInfo> {
    return this.enqueue(() => this.doProvision(taskId));
  }

  remove(
    taskId: TaskId,
    opts?: { force?: boolean; deleteBranch?: boolean },
  ): Promise<void> {
    return this.enqueue(() => this.doRemove(taskId, opts));
  }

  list(): Promise<WorktreeInfo[]> {
    return this.enqueue(() => this.doList());
  }

  findStale(liveTaskIds: readonly TaskId[]): Promise<WorktreeInfo[]> {
    return this.enqueue(async () => {
      const live = new Set(liveTaskIds);
      const all = await this.doList();
      return all.filter((w) => !live.has(w.taskId));
    });
  }

  // -- provisioning ---------------------------------------------------------

  private async doProvision(taskId: TaskId): Promise<WorktreeInfo> {
    const info = this.infoFor(taskId); // validates taskId

    await this.ensureLongpaths();

    // No auto-reuse: if the target dir already exists, the orchestrator — not
    // us — decides what to do with it.
    if (await pathExists(info.path)) {
      throw new Error(
        `provision(${taskId}): worktree path already exists: ${info.path}`,
      );
    }

    // `-b <branch>` fails loudly if the branch already exists; git's own
    // message ("a branch named 'argus/…' already exists") is clear enough.
    const r = await this.git(['worktree', 'add', info.path, '-b', info.branch]);
    if (r.exitCode !== 0) {
      throw new Error(
        `provision(${taskId}): git worktree add failed (exit ${r.exitCode}): ` +
          firstLine(r.stderr || r.stdout),
      );
    }
    return info;
  }

  /**
   * Spike C verdict (iii): `core.longpaths` is unset (→ false) at every scope
   * on Windows and its absence breaks `add`, silently blinds `status`, and
   * breaks `remove` on the deep `.argus/worktrees/<id>/…node_modules…` paths.
   * Enable it repo-locally, once, before the first add. No-op off win32.
   */
  private async ensureLongpaths(): Promise<void> {
    if (this.longpathsEnsured) {
      return;
    }
    this.longpathsEnsured = true;
    if (process.platform !== 'win32') {
      return;
    }
    const r = await this.git(['config', 'core.longpaths', 'true']);
    if (r.exitCode !== 0) {
      // Reset so a later provision retries — the flag is a hard prerequisite.
      this.longpathsEnsured = false;
      throw new Error(
        `provision: could not set core.longpaths (exit ${r.exitCode}): ` +
          firstLine(r.stderr),
      );
    }
  }

  // -- removal --------------------------------------------------------------

  /**
   * Remove a task's worktree and (optionally) its branch.
   *
   * ORDERING CONTRACT — the caller MUST have stopped the task's agent process
   * and waited for it to exit BEFORE calling this. Spike C attempt 2: removing
   * while a subprocess still holds a handle inside the worktree makes
   * `--force` deregister the worktree from git metadata yet leave the locked
   * directory on disk (Permission denied), producing an orphan git can no
   * longer see. This method cannot detect a live holder — it can only clean up
   * after one, which is strictly worse. Kill first, then remove.
   *
   * Sequence (Spike C verdict ii):
   *   1. plain `git worktree remove` (unless `force` is requested up front);
   *   2. on failure → `git worktree remove --force` (agents always leave
   *      untracked files, which trip the plain guard);
   *   3. VERIFY the directory is gone — `--force` can deregister yet fail the
   *      delete (Permission denied / Filename too long). If still present,
   *      `fs.rm(..., { recursive, force, maxRetries: 3 })` then `worktree prune`;
   *   4. verify again — if STILL present, throw naming the orphaned path.
   * Branch deletion (`git branch -D`) runs last; its failure is ignored (the
   * branch may already have been merged and deleted).
   */
  private async doRemove(
    taskId: TaskId,
    opts?: { force?: boolean; deleteBranch?: boolean },
  ): Promise<void> {
    const info = this.infoFor(taskId); // validates taskId

    // Distinguish "you asked to remove something that was never provisioned"
    // from a real teardown, so the caller gets a clear error instead of git's
    // opaque "is not a working tree".
    if (!(await pathExists(info.path))) {
      throw new Error(
        `remove(${taskId}): no worktree at ${info.path} (never provisioned or already removed)`,
      );
    }

    // (1) + (2): plain remove, then escalate to --force. If the caller asked
    // for force up front (contract's `force` option → `--force`), skip plain.
    if (!opts?.force) {
      const plain = await this.git(['worktree', 'remove', info.path]);
      if (plain.exitCode !== 0) {
        await this.git(['worktree', 'remove', '--force', info.path]);
      }
    } else {
      await this.git(['worktree', 'remove', '--force', info.path]);
    }

    // (3): git may have deregistered the worktree but failed the on-disk
    // delete. Force the filesystem removal, then prune the dangling metadata.
    if (await pathExists(info.path)) {
      await rm(info.path, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 250,
      });
      await this.git(['worktree', 'prune']);
    }

    // (4): last-chance verification. A survivor here is a hard failure — name
    // it so the operator can deal with the orphan.
    if (await pathExists(info.path)) {
      throw new Error(
        `remove(${taskId}): worktree directory could not be deleted (orphaned): ${info.path}`,
      );
    }

    if (opts?.deleteBranch) {
      // Failure ignored — the branch may already be gone (merged/deleted).
      await this.git(['branch', '-D', info.branch]);
    }
  }

  // -- listing --------------------------------------------------------------

  private async doList(): Promise<WorktreeInfo[]> {
    const r = await this.git(['worktree', 'list', '--porcelain']);
    if (r.exitCode !== 0) {
      throw new Error(
        `list: git worktree list failed (exit ${r.exitCode}): ${firstLine(r.stderr)}`,
      );
    }

    const poolPrefix = normalizeForCompare(this.poolRoot()) + '/';
    const out: WorktreeInfo[] = [];

    for (const stanza of parsePorcelain(r.stdout)) {
      if (!stanza.worktree) {
        continue;
      }
      const cmp = normalizeForCompare(stanza.worktree);
      if (!cmp.startsWith(poolPrefix)) {
        continue; // main worktree and any worktree outside our pool.
      }
      const taskId = path.basename(stanza.worktree);
      if (!TASK_ID_RE.test(taskId)) {
        continue; // foreign directory name — not one of ours.
      }
      out.push({
        taskId,
        path: toSlash(stanza.worktree),
        branch: stanza.branch ?? `argus/${taskId}`,
      });
    }
    return out;
  }

  // -- helpers --------------------------------------------------------------

  private infoFor(taskId: TaskId): WorktreeInfo {
    if (!TASK_ID_RE.test(taskId)) {
      throw new Error(
        `invalid task id ${JSON.stringify(taskId)}: must match ${TASK_ID_RE.source}`,
      );
    }
    return {
      taskId,
      path: path.join(this.poolRoot(), taskId),
      branch: `argus/${taskId}`,
    };
  }

  private poolRoot(): string {
    return path.join(this.repoRoot, ...POOL_REL);
  }

  private git(args: string[]): Promise<ExecResult> {
    return this.exec('git', args, { cwd: this.repoRoot });
  }

  /**
   * Chain `fn` onto the serializing tail. Runs regardless of whether the prior
   * op resolved or rejected, and never lets one op's rejection poison the next.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

interface Stanza {
  worktree: string | null;
  branch: string | null;
}

/**
 * Parse `git worktree list --porcelain`. Stanzas are separated by blank lines;
 * each begins with `worktree <path>` and may carry `branch refs/heads/<name>`
 * (absent when detached). We keep only those two fields.
 */
function parsePorcelain(text: string): Stanza[] {
  const stanzas: Stanza[] = [];
  let cur: Stanza | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') {
      if (cur) {
        stanzas.push(cur);
        cur = null;
      }
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (cur) {
        stanzas.push(cur);
      }
      cur = { worktree: line.slice('worktree '.length), branch: null };
    } else if (cur && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      cur.branch = ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : ref;
    }
  }
  if (cur) {
    stanzas.push(cur);
  }
  return stanzas;
}

/** Backslashes → forward slashes; leave everything else. */
function toSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Normalize a path for prefix comparison on Windows: resolve, forward slashes,
 * lowercase (the filesystem is case-insensitive, and git and node can disagree
 * on drive-letter / separator casing).
 */
function normalizeForCompare(p: string): string {
  return toSlash(path.resolve(p)).toLowerCase();
}

function firstLine(s: string): string {
  const t = s.trim();
  const nl = t.indexOf('\n');
  return nl === -1 ? t : t.slice(0, nl);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
