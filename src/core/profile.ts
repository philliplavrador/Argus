/**
 * Pure repo-profile detection (§11.1 groundwork).
 *
 * The shell reads a fixed set of candidate files (see PROFILE_CANDIDATE_FILES)
 * and hands their contents in; this module folds them into a RepoProfile with
 * no fs access and no clock — the caller supplies `detectedAt`. Every input is
 * treated as untrusted: malformed JSON and wrong-typed fields never throw, they
 * degrade to the empty/absent case.
 *
 * No `vscode`/SDK imports (this lives under `src/core/`).
 */

import { IsoTime, RepoProfile } from "./types";

/**
 * Repo-relative paths the shell should read and pass to `detectProfile`.
 * A missing file is simply absent from the handed-in array.
 */
export const PROFILE_CANDIDATE_FILES: readonly string[] = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "jest.config.js",
  "jest.config.ts",
  "jest.config.json",
  "playwright.config.ts",
  "playwright.config.js",
  "tsconfig.json",
];

type PackageManager = RepoProfile["packageManager"];

/** A test runner's evidence definition. */
interface RunnerDef {
  name: string;
  /** Substring matched against dependency keys and script text. */
  needle: string;
  /** Candidate config paths whose mere presence is evidence. */
  configs: readonly string[];
}

/**
 * Runners detected from dependencies / config files / script text, in the
 * stable output order. `node:test` is handled separately (script text only).
 */
const RUNNER_DEFS: readonly RunnerDef[] = [
  { name: "vitest", needle: "vitest", configs: ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"] },
  { name: "jest", needle: "jest", configs: ["jest.config.js", "jest.config.ts", "jest.config.json"] },
  { name: "playwright", needle: "playwright", configs: ["playwright.config.ts", "playwright.config.js"] },
  { name: "mocha", needle: "mocha", configs: [] },
];

/** dev-server script names, highest priority first. */
const DEV_SCRIPT_PRIORITY: readonly string[] = ["dev", "start:dev", "serve", "start"];

/**
 * Detect a RepoProfile from the candidate file contents. Pure: the returned
 * `detectedAt` is exactly the caller's argument. Bad input yields an all-null
 * profile rather than an error.
 */
export function detectProfile(
  files: ReadonlyArray<{ path: string; content: string }>,
  detectedAt: IsoTime,
): RepoProfile {
  // Index files by path (last wins), skipping any structurally bad entry.
  const byPath = new Map<string, string>();
  for (const f of files) {
    if (f && typeof f.path === "string" && typeof f.content === "string") {
      byPath.set(f.path, f.content);
    }
  }
  const has = (p: string): boolean => byPath.has(p);

  const pkg = parsePackageJson(byPath.get("package.json"));
  const scripts = extractScripts(pkg);
  const deps = collectDependencyNames(pkg);
  const scriptText = Object.values(scripts);

  const packageManager = detectPackageManager(has);
  const runPrefix = `${packageManager ?? "npm"} run`;

  return {
    detectedAt,
    packageManager,
    workspaces: detectWorkspaces(pkg, byPath.get("pnpm-workspace.yaml")),
    scripts,
    testRunners: detectTestRunners(has, deps, scriptText),
    devServerCommand: detectDevServer(scripts, runPrefix),
    typecheckCommand: detectTypecheck(scripts, deps, has, runPrefix),
    lintCommand: "lint" in scripts ? `${runPrefix} lint` : null,
  };
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

/** Parse package.json to a plain object; malformed or non-object → null (absent). */
function parsePackageJson(content: string | undefined): Record<string, unknown> | null {
  if (content === undefined) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(content);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Scripts verbatim, keeping only string-valued entries; {} when absent/malformed. */
function extractScripts(pkg: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = pkg?.["scripts"];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") {
        out[name] = value;
      }
    }
  }
  return out;
}

/** Union of dependency + devDependency names (string keys only). */
function collectDependencyNames(pkg: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies"]) {
    const raw = pkg?.[field];
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      for (const key of Object.keys(raw as Record<string, unknown>)) {
        names.add(key);
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Package manager
// ---------------------------------------------------------------------------

/**
 * Precedence: bun lockfile → pnpm-lock → yarn.lock → package-lock → bare
 * package.json → npm; nothing → null.
 */
function detectPackageManager(has: (p: string) => boolean): PackageManager {
  if (has("bun.lockb") || has("bun.lock")) {
    return "bun";
  }
  if (has("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (has("yarn.lock")) {
    return "yarn";
  }
  if (has("package-lock.json")) {
    return "npm";
  }
  if (has("package.json")) {
    return "npm";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/**
 * Workspace globs from package.json (`workspaces` as an array or `{ packages }`)
 * followed by pnpm-workspace.yaml `packages:` entries, deduped in first-seen order.
 */
function detectWorkspaces(
  pkg: Record<string, unknown> | null,
  pnpmYaml: string | undefined,
): string[] {
  const combined = [...extractPkgWorkspaces(pkg), ...extractPnpmWorkspaces(pnpmYaml)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const glob of combined) {
    if (!seen.has(glob)) {
      seen.add(glob);
      out.push(glob);
    }
  }
  return out;
}

/** package.json `workspaces`: an array of globs, or `{ packages: [...] }`. */
function extractPkgWorkspaces(pkg: Record<string, unknown> | null): string[] {
  const raw = pkg?.["workspaces"];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string");
  }
  if (raw !== null && typeof raw === "object") {
    const packages = (raw as Record<string, unknown>)["packages"];
    if (Array.isArray(packages)) {
      return packages.filter((x): x is string => typeof x === "string");
    }
  }
  return [];
}

/**
 * Textual (not YAML-parsed) extraction of a `packages:` block's `- glob` items.
 * Tolerates single/double quotes, inline `#` comments, whole-line comments, and
 * blank lines within the block. A subsequent non-list top-level line ends it.
 */
function extractPnpmWorkspaces(content: string | undefined): string[] {
  if (content === undefined) {
    return [];
  }
  const out: string[] = [];
  let inBlock = false;
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!inBlock) {
      if (/^packages\s*:/.test(trimmed)) {
        inBlock = true;
      }
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const item = /^-\s*(.*)$/.exec(trimmed);
    if (item) {
      const glob = cleanYamlScalar(item[1]);
      if (glob !== "") {
        out.push(glob);
      }
      continue;
    }
    // A non-comment, non-list line is the next top-level key: block is over.
    inBlock = false;
  }
  return out;
}

/** Strip surrounding quotes and any trailing inline comment from a scalar. */
function cleanYamlScalar(raw: string): string {
  const value = raw.trim();
  if (value === "") {
    return "";
  }
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    // Closing quote → inner text; unterminated → drop the opening quote defensively.
    return end === -1 ? value.slice(1).trim() : value.slice(1, end);
  }
  // Unquoted: a `#` preceded by whitespace begins a comment.
  const comment = value.search(/\s#/);
  return comment === -1 ? value : value.slice(0, comment).trim();
}

// ---------------------------------------------------------------------------
// Test runners
// ---------------------------------------------------------------------------

/**
 * Any of dependency, config-file presence, or script-text reference counts as
 * evidence for vitest/jest/playwright/mocha; a script containing `node --test`
 * adds `node:test`. Stable order, deduped.
 */
function detectTestRunners(
  has: (p: string) => boolean,
  deps: Set<string>,
  scriptText: string[],
): string[] {
  const out: string[] = [];
  for (const def of RUNNER_DEFS) {
    const fromConfig = def.configs.some((c) => has(c));
    const fromDep = anyContains(deps, def.needle);
    const fromScript = scriptText.some((s) => s.includes(def.needle));
    if (fromConfig || fromDep || fromScript) {
      out.push(def.name);
    }
  }
  if (scriptText.some((s) => s.includes("node --test"))) {
    out.push("node:test");
  }
  return out;
}

/** True if any member of `set` contains `needle` as a substring. */
function anyContains(set: Set<string>, needle: string): boolean {
  for (const value of set) {
    if (value.includes(needle)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Derived commands
// ---------------------------------------------------------------------------

/** First present script among the dev-server priority list → `<pm> run <name>`. */
function detectDevServer(scripts: Record<string, string>, runPrefix: string): string | null {
  for (const name of DEV_SCRIPT_PRIORITY) {
    if (name in scripts) {
      return `${runPrefix} ${name}`;
    }
  }
  return null;
}

/**
 * A `typecheck` script wins; else the first script whose text runs `tsc` with
 * `--noEmit`; else `npx tsc --noEmit` when a tsconfig.json and a typescript
 * dependency both exist; else null.
 */
function detectTypecheck(
  scripts: Record<string, string>,
  deps: Set<string>,
  has: (p: string) => boolean,
  runPrefix: string,
): string | null {
  if ("typecheck" in scripts) {
    return `${runPrefix} typecheck`;
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (command.includes("tsc") && command.includes("-noEmit")) {
      return `${runPrefix} ${name}`;
    }
  }
  if (has("tsconfig.json") && deps.has("typescript")) {
    return "npx tsc --noEmit";
  }
  return null;
}
