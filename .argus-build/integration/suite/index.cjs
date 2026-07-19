/**
 * Runs INSIDE the real VS Code extension host. Exercises: activation,
 * argus.init scaffolding + idempotence, argus.open (orchestrator boot + panel
 * tab), and argus.collisionReport (markdown doc). Assertion failures reject
 * run(), which fails the outer runner.
 */

'use strict';

const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function run() {
  const results = [];
  const check = (cond, label) => {
    results.push(`${cond ? 'PASS' : 'FAIL'} ${label}`);
    console.log(`[it] ${cond ? 'PASS' : 'FAIL'} ${label}`);
    if (!cond) {
      throw new Error(`integration assertion failed: ${label}`);
    }
  };

  const ext = vscode.extensions.getExtension('phillip-lavrador.argus');
  check(ext !== undefined, 'extension is discovered by VS Code');
  await ext.activate();
  check(ext.isActive, 'extension activates without throwing');

  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  check(typeof ws === 'string', 'scratch workspace is open');

  // ---- argus.init: scaffolds, then holds still on the second run ----------
  await vscode.commands.executeCommand('argus.init');
  check(existsSync(path.join(ws, '.argus', 'config.json')), 'init writes .argus/config.json');
  check(existsSync(path.join(ws, '.argus', 'profile.json')), 'init writes .argus/profile.json');
  const gitignore = readFileSync(path.join(ws, '.gitignore'), 'utf8');
  check(gitignore.includes('.argus/state/') && gitignore.includes('.argus/worktrees/'), 'init appends gitignore entries');
  const configBefore = readFileSync(path.join(ws, '.argus', 'config.json'), 'utf8');
  await vscode.commands.executeCommand('argus.init');
  check(readFileSync(path.join(ws, '.argus', 'config.json'), 'utf8') === configBefore, 'second init leaves config.json untouched (idempotent)');
  const profile = JSON.parse(readFileSync(path.join(ws, '.argus', 'profile.json'), 'utf8'));
  check(profile.packageManager === 'npm', 'profile detected the fixture package.json');

  // ---- argus.open: orchestrator boots, panel tab appears ------------------
  await vscode.commands.executeCommand('argus.open');
  await sleep(1500);
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
  check(tabs.includes('Argus'), `the Argus panel tab exists (tabs: ${tabs.join(', ')})`);
  check(existsSync(path.join(ws, '.argus', 'state', 'events.jsonl')), 'orchestrator boot wrote the event log (orchestrator-started)');
  const firstLine = readFileSync(path.join(ws, '.argus', 'state', 'events.jsonl'), 'utf8').split('\n')[0];
  check(firstLine.includes('"orchestrator-started"'), 'first event is orchestrator-started');

  // ---- panel survives close/reopen ---------------------------------------
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await sleep(300);
  await vscode.commands.executeCommand('argus.open');
  await sleep(800);
  const tabs2 = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
  check(tabs2.includes('Argus'), 'panel reopens after close');

  // ---- collision report opens as markdown ---------------------------------
  await vscode.commands.executeCommand('argus.collisionReport');
  await sleep(800);
  const active = vscode.window.activeTextEditor;
  check(active !== undefined && active.document.getText().includes('# Argus collision report'), 'collision report opens with both metrics');
  check(active.document.getText().includes('Stray rate') && active.document.getText().includes('Collision rate'), 'report carries stray + collision sections');

  console.log(`[it] all ${results.length} checks passed`);
};
