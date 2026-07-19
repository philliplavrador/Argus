/**
 * The Argus webview panel — a pure view over orchestrator state.
 *
 * Design principle 1 made mechanical: this class owns NOTHING. Opening it
 * sends a snapshot; every subsequent event is batched (EVENT_BATCH_MS, per
 * Spike D) and applied by the webview's copy of the same reducer. Closing it
 * disposes the batch timer and the event subscription and nothing else —
 * running agents cannot tell whether the panel exists.
 */

import * as vscode from 'vscode';
import {
  ArgusEvent,
  EVENT_BATCH_MS,
  FleetState,
  HostToWebview,
  WebviewToHost,
} from '../core/types';

/** What the panel needs from the extension — a thin slice of the orchestrator. */
export interface PanelHost {
  readonly state: FleetState;
  onEvent(cb: (e: ArgusEvent, s: FleetState) => void): { dispose(): void };
  /** UI intents; errors are caught here and surfaced as toasts. */
  handleIntent(msg: WebviewToHost): Promise<void>;
  /** Full event history from the log (Timeline backfill). */
  history(): Promise<ArgusEvent[]>;
}

export class ArgusPanel {
  static current: ArgusPanel | undefined;

  static createOrShow(extensionUri: vscode.Uri, host: PanelHost): ArgusPanel {
    if (ArgusPanel.current !== undefined) {
      ArgusPanel.current.panel.reveal();
      return ArgusPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('argus', 'Argus', vscode.ViewColumn.Active, {
      enableScripts: true,
      // State is re-derived from a snapshot on every open; no retention needed.
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    });
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'dist', 'argus.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'dist', 'argus.svg'),
    };
    ArgusPanel.current = new ArgusPanel(panel, extensionUri, host);
    return ArgusPanel.current;
  }

  private readonly disposables: { dispose(): void }[] = [];
  private pending: ArgusEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly host: PanelHost,
  ) {
    panel.webview.html = this.html(panel.webview, extensionUri);

    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const msg = raw as WebviewToHost;
        if (msg.kind === 'ready') {
          this.post({ kind: 'snapshot', state: this.host.state });
          return;
        }
        if (msg.kind === 'request-history') {
          void this.host.history().then((events) => this.post({ kind: 'history', events }));
          return;
        }
        void this.host.handleIntent(msg).catch((err) => {
          this.post({ kind: 'toast', level: 'error', text: String(err instanceof Error ? err.message : err).slice(0, 300) });
        });
      }),
      this.host.onEvent((e) => {
        this.pending.push(e);
      }),
      panel.onDidDispose(() => this.dispose()),
    );

    this.flushTimer = setInterval(() => {
      if (this.pending.length > 0 && this.panel.visible) {
        const events = this.pending;
        this.pending = [];
        this.post({ kind: 'events', events });
      }
      // When hidden, keep accumulating; on re-show a fresh snapshot resyncs.
    }, EVENT_BATCH_MS);

    this.disposables.push(
      panel.onDidChangeViewState(() => {
        if (panel.visible) {
          this.pending = [];
          this.post({ kind: 'snapshot', state: this.host.state });
        }
      }),
    );
  }

  toast(level: 'info' | 'warn' | 'error', text: string): void {
    this.post({ kind: 'toast', level, text });
  }

  private post(msg: HostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
    }
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    ArgusPanel.current = undefined;
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
    const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Argus</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
