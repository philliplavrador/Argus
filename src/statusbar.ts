/**
 * Status bar item: `$(eye) N▶ M❓` — N tasks in non-terminal phases,
 * M unanswered queue files. Click focuses the Argus view.
 */

import * as vscode from "vscode";
import { statusBarText } from "./lib/render";
import { isTerminal } from "./lib/status";
import { FleetSnapshot } from "./model";

export class ArgusStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem("argus.fleet", vscode.StatusBarAlignment.Left, 100);
    this.item.name = "Argus Fleet";
    this.item.command = "argusFleet.focus";
  }

  update(snapshot: FleetSnapshot): void {
    const active = snapshot.tasks.filter((t) => t.status.ok && !isTerminal(t.status.phase)).length;
    const unanswered = snapshot.questions.filter((q) => !q.answered).length;
    this.item.text = statusBarText(active, unanswered);

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Argus** — ${active} active task${active === 1 ? "" : "s"}, ${unanswered} open question${unanswered === 1 ? "" : "s"}\n\n`);
    const blocked = snapshot.tasks.filter((t) => t.status.ok && t.status.phase === "BLOCKED");
    if (blocked.length === 0) {
      md.appendMarkdown("No blocked tasks.");
    } else {
      md.appendMarkdown("Blocked:\n");
      for (const t of blocked) {
        if (!t.status.ok) {
          continue;
        }
        const on = t.status.blockedOn;
        md.appendMarkdown(`- \`${t.status.id}\` — ${on?.kind ?? "unknown"}${on?.ref ? ` (${on.ref})` : ""}\n`);
      }
    }
    this.item.tooltip = md;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
