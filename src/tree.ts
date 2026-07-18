/**
 * The Argus tree: two top-level groups (Tasks, Questions) fed from a
 * FleetSnapshot. Pure rendering — all text comes from src/lib/render.ts.
 */

import * as vscode from "vscode";
import { ageMinutes, formatAge, questionDescription, taskDescription } from "./lib/render";
import { categoryOf } from "./lib/status";
import { emptySnapshot, FleetSnapshot, QuestionEntry, TaskEntry } from "./model";

export type FleetNode =
  | { kind: "group"; which: "tasks" | "questions" }
  | { kind: "task"; entry: TaskEntry }
  | { kind: "question"; entry: QuestionEntry }
  | { kind: "placeholder"; label: string };

export class FleetTreeProvider implements vscode.TreeDataProvider<FleetNode> {
  private readonly emitter = new vscode.EventEmitter<FleetNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private snapshot: FleetSnapshot = emptySnapshot();

  setSnapshot(snapshot: FleetSnapshot): void {
    this.snapshot = snapshot;
    this.emitter.fire();
  }

  getChildren(element?: FleetNode): FleetNode[] {
    if (!element) {
      if (this.snapshot.tasks.length === 0 && this.snapshot.questions.length === 0) {
        return []; // let viewsWelcome explain the contract
      }
      return [
        { kind: "group", which: "tasks" },
        { kind: "group", which: "questions" },
      ];
    }
    if (element.kind === "group") {
      if (element.which === "tasks") {
        return this.snapshot.tasks.length > 0
          ? this.snapshot.tasks.map((entry) => ({ kind: "task", entry }) as FleetNode)
          : [{ kind: "placeholder", label: "No tasks" }];
      }
      return this.snapshot.questions.length > 0
        ? this.snapshot.questions.map((entry) => ({ kind: "question", entry }) as FleetNode)
        : [{ kind: "placeholder", label: "No open questions" }];
    }
    return [];
  }

  getTreeItem(element: FleetNode): vscode.TreeItem {
    switch (element.kind) {
      case "group":
        return this.groupItem(element.which);
      case "task":
        return this.taskItem(element.entry);
      case "question":
        return this.questionItem(element.entry);
      case "placeholder": {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }
    }
  }

  private groupItem(which: "tasks" | "questions"): vscode.TreeItem {
    const item = new vscode.TreeItem(
      which === "tasks" ? "Tasks" : "Questions",
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `argus-group-${which}`;
    item.contextValue = `argusGroup.${which}`;
    return item;
  }

  private taskItem(entry: TaskEntry): vscode.TreeItem {
    const s = entry.status;
    const item = new vscode.TreeItem(s.id, vscode.TreeItemCollapsibleState.None);
    item.id = `argus-task-${entry.dirUri.toString()}`;
    item.description = taskDescription(s, entry.warnings);
    item.contextValue = "argusTask";
    item.command = {
      command: "argus.openTask",
      title: "Open Task Progress",
      arguments: [entry.dirUri, entry.statusUri],
    };

    const category = categoryOf(s);
    if (!s.ok) {
      item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
      item.tooltip = `STATUS.json could not be parsed: ${s.error}`;
      return item;
    }
    if (category === "blocked") {
      item.iconPath = new vscode.ThemeIcon("debug-pause", new vscode.ThemeColor("charts.yellow"));
    } else if (category === "finished") {
      item.iconPath =
        s.phase === "PUSHED"
          ? new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"))
          : new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
    } else {
      item.iconPath = new vscode.ThemeIcon("play");
    }

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${s.title ?? s.id}**\n\n`);
    if (s.lastEvent) {
      md.appendMarkdown(`${s.lastEvent}\n\n`);
    }
    if (s.branch) {
      md.appendMarkdown(`branch \`${s.branch}\`  \n`);
    }
    if (s.tree) {
      md.appendMarkdown(`tree ${s.tree}  \n`);
    }
    md.appendMarkdown(`heartbeat ${formatAge(ageMinutes(s.heartbeatAt))} ago`);
    if (s.blockedOn) {
      md.appendMarkdown(`  \nblocked on ${s.blockedOn.kind}${s.blockedOn.ref ? `: ${s.blockedOn.ref}` : ""}`);
    }
    item.tooltip = md;
    return item;
  }

  private questionItem(entry: QuestionEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.title, vscode.TreeItemCollapsibleState.None);
    item.id = `argus-question-${entry.uri.toString()}`;
    item.contextValue = "argusQuestion";
    const age = ageMinutes(entry.asked) ?? ageMinutes(new Date(entry.mtime).toISOString());
    item.description = entry.answered ? "✓ answered" : questionDescription(entry.blocking, age);
    item.iconPath = entry.answered
      ? new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"))
      : new vscode.ThemeIcon(
          "question",
          entry.blocking ? new vscode.ThemeColor("charts.orange") : undefined,
        );
    item.tooltip = `${entry.fileName}${entry.blocking ? " · blocking" : ""}`;
    item.command = {
      command: "argus.openQuestion",
      title: "Answer Fleet Question",
      arguments: [entry.uri],
    };
    return item;
  }
}
