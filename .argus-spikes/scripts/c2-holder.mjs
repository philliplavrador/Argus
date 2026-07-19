// Long-lived process: cwd is inside the worktree, holds an open write handle.
import fs from 'node:fs';
import path from 'node:path';
const dir = process.cwd();
const f = path.join(dir, 'HELD_OPEN.txt');
const fd = fs.openSync(f, 'w');
fs.writeSync(fd, 'holding open at ' + new Date().toISOString() + '\n');
// signal readiness
console.log('HOLDER_READY pid=' + process.pid + ' cwd=' + dir + ' file=' + f);
setInterval(() => { fs.writeSync(fd, 'tick ' + Date.now() + '\n'); }, 1000);
