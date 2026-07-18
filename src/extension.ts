/**
 * Argus — cockpit for a multi-agent Claude Code fleet.
 *
 * Files are the contract (SPEC.md): agents write STATUS.json and queue/*.md;
 * Argus renders them and writes checkbox answers. It never runs agents and
 * never moves, renames, or deletes a queue file.
 *
 * Ordering invariants in here:
 * - Watchers are created BEFORE the first scan, so a file born mid-scan
 *   still produces an event (the debounced refresh is idempotent).
 * - knownQuestions is seeded from a scan exactly once, at activation;
 *   afterwards onDidCreate is the only place a file becomes known-and-
 *   toasted, so a manual Refresh can never swallow a toast.
 * - Scans carry a generation counter; a stale scan completing late is
 *   discarded instead of regressing the snapshot.
 * - Watchers re-point whenever the effective fleet folder or the configured
 *   roots change (config change, multi-root fleet booting in a different
 *   folder, manual refresh).
 */

import * as vscode from "vscode";
import { isTemplatePlaceholder, parseQuestion } from "./lib/question";
import { emptySnapshot, FleetSnapshot, getConfig, pickWorkspaceFolder, readText, scanFleet } from "./model";
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
  let watchedFolder: vscode.WorkspaceFolder | undefined;
  let watchedKey = "";
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let scanGen = 0;

  const view = vscode.window.createTreeView("argusFleet", { treeDataProvider: tree });

  function watchKeyFor(folder: vscode.WorkspaceFolder | undefined): string {
    const { stateRoot, questionRoot } = getConfig();
    return `${folder?.uri.toString() ?? ""}|${stateRoot}|${questionRoot}`;
  }

  async function refresh(seedKnown = false): Promise<void> {
    const gen = ++scanGen;
    const next = await scanFleet();
    if (gen !== scanGen) {
      return; // a newer scan superseded this one — never regress the snapshot
    }
    snapshot = next;
    const current = new Set(snapshot.questions.map((q) => q.uri.toString()));
    for (const known of [...knownQuestions]) {
      if (!current.has(known)) {
        knownQuestions.delete(known); // agent archived it
      }
    }
    if (seedKnown) {
      // Activation only: pre-existing files must not toast.
      for (const key of current) {
        knownQuestions.add(key);
      }
    }
    tree.setSnapshot(snapshot);
    statusBar.update(snapshot);
    // The fleet may live in a different folder than the watchers cover
    // (multi-root: fallback folder A watched, fleet boots in folder B).
    if (watchKeyFor(snapshot.folder) !== watchedKey) {
      setupWatchers(snapshot.folder);
    }
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
    if (!watchedFolder) {
      return false;
    }
    const queuePrefix =
      vscode.Uri.joinPath(watchedFolder.uri, getConfig().questionRoot, "queue").path + "/";
    return uri.path.startsWith(queuePrefix) && uri.path.endsWith(".md");
  }

  async function toastNewQuestion(uri: vscode.Uri): Promise<void> {
    // No settle delay needed: the protocol makes queue files appear
    // atomically (fill queue/.<name>.md.tmp, then rename — and .tmp names
    // don't match our *.md filter). The placeholder check below is defense
    // in depth against a non-atomic template copy.
    let title = uri.path.split("/").pop() ?? "question";
    try {
      const q = parseQuestion(await readText(uri));
      if (isTemplatePlaceholder(q)) {
        return; // half-filled template — never toast it
      }
      if (q.title) {
        title = q.title;
      }
      if (q.answeredIndices.length > 0) {
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

  function setupWatchers(folder: vscode.WorkspaceFolder | undefined): void {
    for (const w of watchers) {
      w.dispose();
    }
    watchers = [];
    watchedFolder = folder;
    watchedKey = watchKeyFor(folder);
    if (!folder) {
      return;
    }
    const { stateRoot, questionRoot } = getConfig();
    for (const root of [stateRoot, questionRoot]) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, `${root}/**`),
      );
      watcher.onDidCreate((uri) => {
        if (isQueueFile(uri)) {
          // Toast only for queue files born while the window is open: the
          // activation-time seeding marks pre-existing files, so they
          // never storm. onDidCreate is the SOLE place a file becomes
          // known-and-toasted after activation.
          if (!knownQuestions.has(uri.toString())) {
            knownQuestions.add(uri.toString());
            void toastNewQuestion(uri);
          }
          // Atomic in-place rewrites arrive as create (rename onto the name).
          void panels.handleFileChange(uri);
        }
        scheduleRefresh();
      });
      watcher.onDidChange((uri) => {
        if (isQueueFile(uri)) {
          void panels.handleFileChange(uri);
        }
        scheduleRefresh();
      });
      watcher.onDidDelete((uri) => {
        if (isQueueFile(uri)) {
          void panels.handleFileChange(uri);
        }
        scheduleRefresh();
      });
      watchers.push(watcher);
    }
  }

  /** Re-point watchers (if needed) and rescan. Used by refresh command,
   *  config changes, and workspace-folder changes. */
  async function rebuild(): Promise<void> {
    const folder = await pickWorkspaceFolder();
    if (watchKeyFor(folder) !== watchedKey) {
      setupWatchers(folder);
    }
    await refresh();
  }

  context.subscriptions.push(
    view,
    statusBar,
    panels,
    { dispose: () => { for (const w of watchers) { w.dispose(); } } },
    { dispose: () => { if (refreshTimer !== undefined) { clearTimeout(refreshTimer); } } },

    vscode.commands.registerCommand("argus.refresh", () => rebuild()),
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

  void (async () => {
    // Watchers FIRST, then the seeding scan — a file created during the
    // scan gets an event (toast + debounced refresh) instead of vanishing
    // into the gap.
    setupWatchers(await pickWorkspaceFolder());
    await refresh(true);
  })();
}

export function deactivate(): void {
  // All disposal is handled via context.subscriptions.
}
