/**
 * The answer panel: a webview that renders a queue file's Context as
 * markdown, its Options as a radio group, and a Notes textarea. Submit
 * performs the answer contract (SPEC.md) — flip exactly one checkbox and
 * insert notes, preserving every other byte — via the workspace fs API.
 *
 * markdown-it is bundled (no CDN); the CSP allows only nonce'd inline
 * script/style and workspace images, and localResourceRoots covers the
 * question root so relative image paths resolve via asWebviewUri.
 */

import * as vscode from "vscode";
import MarkdownIt from "markdown-it";
import { AlreadyAnsweredError, ParsedQuestion, parseQuestion, serializeAnswer } from "./lib/question";
import { ageMinutes, formatAge } from "./lib/render";
import { getConfig, readText } from "./model";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class AnswerPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly folderProvider: () => vscode.WorkspaceFolder | undefined) {}

  async open(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      await this.render(existing, uri);
      return;
    }

    const roots: vscode.Uri[] = [];
    const folder = this.folderProvider();
    if (folder) {
      roots.push(vscode.Uri.joinPath(folder.uri, getConfig().questionRoot));
    }
    const panel = vscode.window.createWebviewPanel(
      "argus.answer",
      "Fleet question",
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: roots },
    );
    this.panels.set(key, panel);
    panel.onDidDispose(() => this.panels.delete(key));
    panel.webview.onDidReceiveMessage((msg: unknown) => void this.onMessage(panel, uri, msg));
    await this.render(panel, uri);
  }

  private async render(panel: vscode.WebviewPanel, uri: vscode.Uri): Promise<void> {
    let raw: string;
    try {
      raw = await readText(uri);
    } catch (e) {
      panel.webview.html = this.errorHtml(
        `Could not read ${uri.fsPath}: ${e instanceof Error ? e.message : String(e)}. ` +
          "The asking agent may have archived it to resolved/ already.",
      );
      return;
    }
    const q = parseQuestion(raw);
    panel.title = q.title || uri.path.split("/").pop() || "Fleet question";
    panel.webview.html = this.buildHtml(panel.webview, uri, q);
  }

  private async onMessage(panel: vscode.WebviewPanel, uri: vscode.Uri, msg: unknown): Promise<void> {
    const m = msg as { type?: string; optionIndex?: number; notes?: string };
    if (m.type === "openFile") {
      await vscode.commands.executeCommand("vscode.open", uri);
      return;
    }
    if (m.type !== "submit" || typeof m.optionIndex !== "number") {
      return;
    }
    try {
      // Re-read at submit time: the agent may have rewritten the file since
      // the panel opened. serializeAnswer throws if it is already answered.
      const raw = await readText(uri);
      const updated = serializeAnswer(raw, m.optionIndex, m.notes ?? "");
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
      await panel.webview.postMessage({ type: "answered" });
    } catch (e) {
      if (e instanceof AlreadyAnsweredError) {
        void vscode.window.showWarningMessage(
          "Argus: this question was already answered — showing the recorded choice.",
        );
        await this.render(panel, uri);
        return;
      }
      void vscode.window.showErrorMessage(
        `Argus: could not write the answer: ${e instanceof Error ? e.message : String(e)}`,
      );
      await panel.webview.postMessage({ type: "error" });
    }
  }

  private buildHtml(webview: vscode.Webview, fileUri: vscode.Uri, q: ParsedQuestion): string {
    const nonce = getNonce();
    const baseDir = vscode.Uri.joinPath(fileUri, "..");

    const md = new MarkdownIt({ html: false, linkify: true });
    const defaultImage = md.renderer.rules.image!;
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const src = token.attrGet("src");
      if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("/")) {
        token.attrSet("src", webview.asWebviewUri(vscode.Uri.joinPath(baseDir, src)).toString());
      }
      return defaultImage(tokens, idx, options, env, self);
    };

    const contextHtml = md.render(q.context || "_No context provided._");
    const answered = q.answeredIndex !== null;
    const preselected = q.answeredIndex ?? q.recommendedIndex;

    const optionsHtml =
      q.options.length === 0
        ? `<p class="muted">This file has no options — edit it directly instead.</p>`
        : q.options
            .map((o, i) => {
              const checked = preselected === i ? "checked" : "";
              const disabled = answered ? "disabled" : "";
              const chosen = answered && q.answeredIndex === i ? " chosen" : "";
              const rec = o.recommended ? `<span class="badge">recommended</span>` : "";
              return `<label class="option${chosen}"><input type="radio" name="option" value="${i}" ${checked} ${disabled}><span class="option-text">${md.renderInline(o.text)}</span>${rec}</label>`;
            })
            .join("\n");

    const agent = typeof q.frontmatter.agent === "string" ? q.frontmatter.agent : null;
    const asked = typeof q.frontmatter.asked === "string" ? q.frontmatter.asked : null;
    const metaBits = [
      agent ? `asked by <code>${escapeHtml(agent)}</code>` : null,
      asked ? `${formatAge(ageMinutes(asked))} ago` : null,
      q.frontmatter.blocking === true ? `<span class="blocking">blocking</span>` : null,
    ].filter((x): x is string => x !== null);

    const formBody = answered
      ? `<div class="banner">Already answered — read-only. The highlighted option is the recorded choice.</div>`
      : `<button id="submit" disabled>Submit answer</button>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); max-width: 720px; padding: 0 1.5rem 3rem; line-height: 1.5; }
  h1 { font-size: 1.35em; margin-bottom: 0.2em; }
  .meta { color: var(--vscode-descriptionForeground); margin-bottom: 1.2em; font-size: 0.9em; }
  .blocking { color: var(--vscode-errorForeground); font-weight: 600; }
  .context { border-left: 3px solid var(--vscode-textBlockQuote-border); padding-left: 1em; margin-bottom: 1.5em; }
  .context img { max-width: 100%; }
  h2 { font-size: 1.05em; margin: 1.2em 0 0.5em; }
  .option { display: flex; align-items: baseline; gap: 0.6em; padding: 0.5em 0.75em; margin: 0.3em 0; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 4px; cursor: pointer; }
  .option:hover { background: var(--vscode-list-hoverBackground); }
  .option.chosen { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: var(--vscode-focusBorder); }
  .badge { margin-left: auto; font-size: 0.78em; padding: 0.1em 0.5em; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
  textarea { width: 100%; min-height: 5em; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 0.5em; font-family: var(--vscode-font-family); }
  button { margin-top: 1em; padding: 0.45em 1.4em; border: none; border-radius: 3px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
  button:hover:enabled { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .banner { margin-top: 1em; padding: 0.6em 1em; border-radius: 4px; background: var(--vscode-textBlockQuote-background); }
  .muted { color: var(--vscode-descriptionForeground); }
  .link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; margin: 0; font-size: 0.9em; }
  #confirm { display: none; }
  #confirm .big { font-size: 1.1em; font-weight: 600; margin-bottom: 0.4em; }
</style>
<title>${escapeHtml(q.title || "Fleet question")}</title>
</head>
<body>
  <div id="form">
    <h1>${escapeHtml(q.title || "Fleet question")}</h1>
    <div class="meta">${metaBits.join(" · ")} · <button class="link" id="open-file">open file</button></div>
    <div class="context">${contextHtml}</div>
    <h2>Options</h2>
    ${optionsHtml}
    <h2>Notes</h2>
    <textarea id="notes" placeholder="Optional free text for the agent"${answered ? " readonly" : ""}>${escapeHtml(q.notes)}</textarea>
    <div>${formBody}</div>
  </div>
  <div id="confirm">
    <div class="big">Answered — the team wakes on its next poll (≤15s).</div>
    <div class="muted">The agent archives the file to resolved/ after consuming it. Argus never moves queue files.</div>
    <div style="margin-top:1em"><button class="link" id="open-file-2">open file</button></div>
  </div>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const submit = document.getElementById("submit");
    const radios = Array.from(document.querySelectorAll('input[name="option"]'));
    function sync() { if (submit) submit.disabled = !radios.some((r) => r.checked); }
    radios.forEach((r) => r.addEventListener("change", sync));
    sync();
    if (submit) {
      submit.addEventListener("click", () => {
        const chosen = radios.find((r) => r.checked);
        if (!chosen) return;
        submit.disabled = true;
        vscodeApi.postMessage({
          type: "submit",
          optionIndex: Number(chosen.value),
          notes: document.getElementById("notes").value,
        });
      });
    }
    for (const id of ["open-file", "open-file-2"]) {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", () => vscodeApi.postMessage({ type: "openFile" }));
    }
    window.addEventListener("message", (e) => {
      if (e.data.type === "answered") {
        document.getElementById("form").style.display = "none";
        document.getElementById("confirm").style.display = "block";
      } else if (e.data.type === "error") {
        sync();
      }
    });
  </script>
</body>
</html>`;
  }

  private errorHtml(message: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';"></head><body><p>${escapeHtml(message)}</p></body></html>`;
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }
}
