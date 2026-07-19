// Spike C Test 3: 4 concurrent `git worktree add` via Promise.all. Detect index.lock failures.
import { execFile } from 'node:child_process';
const FIX = 'C:/Users/phill/AppData/Local/Temp/claude/d--Projects-Argus/0636ba7b-5673-4655-ba57-197243db7acd/scratchpad/kiosk-fixture';
function git(args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile('git', args, { cwd: FIX }, (err, stdout, stderr) => {
      resolve({ args: args.join(' '), rc: err ? (err.code ?? 1) : 0, ms: Date.now() - t0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
const N = 4;
const adds = [];
for (let i = 1; i <= N; i++) adds.push(git(['worktree', 'add', `.argus/worktrees/conc-${i}`, '-b', `spike/conc-${i}`]));
const results = await Promise.all(adds);
let failures = 0, lockErrs = 0;
for (const r of results) {
  const combined = (r.stderr + ' ' + r.stdout);
  const isLock = /index\.lock|Unable to create|another git process|\.lock/i.test(combined);
  if (r.rc !== 0) failures++;
  if (isLock) lockErrs++;
  console.log(`rc=${r.rc} ms=${r.ms} lockErr=${isLock} :: ${r.args}`);
  if (r.stderr) console.log('   stderr: ' + r.stderr.replace(/\n/g, ' | '));
}
console.log(`SUMMARY: N=${N} failures=${failures} lockErrs=${lockErrs}`);
// cleanup
for (let i = 1; i <= N; i++) {
  await git(['worktree', 'remove', '--force', `.argus/worktrees/conc-${i}`]);
  await git(['branch', '-D', `spike/conc-${i}`]);
}
await git(['worktree', 'prune']);
const list = await git(['worktree', 'list']);
console.log('--- final list ---');
console.log(list.stdout);
