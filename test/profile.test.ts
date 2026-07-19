import { test } from "node:test";
import assert from "node:assert/strict";
import { detectProfile, PROFILE_CANDIDATE_FILES } from "../src/core/profile";

type File = { path: string; content: string };

const AT = "2026-07-18T18:00:00Z";

/** Terse builder: pass a { path: content } map. */
function files(map: Record<string, string>): File[] {
  return Object.entries(map).map(([path, content]) => ({ path, content }));
}

function pkg(obj: unknown): string {
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Candidate list & empty input
// ---------------------------------------------------------------------------

test("PROFILE_CANDIDATE_FILES lists the exact paths the shell must read", () => {
  assert.deepEqual([...PROFILE_CANDIDATE_FILES], [
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
  ]);
});

test("empty input → all-null profile with detectedAt preserved", () => {
  const p = detectProfile([], AT);
  assert.equal(p.detectedAt, AT);
  assert.equal(p.packageManager, null);
  assert.deepEqual(p.workspaces, []);
  assert.deepEqual(p.scripts, {});
  assert.deepEqual(p.testRunners, []);
  assert.equal(p.devServerCommand, null);
  assert.equal(p.typecheckCommand, null);
  assert.equal(p.lintCommand, null);
});

test("detectedAt is passed through verbatim, never generated", () => {
  assert.equal(detectProfile([], "not-a-real-time").detectedAt, "not-a-real-time");
});

// ---------------------------------------------------------------------------
// Package manager precedence
// ---------------------------------------------------------------------------

test("bun.lockb wins over every other lockfile", () => {
  const p = detectProfile(
    files({
      "bun.lockb": "",
      "pnpm-lock.yaml": "",
      "yarn.lock": "",
      "package-lock.json": "",
      "package.json": "{}",
    }),
    AT,
  );
  assert.equal(p.packageManager, "bun");
});

test("bun.lock (text lockfile) also selects bun", () => {
  const p = detectProfile(files({ "bun.lock": "", "pnpm-lock.yaml": "" }), AT);
  assert.equal(p.packageManager, "bun");
});

test("pnpm beats yarn and npm-lock", () => {
  const p = detectProfile(
    files({ "pnpm-lock.yaml": "", "yarn.lock": "", "package-lock.json": "" }),
    AT,
  );
  assert.equal(p.packageManager, "pnpm");
});

test("yarn beats npm-lock", () => {
  const p = detectProfile(files({ "yarn.lock": "", "package-lock.json": "" }), AT);
  assert.equal(p.packageManager, "yarn");
});

test("package-lock.json → npm", () => {
  assert.equal(detectProfile(files({ "package-lock.json": "" }), AT).packageManager, "npm");
});

test("bare package.json with no lockfile → npm", () => {
  assert.equal(detectProfile(files({ "package.json": "{}" }), AT).packageManager, "npm");
});

test("no package.json and no lockfile → null", () => {
  assert.equal(detectProfile(files({ "tsconfig.json": "{}" }), AT).packageManager, null);
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

test("package.json workspaces as an array", () => {
  const p = detectProfile(files({ "package.json": pkg({ workspaces: ["packages/*", "apps/*"] }) }), AT);
  assert.deepEqual(p.workspaces, ["packages/*", "apps/*"]);
});

test("package.json workspaces as { packages }", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ workspaces: { packages: ["libs/*"] } }) }),
    AT,
  );
  assert.deepEqual(p.workspaces, ["libs/*"]);
});

test("workspaces array drops non-string entries", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ workspaces: ["a/*", 5, null, "b/*"] }) }),
    AT,
  );
  assert.deepEqual(p.workspaces, ["a/*", "b/*"]);
});

test("pnpm-workspace.yaml packages: with quotes and comments", () => {
  const yaml = [
    "packages:",
    "  - 'packages/*'",
    '  - "apps/*"   # the apps',
    "  - components/*  # inline comment",
    "  # a whole-line comment",
    "",
    "  - tools/*",
  ].join("\n");
  const p = detectProfile(files({ "pnpm-workspace.yaml": yaml }), AT);
  assert.deepEqual(p.workspaces, ["packages/*", "apps/*", "components/*", "tools/*"]);
});

test("pnpm block ends at the next top-level key", () => {
  const yaml = ["packages:", "  - 'packages/*'", "onlyBuiltDependencies:", "  - esbuild"].join("\n");
  const p = detectProfile(files({ "pnpm-workspace.yaml": yaml }), AT);
  assert.deepEqual(p.workspaces, ["packages/*"]);
});

test("workspaces from both sources are concatenated and deduped in first-seen order", () => {
  const yaml = ["packages:", "  - 'apps/*'", "  - 'services/*'"].join("\n");
  const p = detectProfile(
    files({
      "package.json": pkg({ workspaces: ["packages/*", "apps/*"] }),
      "pnpm-workspace.yaml": yaml,
    }),
    AT,
  );
  assert.deepEqual(p.workspaces, ["packages/*", "apps/*", "services/*"]);
});

test("unterminated quote in pnpm yaml degrades to the stripped remainder", () => {
  const yaml = ["packages:", "  - 'apps/*"].join("\n");
  const p = detectProfile(files({ "pnpm-workspace.yaml": yaml }), AT);
  assert.deepEqual(p.workspaces, ["apps/*"]);
});

test("empty pnpm list items are skipped", () => {
  const yaml = ["packages:", "  -", "  - real/*"].join("\n");
  const p = detectProfile(files({ "pnpm-workspace.yaml": yaml }), AT);
  assert.deepEqual(p.workspaces, ["real/*"]);
});

// ---------------------------------------------------------------------------
// Scripts (verbatim, defensive)
// ---------------------------------------------------------------------------

test("scripts are copied verbatim, non-string values dropped", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ scripts: { build: "tsc -b", bad: 5, dev: "vite" } }) }),
    AT,
  );
  assert.deepEqual(p.scripts, { build: "tsc -b", dev: "vite" });
});

test("scripts is {} when the field is absent or wrong-typed", () => {
  assert.deepEqual(detectProfile(files({ "package.json": "{}" }), AT).scripts, {});
  assert.deepEqual(
    detectProfile(files({ "package.json": pkg({ scripts: "nope" }) }), AT).scripts,
    {},
  );
});

// ---------------------------------------------------------------------------
// Malformed package.json
// ---------------------------------------------------------------------------

test("malformed package.json is treated as absent but still selects npm", () => {
  const p = detectProfile(files({ "package.json": "{ not json" }), AT);
  assert.equal(p.packageManager, "npm"); // file present → npm
  assert.deepEqual(p.scripts, {});
  assert.deepEqual(p.workspaces, []);
  assert.deepEqual(p.testRunners, []);
});

test("package.json that parses to a non-object is treated as absent", () => {
  const p = detectProfile(files({ "package.json": "[1,2,3]" }), AT);
  assert.deepEqual(p.scripts, {});
  assert.deepEqual(p.workspaces, []);
});

test("structurally bad file entries are ignored, not thrown", () => {
  const bad = [
    { path: "package.json", content: pkg({ scripts: { dev: "vite" } }) },
    { path: 123 as unknown as string, content: "x" },
    { path: "x", content: null as unknown as string },
  ];
  const p = detectProfile(bad, AT);
  assert.equal(p.devServerCommand, "npm run dev");
});

// ---------------------------------------------------------------------------
// Test runners — each evidence class
// ---------------------------------------------------------------------------

test("runner detected from a devDependency", () => {
  const p = detectProfile(files({ "package.json": pkg({ devDependencies: { vitest: "^1" } }) }), AT);
  assert.deepEqual(p.testRunners, ["vitest"]);
});

test("runner detected from a dependency", () => {
  const p = detectProfile(files({ "package.json": pkg({ dependencies: { mocha: "^10" } }) }), AT);
  assert.deepEqual(p.testRunners, ["mocha"]);
});

test("runner detected from a config file alone", () => {
  const p = detectProfile(files({ "playwright.config.ts": "export default {}" }), AT);
  assert.deepEqual(p.testRunners, ["playwright"]);
});

test("jest config variants each count as evidence", () => {
  assert.deepEqual(detectProfile(files({ "jest.config.js": "" }), AT).testRunners, ["jest"]);
  assert.deepEqual(detectProfile(files({ "jest.config.ts": "" }), AT).testRunners, ["jest"]);
  assert.deepEqual(detectProfile(files({ "jest.config.json": "" }), AT).testRunners, ["jest"]);
});

test("vitest config variants (.ts/.js/.mts) each count", () => {
  assert.deepEqual(detectProfile(files({ "vitest.config.mts": "" }), AT).testRunners, ["vitest"]);
});

test("runner detected from script text", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ scripts: { test: "jest --ci" } }) }),
    AT,
  );
  assert.deepEqual(p.testRunners, ["jest"]);
});

test("playwright dependency key @playwright/test matches the needle", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ devDependencies: { "@playwright/test": "^1" } }) }),
    AT,
  );
  assert.deepEqual(p.testRunners, ["playwright"]);
});

test("node:test added when a script contains 'node --test'", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ scripts: { test: "node --test test/*.js" } }) }),
    AT,
  );
  assert.deepEqual(p.testRunners, ["node:test"]);
});

test("runners are emitted in stable order regardless of discovery order", () => {
  const p = detectProfile(
    files({
      "package.json": pkg({
        scripts: { t1: "node --test", t2: "mocha" },
        devDependencies: { jest: "^29", vitest: "^1" },
      }),
      "playwright.config.ts": "",
    }),
    AT,
  );
  assert.deepEqual(p.testRunners, ["vitest", "jest", "playwright", "mocha", "node:test"]);
});

test("no duplicate runner when multiple evidence classes agree", () => {
  const p = detectProfile(
    files({
      "package.json": pkg({ devDependencies: { vitest: "^1" }, scripts: { test: "vitest run" } }),
      "vitest.config.ts": "",
    }),
    AT,
  );
  assert.deepEqual(p.testRunners, ["vitest"]);
});

// ---------------------------------------------------------------------------
// devServerCommand — priority & pm prefix
// ---------------------------------------------------------------------------

test("devServer picks 'dev' first", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ scripts: { dev: "vite", serve: "http", start: "node ." } }) }),
    AT,
  );
  assert.equal(p.devServerCommand, "npm run dev");
});

test("devServer priority: start:dev before serve before start", () => {
  const withStartDev = detectProfile(
    files({ "package.json": pkg({ scripts: { "start:dev": "x", serve: "y", start: "z" } }) }),
    AT,
  );
  assert.equal(withStartDev.devServerCommand, "npm run start:dev");

  const withServe = detectProfile(
    files({ "package.json": pkg({ scripts: { serve: "y", start: "z" } }) }),
    AT,
  );
  assert.equal(withServe.devServerCommand, "npm run serve");

  const withStart = detectProfile(
    files({ "package.json": pkg({ scripts: { start: "z" } }) }),
    AT,
  );
  assert.equal(withStart.devServerCommand, "npm run start");
});

test("devServer is null when no matching script exists", () => {
  const p = detectProfile(files({ "package.json": pkg({ scripts: { build: "tsc" } }) }), AT);
  assert.equal(p.devServerCommand, null);
});

test("devServer uses the detected package manager prefix", () => {
  const pnpm = detectProfile(
    files({ "package.json": pkg({ scripts: { dev: "vite" } }), "pnpm-lock.yaml": "" }),
    AT,
  );
  assert.equal(pnpm.devServerCommand, "pnpm run dev");

  const yarn = detectProfile(
    files({ "package.json": pkg({ scripts: { dev: "vite" } }), "yarn.lock": "" }),
    AT,
  );
  assert.equal(yarn.devServerCommand, "yarn run dev");

  const bun = detectProfile(
    files({ "package.json": pkg({ scripts: { dev: "vite" } }), "bun.lockb": "" }),
    AT,
  );
  assert.equal(bun.devServerCommand, "bun run dev");
});

// ---------------------------------------------------------------------------
// typecheckCommand — full fallback chain
// ---------------------------------------------------------------------------

test("typecheck: explicit 'typecheck' script wins", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ scripts: { typecheck: "tsc --noEmit" } }) }),
    AT,
  );
  assert.equal(p.typecheckCommand, "npm run typecheck");
});

test("typecheck: falls back to a script running tsc --noEmit", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ scripts: { check: "tsc --noEmit -p ." } }) }),
    AT,
  );
  assert.equal(p.typecheckCommand, "npm run check");
});

test("typecheck: recognizes the single-dash -noEmit form", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ scripts: { check: "tsc -noEmit" } }) }),
    AT,
  );
  assert.equal(p.typecheckCommand, "npm run check");
});

test("typecheck: a tsc script without noEmit is not matched", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ scripts: { build: "tsc -b" } }) }),
    AT,
  );
  assert.equal(p.typecheckCommand, null);
});

test("typecheck: npx fallback when tsconfig + typescript dep both present", () => {
  const p = detectProfile(
    files({
      "package.json": pkg({ devDependencies: { typescript: "^5" } }),
      "tsconfig.json": "{}",
    }),
    AT,
  );
  assert.equal(p.typecheckCommand, "npx tsc --noEmit");
});

test("typecheck: no npx fallback without a typescript dependency", () => {
  const p = detectProfile(files({ "package.json": "{}", "tsconfig.json": "{}" }), AT);
  assert.equal(p.typecheckCommand, null);
});

test("typecheck: no npx fallback without tsconfig.json", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ devDependencies: { typescript: "^5" } }) }),
    AT,
  );
  assert.equal(p.typecheckCommand, null);
});

test("typecheck: script match preferred over npx fallback and uses pm prefix", () => {
  const p = detectProfile(
    files({
      "package.json": pkg({ scripts: { verify: "tsc --noEmit" }, devDependencies: { typescript: "^5" } }),
      "tsconfig.json": "{}",
      "pnpm-lock.yaml": "",
    }),
    AT,
  );
  assert.equal(p.typecheckCommand, "pnpm run verify");
});

// ---------------------------------------------------------------------------
// lintCommand
// ---------------------------------------------------------------------------

test("lint: 'lint' script → <pm> run lint", () => {
  const p = detectProfile(
    files({ "package.json": pkg({ scripts: { lint: "eslint ." } }), "yarn.lock": "" }),
    AT,
  );
  assert.equal(p.lintCommand, "yarn run lint");
});

test("lint: null when no 'lint' script", () => {
  const p = detectProfile(files({ "package.json": pkg({ scripts: { build: "tsc" } }) }), AT);
  assert.equal(p.lintCommand, null);
});

// ---------------------------------------------------------------------------
// Duplicate paths — last wins
// ---------------------------------------------------------------------------

test("duplicate file paths: last content wins", () => {
  const p = detectProfile(
    [
      { path: "package.json", content: pkg({ scripts: { dev: "old" } }) },
      { path: "package.json", content: pkg({ scripts: { start: "new" } }) },
    ],
    AT,
  );
  assert.equal(p.devServerCommand, "npm run start");
});
