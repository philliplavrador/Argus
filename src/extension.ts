/**
 * Argus — cockpit for a multi-agent Claude Code fleet.
 *
 * Files are the contract (SPEC.md): agents write STATUS.json and queue/*.md;
 * Argus renders them and writes checkbox answers. It never runs agents and
 * never moves, renames, or deletes a queue file.
 */

import * as vscode from "vscode";
import { parseQuestion } from "./lib/question";
import { emptySnapshot, FleetSnapshot, getConfig, readText, scanFleet } from "./model";
import { AnswerPanelManager } from "./panel";
import { ArgusStatusBar } from "./statusbar";
import { FleetTreeProvider } from "./tree";

const REFRESH_DEBOUNCE_MS = 300;

export function activate(context: vscode.ExtensionContext): void {
  const tree = new FleetTreeProvider();
  const statusBar = new ArgusStatusBar();
  let snapshot: FleetSnapshot = emptySnapshot();
  const panels = new AnswerPanelManager(() => snapshot.folder);
  /** Queue files already seen — a create event for one of these never toasts. */
  const knownQuestions = new Set<string>();
  let watchers: vscode.FileSystemWatcher[] = [];
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const view = vscode.window.createTreeView("argusFleet", { treeDataProvider: tree });

  async function refresh(): Promise<void> {
    snapshot = await scanFleet();
    const current = new Set(snapshot.questions.map((q) => q.uri.toString()));
    for (const known of [...knownQuestions]) {
      if (!current.has(known)) {
        knownQuestions.delete(known); // agent archived it
      }
    }
    for (const key of current) {
      knownQuestions.add(key);
    }
    tree.setSnapshot(snapshot);
    statusBar.update(snapshot);
  }

  function scheduleRefresh(): void {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  function isQueueFile(uri: vscode.Uri): boolean {
    if (!snapshot.folder) {
      return false;
    }
    const queuePrefix = vscode.Uri.joinPath(snapshot.folder.uri, getConfig().questionRoot, "queue").path + "/";
    return uri.path.startsWith(queuePrefix) && uri.path.endsWith(".md");
  }

  async function toastNewQuestion(uri: vscode.Uri): Promise<void> {
    // The agent may still be mid-write; give it a beat before reading.
    await new Promise((resolve) => setTimeout(resolve, 150));
    let title = uri.path.split("/").pop() ?? "question";
    try {
      const q = parseQuestion(await readText(uri));
      if (q.title) {
        title = q.title;
      }
      if (q.answeredIndex !== null) {
        return; // arrived already answered — nothing to ask
      }
    } catch {
      // unreadable → toast with the file name
    }
    const choice = await vscode.window.showInformationMessage(`Fleet question: ${title}`, "Answer", "Later");
    if (choice === "Answer") {
      await panels.open(uri);
    }
  }

  function setupWatchers(): void {
    for (const w of watchers) {
      w.dispose();
    }
    watchers = [];
    const folder = snapshot.folder;
    if (!folder) {
      return;
    }
    const { stateRoot, questionRoot } = getConfig();
    for (const root of [stateRoot, questionRoot]) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, `${root}/**`),
      );
      watcher.onDidCreate((uri) => {
        // Toast only for queue files born while the window is open: the
        // activation-time scan seeds knownQuestions, so pre-existing files
        // never storm.
        if (isQueueFile(uri) && !knownQuestions.has(uri.toString())) {
          knownQuestions.add(uri.toString());
          void toastNewQuestion(uri);
        }
        scheduleRefresh();
      });
      watcher.onDidChange(() => scheduleRefresh());
      watcher.onDidDelete(() => scheduleRefresh());
      watchers.push(watcher);
    }
  }

  async function rebuild(): Promise<void> {
    await refresh();
    setupWatchers();
  }

  context.subscriptions.push(
    view,
    statusBar,
    panels,
    { dispose: () => { for (const w of watchers) { w.dispose(); } } },
    { dispose: () => { if (refreshTimer !== undefined) { clearTimeout(refreshTimer); } } },

    vscode.commands.registerCommand("argus.refresh", () => refresh()),
    vscode.commands.registerCommand("argus.openQuestion", (uri: vscode.Uri) => panels.open(uri)),
    vscode.commands.registerCommand(
      "argus.openTask",
      async (dirUri: vscode.Uri, statusUri: vscode.Uri) => {
        const progress = vscode.Uri.joinPath(dirUri, "PROGRESS.md");
        try {
          await vscode.workspace.fs.stat(progress);
          await vscode.commands.executeCommand("vscode.open", progress);
        } catch {
          await vscode.commands.executeCommand("vscode.open", statusUri);
        }
      },
    ),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("argus")) {
        void rebuild();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void rebuild()),
  );

  void rebuild();
}

export function deactivate(): void {
  // All disposal is handled via context.subscriptions.
}
