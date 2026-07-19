import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile, realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { GitWorktreeManager } from "../src/host/worktrees";

// ---------------------------------------------------------------------------
// Real-git test harness
// ---------------------------------------------------------------------------

/** Run a command to completion; throw on non-zero (setup must not fail). */
function run(
  file: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${file} ${args.join(" ")} failed: ${stderr || error.message}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Init a throwaway git repo with one commit; return its realpath'd root. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "argus-wt-"));
  // Resolve any symlink / 8.3 quirks so paths match what git reports back.
  const root = await realpath(dir);
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.email", "test@argus.local"], root);
  await run("git", ["config", "user.name", "Argus Test"], root);
  await writeFile(path.join(root, "README.md"), "# fixture\n");
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", "init"], root);
  return root;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Register per-test cleanup that tolerates locked/deep dirs. */
function cleanupAfter(t: import("node:test").TestContext, root: string): void {
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
}

// ---------------------------------------------------------------------------
// provision
// ---------------------------------------------------------------------------

test("provision creates the worktree dir and branch", async (t) => {
  const root = await makeRepo();
  cleanupAfter(t, root);
  const mgr = new GitWorktreeManager(root);

  const info = await mgr.provision("feature-a");

  const expectedPath = path.join(root, ".argus", "worktrees", "feature-a");
  assert.equal(info.taskId, "feature-a");
  assert.equal(info.branch, "argus/feature-a");
  assert.equal(path.resolve(info.path), path.resolve(expectedPath));

  // Directory is really on disk.
  assert.ok(await exists(expectedPath), "worktree directory should exist");

  // git agrees the branch and worktree exist.
  const branches = await run("git", ["branch", "--list", "argus/feature-a"], root);
  assert.match(branches.stdout, /argus\/feature-a/);

  const wl = await run("git", ["worktree", "list", "--porcelain"], root);
  assert.match(wl.stdout.replace(/\\/g, "/"), /\.argus\/worktrees\/feature-a/);
});

test("provision rejects unsafe task ids", async (t) => {
  const root = await makeRepo();
  cleanupAfter(t, root);
  const mgr = new GitWorktreeManager(root);

  for (const bad of ["../evil", "UPPER", "a b", "", "has/slash", "dot.dot", "-lead"]) {
    await assert.rejects(
      () => mgr.provision(bad),
      /invalid task id/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }

  // Nothing got created for the rejected ids.
  assert.equal(await exists(path.join(root, ".argus", "worktrees")), false);
});

test("double-provision of the same id fails cleanly", async (t) => {
  const root = await makeRepo();
  cleanupAfter(t, root);
  const mgr = new GitWorktreeManager(root);

  await mgr.provision("dup");
  await assert.rejects(() => mgr.provision("dup"), /already exists/);

  // The first worktree is untouched and still registered exactly once.
  const wl = await run("git", ["worktree", "list", "--porcelain"], root);
  const hits = wl.stdout
    .replace(/\\/g, "/")
    .match(/\.argus\/worktrees\/dup(\s|$)/g);
  assert.equal(hits?.length, 1);
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

test("remove succeeds when the worktree has untracked files, and the dir is gone", async (t) => {
  const root = await makeRepo();
  cleanupAfter(t, root);
  const mgr = new GitWorktreeManager(root);

  const info = await mgr.provision("with-junk");
  // Agents always leave untracked files — this is what trips plain `remove`.
  await writeFile(path.join(info.path, "SCRATCH.txt"), "left behind\n");
  await mkdir(path.join(info.path, "subdir"), { recursive: true });
  await writeFile(path.join(info.path, "subdir", "more.txt"), "nested\n");

  await mgr.remove("with-junk");

  assert.equal(await exists(info.path), false, "worktree dir must be gone");
  // git no longer lists it.
  const wl = await run("git", ["worktree", "list", "--porcelain"], root);
  assert.doesNotMatch(wl.stdout.replace(/\\/g, "/"), /\.argus\/worktrees\/with-junk/);
});

test("remove with deleteBranch drops the branch too", async (t) => {
  const root = await makeRepo();
  cleanupAfter(t, root);
  const mgr = new GitWorktreeManager(root);

  await mgr.provision("branchy");
  await mgr.remove("branchy", { deleteBranch: true });

  const branches = await run("git", ["branch", "--list", "argus/branchy"], root);
  assert.equal(branches.stdout.trim(), "", "branch should be deleted");
});

test("remove of a never-provisioned id fails clearly", async (t) => {
  const root = await makeRepo();
  cleanupAfter(t, root);
  const mgr = new GitWorktreeManager(root);

  await assert.rejects(() => mgr.remove("ghost"), /no worktree at/);
});

// ---------------------------------------------------------------------------
// list / findStale
// ---------------------------------------------------------------------------

test("list ignores the main worktree and worktrees outside the pool", async (t) => {
  const root = await makeRepo();
  cleanupAfter(t, root);
  const mgr = new GitWorktreeManager(root);

  await mgr.provision("one");
  await mgr.provision("two");

  // A worktree that is NOT under .argus/worktrees/ — must be ignored by list().
  const outsideDir = path.join(root, "external-wt");
  await run("git", ["worktree", "add", outsideDir, "-b", "external-branch"], root);

  const listed = await mgr.list();
  const ids = listed.map((w) => w.taskId).sort();
  assert.deepEqual(ids, ["one", "two"]);

  for (const w of listed) {
    assert.equal(w.branch, `argus/${w.taskId}`);
    assert.match(w.path.replace(/\\/g, "/"), /\.argus\/worktrees\//);
  }
});

test("findStale returns only pool worktrees whose id is not live", async (t) => {
  const root = await makeRepo();
  cleanupAfter(t, root);
  const mgr = new GitWorktreeManager(root);

  await mgr.provision("live-1");
  await mgr.provision("live-2");
  await mgr.provision("stale-1");
  await mgr.provision("stale-2");

  const stale = await mgr.findStale(["live-1", "live-2"]);
  const ids = stale.map((w) => w.taskId).sort();
  assert.deepEqual(ids, ["stale-1", "stale-2"]);

  // Symmetric check: with everything live, nothing is stale.
  const none = await mgr.findStale(["live-1", "live-2", "stale-1", "stale-2"]);
  assert.deepEqual(none, []);
});

// ---------------------------------------------------------------------------
// concurrency + longpaths
// ---------------------------------------------------------------------------

test("three concurrent provisions all succeed (serialized internally)", async (t) => {
  const root = await makeRepo();
  cleanupAfter(t, root);
  const mgr = new GitWorktreeManager(root);

  const infos = await Promise.all([
    mgr.provision("conc-1"),
    mgr.provision("conc-2"),
    mgr.provision("conc-3"),
  ]);

  assert.deepEqual(infos.map((i) => i.taskId).sort(), ["conc-1", "conc-2", "conc-3"]);
  for (const info of infos) {
    assert.ok(await exists(info.path), `${info.taskId} dir should exist`);
  }

  const listed = await mgr.list();
  assert.deepEqual(listed.map((w) => w.taskId).sort(), ["conc-1", "conc-2", "conc-3"]);
});

test("provision enables core.longpaths in the repo (win32)", async (t) => {
  if (process.platform !== "win32") {
    t.skip("core.longpaths only relevant on win32");
    return;
  }
  const root = await makeRepo();
  cleanupAfter(t, root);
  const mgr = new GitWorktreeManager(root);

  await mgr.provision("lp");

  const cfg = await run("git", ["config", "--local", "core.longpaths"], root);
  assert.equal(cfg.stdout.trim(), "true");
});

// ---------------------------------------------------------------------------
// injected exec (unit-level: serialization ordering, no real git)
// ---------------------------------------------------------------------------

test("operations run through the serializing queue in call order", async () => {
  const order: string[] = [];
  let tick = 0;
  const exec = async (_file: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    // First call of each op records its start ordinal; a microtask delay makes
    // interleaving observable if the queue were not serializing.
    const label = args.join(" ");
    const started = ++tick;
    await Promise.resolve();
    order.push(`${started}:${label}`);
    if (label.startsWith("worktree list")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const mgr = new GitWorktreeManager("C:/repo", { exec });

  // Fire three ops without awaiting between them.
  const p1 = mgr.list();
  const p2 = mgr.list();
  const p3 = mgr.list();
  await Promise.all([p1, p2, p3]);

  // Each op saw a strictly increasing tick — they did not interleave.
  const ordinals = order.map((s) => Number(s.split(":")[0]));
  assert.deepEqual(ordinals, [1, 2, 3]);
});
