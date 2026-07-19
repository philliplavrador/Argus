/**
 * VS Code integration run: downloads a real VS Code, launches it with the
 * built extension against a scratch git workspace, and executes the suite in
 * the real extension host. Closes the biggest verification gap of the night —
 * activation, command registration, orchestrator boot, and panel creation
 * had only ever been typechecked.
 *
 * Prereq: npm run compile (dist/ must be current).
 * Run:    node .argus-build/integration/run.cjs
 */

'use strict';

const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  // This script often runs from a terminal that itself lives inside VS Code;
  // the inherited ELECTRON_RUN_AS_NODE would turn the spawned Code.exe into a
  // plain Node process ("bad option: --disable-extensions"). Strip it and the
  // parent VS Code's IPC hooks before launching.
  for (const key of Object.keys(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) {
      delete process.env[key];
    }
  }

  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.cjs');

  // Scratch workspace: a real git repo with one commit and a package.json,
  // so ensureOrchestrator's git check and the profile detector both engage.
  const ws = mkdtempSync(path.join(os.tmpdir(), 'argus-it-'));
  const sh = (file, args) => execFileSync(file, args, { cwd: ws, windowsHide: true });
  writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'it-fixture', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
  writeFileSync(path.join(ws, 'README.md'), 'integration fixture\n');
  sh('git', ['init', '-q']);
  sh('git', ['add', '-A']);
  sh('git', ['-c', 'user.email=it@argus', '-c', 'user.name=argus-it', 'commit', '-q', '-m', 'fixture']);

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ['--disable-workspace-trust', '--disable-extensions', ws],
  });
  console.log('INTEGRATION PASSED');
}

main().catch((err) => {
  console.error('INTEGRATION FAILED:', err);
  process.exit(1);
});
