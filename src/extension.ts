/**
 * Argus v2 activation — thin glue between VS Code and the Orchestrator.
 *
 * The orchestrator boots lazily on the first command that needs it and lives
 * in the extension host until deactivation. The webview panel is a disposable
 * view over it. Window close necessarily ends the agent subprocesses (they
 * are children of this process); crash recovery replays the event log on the
 * next boot and marks interrupted tasks honestly.
 */

import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { collisionReport, renderCollisionReport } from './core/collision';
import { detectProfile, PROFILE_CANDIDATE_FILES } from './core/profile';
import { blockedTaskIds, isLivePhase } from './core/reducer';
import { ArgusConfig, ArgusEvent, DEFAULT_CONFIG, RepoProfile, WebviewToHost } from './core/types';
import { startAgent } from './host/agentrunner';
import { ShellGateRunner } from './host/gates';
import { JsonlEventLog } from './host/eventlog';
import { Orchestrator } from './host/orchestrator';
import { ArgusPanel, PanelHost } from './host/panel';
import { GitWorktreeManager } from './host/worktrees';

let orchestrator: Orchestrator | undefined;
/** In-flight boot guard: two quick commands must share one boot, not race two
 * orchestrators onto the same events.jsonl (review C16). */
let orchestratorBoot: Promise<Orchestrator | undefined> | undefined;
let eventLog: JsonlEventLog | undefined;
let statusBar: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.command = 'argus.open';
  statusBar.text = '$(eye) Argus';
  statusBar.tooltip = 'Open the Argus fleet panel';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('argus.open', async () => {
      const orch = await ensureOrchestrator(context);
      if (orch === undefined) {
        return;
      }
      ArgusPanel.createOrShow(context.extensionUri, makePanelHost(orch));
    }),
    vscode.commands.registerCommand('argus.init', async () => {
      const root = workspaceRoot();
      if (root === undefined) {
        return;
      }
      const summary = await initWorkspace(root);
      void vscode.window.showInformationMessage(`Argus: ${summary}`);
    }),
    vscode.commands.registerCommand('argus.collisionReport', async () => {
      const orch = await ensureOrchestrator(context);
      if (orch === undefined || eventLog === undefined) {
        return;
      }
      const { events } = await eventLog.replay();
      const md = renderCollisionReport(collisionReport(events, new Date().toISOString()));
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand('argus.stopAll', async () => {
      await orchestrator?.stopAll('operator ran Argus: Stop All Agents');
    }),
    vscode.commands.registerCommand('argus.cleanupWorktrees', async () => {
      const orch = await ensureOrchestrator(context);
      if (orch === undefined) {
        return;
      }
      const n = await orch.cleanupStaleWorktrees();
      void vscode.window.showInformationMessage(`Argus: removed ${n} stale worktree(s).`);
    }),
  );
}

export async function deactivate(): Promise<void> {
  await orchestrator?.dispose();
  orchestrator = undefined;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function workspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    void vscode.window.showErrorMessage('Argus needs an open folder.');
    return undefined;
  }
  return folder.uri.fsPath;
}

function ensureOrchestrator(context: vscode.ExtensionContext): Promise<Orchestrator | undefined> {
  if (orchestrator !== undefined) {
    return Promise.resolve(orchestrator);
  }
  if (orchestratorBoot === undefined) {
    orchestratorBoot = bootOrchestrator(context).then(
      (orch) => {
        if (orch === undefined) {
          orchestratorBoot = undefined; // not a git repo yet — retryable
        }
        return orch;
      },
      (err) => {
        orchestratorBoot = undefined; // a failed boot may be retried
        throw err;
      },
    );
  }
  return orchestratorBoot;
}

async function bootOrchestrator(context: vscode.ExtensionContext): Promise<Orchestrator | undefined> {
  const repoRoot = workspaceRoot();
  if (repoRoot === undefined) {
    return undefined;
  }
  if (!(await isGitRepo(repoRoot))) {
    void vscode.window.showErrorMessage(
      'Argus runs tasks in git worktrees, so the workspace must be a git repository.',
    );
    return undefined;
  }

  await initWorkspace(repoRoot);
  const argusDir = path.join(repoRoot, '.argus');
  const config = await loadConfig(argusDir);
  const profile = await loadProfile(argusDir);

  eventLog = new JsonlEventLog(path.join(argusDir, 'state', 'events.jsonl'));
  const orch = new Orchestrator({
    repoRoot,
    argusDir,
    eventLog,
    worktrees: new GitWorktreeManager(repoRoot),
    startAgent: (opts) => startAgent(opts),
    gates: new ShellGateRunner(),
    config,
    installCommand: installCommandFor(profile),
    toast: (level, text) => {
      ArgusPanel.current?.toast(level, text);
      if (level === 'error') {
        void vscode.window.showErrorMessage(`Argus: ${text}`);
      } else if (level === 'warn') {
        void vscode.window.showWarningMessage(`Argus: ${text}`);
      }
    },
  });

  const version = (context.extension.packageJSON as { version?: string }).version ?? '2.0.0';
  const stale = await orch.start(version);
  orchestrator = orch;

  orch.onEvent((_e, s) => updateStatusBar(s));
  updateStatusBar(orch.state);

  if (stale.length > 0) {
    void vscode.window
      .showWarningMessage(
        `Argus found ${stale.length} worktree(s) left behind by a previous session.`,
        'Clean up',
        'Leave them',
      )
      .then(async (choice) => {
        if (choice === 'Clean up') {
          const n = await orch.cleanupStaleWorktrees();
          void vscode.window.showInformationMessage(`Argus: removed ${n} stale worktree(s).`);
        }
      });
  }
  return orch;
}

function isGitRepo(root: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec('git rev-parse --git-dir', { cwd: root, windowsHide: true }, (err) => resolve(err === null));
  });
}

// ---------------------------------------------------------------------------
// Workspace scaffolding (argus.init — idempotent)
// ---------------------------------------------------------------------------

async function initWorkspace(repoRoot: string): Promise<string> {
  const argusDir = path.join(repoRoot, '.argus');
  const created: string[] = [];
  for (const dir of ['state', 'logs', 'worktrees', 'agents']) {
    await fs.mkdir(path.join(argusDir, dir), { recursive: true });
  }

  const configPath = path.join(argusDir, 'config.json');
  if (!(await exists(configPath))) {
    await fs.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    created.push('config.json');
  }

  // The profile is regenerable — refresh it on every init.
  const profile = await detectProfileFromDisk(repoRoot);
  await fs.writeFile(path.join(argusDir, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', 'utf8');
  created.push('profile.json');

  const ignoreLines = ['.argus/state/', '.argus/worktrees/', '.argus/logs/'];
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const existing = (await exists(gitignorePath)) ? await fs.readFile(gitignorePath, 'utf8') : '';
  const missing = ignoreLines.filter((l) => !existing.split(/\r?\n/).includes(l));
  if (missing.length > 0) {
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await fs.appendFile(gitignorePath, `${sep}${missing.join('\n')}\n`, 'utf8');
    created.push('.gitignore entries');
  }
  return created.length > 0 ? `initialized ${created.join(', ')}` : 'workspace already initialized';
}

async function detectProfileFromDisk(repoRoot: string): Promise<RepoProfile> {
  const files: { path: string; content: string }[] = [];
  for (const rel of PROFILE_CANDIDATE_FILES) {
    const abs = path.join(repoRoot, rel);
    if (await exists(abs)) {
      try {
        files.push({ path: rel, content: await fs.readFile(abs, 'utf8') });
      } catch {
        // Unreadable candidate — the detector treats it as absent.
      }
    }
  }
  return detectProfile(files, new Date().toISOString());
}

async function loadConfig(argusDir: string): Promise<ArgusConfig> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(argusDir, 'config.json'), 'utf8'),
    ) as Partial<ArgusConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function loadProfile(argusDir: string): Promise<RepoProfile | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(argusDir, 'profile.json'), 'utf8')) as RepoProfile;
  } catch {
    return null;
  }
}

function installCommandFor(profile: RepoProfile | null): string | null {
  switch (profile?.packageManager) {
    case 'npm':
      return 'npm install';
    case 'pnpm':
      return 'pnpm install';
    case 'yarn':
      return 'yarn';
    case 'bun':
      return 'bun install';
    default:
      return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Panel host — maps webview intents onto the orchestrator and VS Code
// ---------------------------------------------------------------------------

function makePanelHost(orch: Orchestrator): PanelHost {
  return {
    get state() {
      return orch.state;
    },
    onEvent: (cb: (e: ArgusEvent, s: Orchestrator['state']) => void) => orch.onEvent(cb),
    history: async () => {
      if (eventLog === undefined) {
        return [];
      }
      const { events } = await eventLog.replay();
      return events;
    },
    handleIntent: async (msg: WebviewToHost): Promise<void> => {
      switch (msg.kind) {
        case 'ready':
        case 'request-history':
          return; // handled inside the panel
        case 'create-task':
          await orch.createTask(msg.spec);
          return;
        case 'answer':
          await orch.answer(msg.itemId, msg.resolution);
          return;
        case 'stop-task':
          await orch.stopTask(msg.taskId, 'stopped from the fleet panel');
          return;
        case 'steer':
          await orch.steer(msg.taskId, msg.message);
          return;
        case 'open-worktree': {
          const wt = orch.state.tasks[msg.taskId]?.worktreePath;
          if (wt !== null && wt !== undefined) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(wt));
          }
          return;
        }
        case 'view-diff':
          await showTaskDiff(orch, msg.taskId);
          return;
        case 'merge-task':
          orch.enqueueMerge(msg.taskId);
          return;
        case 'set-config':
          await orch.setConfig(msg.config);
          return;
        case 'init-workspace': {
          const summary = await initWorkspace(orch.repoRoot);
          ArgusPanel.current?.toast('info', summary);
          return;
        }
        case 'stop-all':
          await orch.stopAll('operator pressed Stop All');
          return;
        case 'cleanup-worktrees': {
          const n = await orch.cleanupStaleWorktrees();
          ArgusPanel.current?.toast('info', `Removed ${n} stale worktree(s).`);
          return;
        }
      }
    },
  };
}

async function showTaskDiff(orch: Orchestrator, taskId: string): Promise<void> {
  const t = orch.state.tasks[taskId];
  if (t === undefined || t.worktreePath === null) {
    return;
  }
  const wt = t.worktreePath;
  const run = (cmd: string, maxBuffer: number): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { cwd: wt, windowsHide: true, maxBuffer }, (_err, stdout) => resolve(stdout));
    });
  const diff = await run('git diff HEAD', 32 * 1024 * 1024);
  const committed = await run('git log --oneline -20', 1024 * 1024);
  const content =
    `# ${t.spec.title} — ${t.branch ?? ''}\n# Recent commits:\n${committed
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => `#   ${l}`)
      .join('\n')}\n\n${diff.length > 0 ? diff : '# (no uncommitted changes in the worktree)'}\n`;
  const doc = await vscode.workspace.openTextDocument({ language: 'diff', content });
  await vscode.window.showTextDocument(doc, { preview: false });
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function updateStatusBar(s: Orchestrator['state']): void {
  if (statusBar === undefined) {
    return;
  }
  const live = Object.values(s.tasks).filter((t) => isLivePhase(t.phase)).length;
  const blocked = blockedTaskIds(s);
  statusBar.text = `$(eye) ${live}▶ ${blocked.length}★`;
  const lines = blocked.map((id) => {
    const t = s.tasks[id];
    return `★ ${t.spec.title} — waiting since ${t.blockedSince ?? '?'}`;
  });
  statusBar.tooltip = lines.length > 0 ? lines.join('\n') : 'Argus — no one is waiting on you';
}
