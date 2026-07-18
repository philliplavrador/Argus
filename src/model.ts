/**
 * Workspace scanning: turns the on-disk file contract (SPEC.md) into an
 * in-memory FleetSnapshot. All reads go through vscode.workspace.fs.
 */

import * as vscode from "vscode";
import { parseQuestion } from "./lib/question";
import {
  compareTasks,
  ParsedStatus,
  parseStatus,
  parseSweep,
  WatchdogFinding,
  warningDetectors,
} from "./lib/status";

export interface ArgusConfig {
  stateRoot: string;
  questionRoot: string;
}

export function getConfig(): ArgusConfig {
  const cfg = vscode.workspace.getConfiguration("argus");
  return {
    stateRoot: cfg.get<string>("stateRoot", ".scratch/fleet"),
    questionRoot: cfg.get<string>("questionRoot", "workflow"),
  };
}

export interface TaskEntry {
  status: ParsedStatus;
  dirUri: vscode.Uri;
  statusUri: vscode.Uri;
  warnings: string[];
}

export interface QuestionEntry {
  uri: vscode.Uri;
  fileName: string;
  title: string;
  blocking: boolean;
  asked: string | null;
  answered: boolean;
  mtime: number;
}

export interface FleetSnapshot {
  folder: vscode.WorkspaceFolder | undefined;
  tasks: TaskEntry[];
  questions: QuestionEntry[];
}

export function emptySnapshot(): FleetSnapshot {
  return { folder: undefined, tasks: [], questions: [] };
}

// ignoreBOM keeps a leading U+FEFF in the string so a write round-trips it.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export async function readText(uri: vscode.Uri): Promise<string> {
  return decoder.decode(await vscode.workspace.fs.readFile(uri));
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Single-folder workspaces are the target; in multi-root, use the first
 * folder containing either configured root.
 */
export async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const { stateRoot, questionRoot } = getConfig();
  for (const folder of folders) {
    for (const root of [stateRoot, questionRoot]) {
      if (await uriExists(vscode.Uri.joinPath(folder.uri, root))) {
        return folder;
      }
    }
  }
  return folders[0];
}

async function readSweep(folder: vscode.WorkspaceFolder, stateRoot: string): Promise<WatchdogFinding[]> {
  try {
    const raw = await readText(vscode.Uri.joinPath(folder.uri, stateRoot, "watchdog", "sweep.json"));
    return parseSweep(raw);
  } catch {
    return [];
  }
}

async function scanTasks(folder: vscode.WorkspaceFolder, stateRoot: string): Promise<TaskEntry[]> {
  const tasksDir = vscode.Uri.joinPath(folder.uri, stateRoot, "tasks");
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(tasksDir);
  } catch {
    return [];
  }
  const findings = await readSweep(folder, stateRoot);
  const out: TaskEntry[] = [];
  for (const [name, type] of entries) {
    if (!(type & vscode.FileType.Directory)) {
      continue;
    }
    const dirUri = vscode.Uri.joinPath(tasksDir, name);
    const statusUri = vscode.Uri.joinPath(dirUri, "STATUS.json");
    let raw: string;
    try {
      raw = await readText(statusUri);
    } catch {
      continue; // no STATUS.json → not a task directory
    }
    const status: ParsedStatus = parseStatus(raw, name);
    if (status.ok && status.acknowledged) {
      continue; // author dismissed it — drop from the tree
    }
    out.push({ status, dirUri, statusUri, warnings: warningDetectors(findings, status.id) });
  }
  out.sort((a, b) => compareTasks(a.status, b.status));
  return out;
}

async function scanQuestions(folder: vscode.WorkspaceFolder, questionRoot: string): Promise<QuestionEntry[]> {
  const queueDir = vscode.Uri.joinPath(folder.uri, questionRoot, "queue");
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(queueDir);
  } catch {
    return [];
  }
  const out: QuestionEntry[] = [];
  for (const [name, type] of entries) {
    if (!(type & vscode.FileType.File) || !name.endsWith(".md")) {
      continue;
    }
    const uri = vscode.Uri.joinPath(queueDir, name);
    let raw: string;
    let mtime = 0;
    try {
      raw = await readText(uri);
      mtime = (await vscode.workspace.fs.stat(uri)).mtime;
    } catch {
      continue;
    }
    const q = parseQuestion(raw);
    out.push({
      uri,
      fileName: name,
      title: q.title || name,
      blocking: q.frontmatter.blocking === true,
      asked: typeof q.frontmatter.asked === "string" ? q.frontmatter.asked : null,
      answered: q.answeredIndex !== null,
      mtime,
    });
  }
  // Oldest first, by `asked`; files without it slot in by mtime.
  out.sort((a, b) => {
    const ka = a.asked ?? new Date(a.mtime).toISOString();
    const kb = b.asked ?? new Date(b.mtime).toISOString();
    if (ka !== kb) {
      return ka < kb ? -1 : 1;
    }
    return a.fileName.localeCompare(b.fileName);
  });
  return out;
}

export async function scanFleet(): Promise<FleetSnapshot> {
  const folder = await pickWorkspaceFolder();
  if (!folder) {
    return emptySnapshot();
  }
  const { stateRoot, questionRoot } = getConfig();
  const [tasks, questions] = await Promise.all([
    scanTasks(folder, stateRoot),
    scanQuestions(folder, questionRoot),
  ]);
  return { folder, tasks, questions };
}
