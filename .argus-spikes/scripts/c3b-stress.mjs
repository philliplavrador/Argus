// Spike C Test 3b: heavier concurrency. 8 concurrent adds, each followed by a commit
// (commit touches shared HEAD reflog / packed-refs and per-worktree index -> stress locks).
import { execFile } from 'node:child_process';
const FIX = 'C:/Users/phill/AppData/Local/Temp/claude/d--Projects-Argus/0636ba7b-5673-4655-ba57-197243db7acd/scratchpad/kiosk-fixture';
import fs from 'node:fs';
import path from 'node:path';
function git(args, cwd = FIX) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      resolve({ args: args.join(' '), cwd, rc: err ? (err.code ?? 1) : 0, ms: Date.now() - t0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
const N = 8;
async function oneTask(i) {
  const wt = `.argus/worktrees/st-${i}`;
  const abs = path.join(FIX, wt);
  const r1 = await git(['worktree', 'add', wt, '-b', `spike/st-${i}`]);
  // write a file and commit inside the worktree
  fs.writeFileSync(path.join(abs, `f${i}.txt`), `task ${i}\n`);
  const r2 = await git(['add', `f${i}.txt`], abs);
  const r3 = await git(['-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-m', `t${i}`], abs);
  return [r1, r2, r3];
}
const all = (await Promise.all(Array.from({ length: N }, (_, k) => oneTask(k + 1)))).flat();
let failures = 0, lockErrs = 0;
for (const r of all) {
  const c = r.stderr + ' ' + r.stdout;
  const isLock = /index\.lock|another git process|cannot lock ref|Unable to create|packed-refs\.lock|config\.lock/i.test(c);
  if (r.rc !== 0) { failures++; console.log(`FAIL rc=${r.rc} ms=${r.ms} :: ${r.args} :: ${r.stderr.replace(/\n/g,' | ')}`); }
  if (isLock) { lockErrs++; console.log(`LOCK :: ${r.args} :: ${r.stderr.replace(/\n/g,' | ')}`); }
}
console.log(`SUMMARY: ops=${all.length} failures=${failures} lockErrs=${lockErrs}`);
// cleanup
for (let i = 1; i <= N; i++) { await git(['worktree', 'remove', '--force', `.argus/worktrees/st-${i}`]); await git(['branch', '-D', `spike/st-${i}`]); }
await git(['worktree', 'prune']);
console.log('cleaned. list:', (await git(['worktree', 'list'])).stdout);
