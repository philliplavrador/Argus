import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePath,
  toRepoRelative,
  matchGlob,
  pathInScope,
  scopesOverlap,
  suggestGlobForPath,
} from "../src/core/scope";
import type { Scope } from "../src/core/types";

const scope = (...include: string[]): Scope => ({ include });

// ---------------------------------------------------------------------------
// normalizePath
// ---------------------------------------------------------------------------

test("normalizePath: backslashes and duplicate slashes", () => {
  assert.equal(normalizePath("src\\lib\\date.ts"), "src/lib/date.ts");
  assert.equal(normalizePath("src//lib///date.ts"), "src/lib/date.ts");
  assert.equal(normalizePath("src\\\\lib//date.ts"), "src/lib/date.ts");
});

test("normalizePath: leading ./ and interior . segments", () => {
  assert.equal(normalizePath("./src/lib"), "src/lib");
  assert.equal(normalizePath("src/./lib/./date.ts"), "src/lib/date.ts");
  assert.equal(normalizePath("."), "");
  assert.equal(normalizePath("./"), "");
});

test("normalizePath: .. resolution and root clamping", () => {
  assert.equal(normalizePath("src/lib/../date.ts"), "src/date.ts");
  assert.equal(normalizePath("a/../../b"), "b"); // clamp: excess .. discarded
  assert.equal(normalizePath("../../b"), "b");
  assert.equal(normalizePath("a/b/../.."), "");
  assert.equal(normalizePath(".."), "");
});

test("normalizePath: trailing slash stripped except root", () => {
  assert.equal(normalizePath("src/lib/"), "src/lib");
  assert.equal(normalizePath("src/lib///"), "src/lib");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath("\\"), "/");
  assert.equal(normalizePath("///"), "/");
});

test("normalizePath: absolute paths keep their root", () => {
  assert.equal(normalizePath("/src/lib"), "/src/lib");
  assert.equal(normalizePath("/a/../b"), "/b");
  assert.equal(normalizePath("/a/../../b"), "/b"); // clamp at root
});

test("normalizePath: case preserved", () => {
  assert.equal(normalizePath("Src/Lib/Date.TS"), "Src/Lib/Date.TS");
});

test("normalizePath: unicode, spaces, and apostrophes in segments", () => {
  assert.equal(normalizePath("Kosik's Kiosk/src/café.ts"), "Kosik's Kiosk/src/café.ts");
  assert.equal(normalizePath("my dir\\a file.ts"), "my dir/a file.ts");
  assert.equal(normalizePath("naïve/π/λ.ts"), "naïve/π/λ.ts");
  // apostrophe segment is not special to .. handling
  assert.equal(normalizePath("Kosik's Kiosk/../x"), "x");
});

test("normalizePath: empty and non-string input", () => {
  assert.equal(normalizePath(""), "");
  assert.equal(normalizePath(undefined as unknown as string), "");
  assert.equal(normalizePath(null as unknown as string), "");
  assert.equal(normalizePath(42 as unknown as string), "");
});

// ---------------------------------------------------------------------------
// toRepoRelative
// ---------------------------------------------------------------------------

test("toRepoRelative: basic under-root relative path", () => {
  assert.equal(toRepoRelative("C:/repo", "C:/repo/src/lib/date.ts"), "src/lib/date.ts");
  assert.equal(toRepoRelative("C:/repo", "C:/repo"), "");
  assert.equal(toRepoRelative("C:/repo", "C:/repo/"), "");
});

test("toRepoRelative: segment-boundary safety (prefix is not containment)", () => {
  assert.equal(toRepoRelative("C:/repo", "C:/repo2/x"), null);
  assert.equal(toRepoRelative("C:/repo", "C:/repository/x"), null);
});

test("toRepoRelative: not under root at all", () => {
  assert.equal(toRepoRelative("C:/repo", "D:/other/x"), null);
  assert.equal(toRepoRelative("C:/repo/src", "C:/repo/test/x"), null);
});

test("toRepoRelative: drive-letter case differences", () => {
  assert.equal(toRepoRelative("c:/repo", "C:/repo/x"), "x");
  assert.equal(toRepoRelative("C:/Repo", "c:/repo/SRC/x"), "SRC/x"); // case preserved in result
});

test("toRepoRelative: mixed separators", () => {
  assert.equal(toRepoRelative("C:\\repo", "C:/repo/src\\x.ts"), "src/x.ts");
  assert.equal(toRepoRelative("C:/repo/", "C:\\repo\\a\\b"), "a/b");
});

test("toRepoRelative: apostrophes and spaces in the root (Kosik's Kiosk)", () => {
  assert.equal(
    toRepoRelative("D:/Projects/Kosik's Kiosk", "D:/Projects/Kosik's Kiosk/src/a.ts"),
    "src/a.ts",
  );
  assert.equal(
    toRepoRelative("D:/Projects/Kosik's Kiosk", "D:/Projects/Kosik's Kiosk2/x"),
    null,
  );
});

test("toRepoRelative: non-string input yields null", () => {
  assert.equal(toRepoRelative(undefined as unknown as string, "C:/repo/x"), null);
  assert.equal(toRepoRelative("C:/repo", null as unknown as string), null);
});

// ---------------------------------------------------------------------------
// matchGlob
// ---------------------------------------------------------------------------

test("matchGlob: exact literal match, case-insensitive", () => {
  assert.equal(matchGlob("README.md", "README.md"), true);
  assert.equal(matchGlob("readme.md", "README.MD"), true);
  assert.equal(matchGlob("src/lib/date.ts", "src/lib/date.ts"), true);
  assert.equal(matchGlob("src/lib/date.ts", "src/lib/time.ts"), false);
});

test("matchGlob: * matches within one segment, does not cross /", () => {
  assert.equal(matchGlob("src/*.ts", "src/date.ts"), true);
  assert.equal(matchGlob("src/*", "src/date.ts"), true);
  assert.equal(matchGlob("src/*", "src/lib/date.ts"), false); // * cannot cross /
  assert.equal(matchGlob("src/*/date.ts", "src/lib/date.ts"), true);
  assert.equal(matchGlob("*.ts", "date.ts"), true);
  assert.equal(matchGlob("*.ts", "src/date.ts"), false);
});

test("matchGlob: ? matches exactly one char within a segment", () => {
  assert.equal(matchGlob("date.?s", "date.ts"), true);
  assert.equal(matchGlob("date.?s", "date.js"), true);
  assert.equal(matchGlob("date.?s", "date.tss"), false);
  assert.equal(matchGlob("a?c", "abc"), true);
  assert.equal(matchGlob("a?c", "a/c"), false); // ? cannot be the separator
});

test("matchGlob: ** matches zero or more whole segments", () => {
  assert.equal(matchGlob("src/**", "src/lib/date.ts"), true);
  assert.equal(matchGlob("src/**", "src/date.ts"), true);
  assert.equal(matchGlob("**", ""), true); // ** matches the root
  assert.equal(matchGlob("**", "a/b/c"), true);
  assert.equal(matchGlob("**/date.ts", "date.ts"), true); // ** zero segments
  assert.equal(matchGlob("**/date.ts", "src/lib/date.ts"), true);
});

test("matchGlob: dir/** also matches the directory itself", () => {
  assert.equal(matchGlob("src/**", "src"), true);
  assert.equal(matchGlob("src/lib/**", "src/lib"), true);
  assert.equal(matchGlob("src/**", "srcs"), false); // still boundary-safe
});

test("matchGlob: nested ** and interior ** segments", () => {
  assert.equal(matchGlob("a/**/b", "a/b"), true); // zero between
  assert.equal(matchGlob("a/**/b", "a/x/b"), true);
  assert.equal(matchGlob("a/**/b", "a/x/y/z/b"), true);
  assert.equal(matchGlob("a/**/b", "a/x/y"), false);
  assert.equal(matchGlob("**/lib/**", "src/lib/util/x.ts"), true);
  assert.equal(matchGlob("src/**/*.ts", "src/a/b/c.ts"), true);
  assert.equal(matchGlob("src/**/*.ts", "src/c.ts"), true);
});

test("matchGlob: mixed separators and . segments in relPath are normalized", () => {
  assert.equal(matchGlob("src/**", "src\\lib\\date.ts"), true);
  assert.equal(matchGlob("src/**", "./src/lib/date.ts"), true);
  assert.equal(matchGlob("src/lib/**", "src//lib//date.ts"), true);
});

test("matchGlob: malformed globs fail closed", () => {
  assert.equal(matchGlob("src/{a,b}/**", "src/a/x"), false);
  assert.equal(matchGlob("src/[abc].ts", "src/a.ts"), false);
  assert.equal(matchGlob("!src/**", "src/x"), false); // negation at position 0
  assert.equal(matchGlob("]bad", "]bad"), false);
  assert.equal(matchGlob("a}b", "a}b"), false);
});

test("matchGlob: ! only malformed at position 0", () => {
  // A bang elsewhere is a literal char, not negation.
  assert.equal(matchGlob("a!b.ts", "a!b.ts"), true);
});

test("matchGlob: non-string input fails closed", () => {
  assert.equal(matchGlob(undefined as unknown as string, "x"), false);
  assert.equal(matchGlob("**", undefined as unknown as string), false);
});

// ---------------------------------------------------------------------------
// pathInScope
// ---------------------------------------------------------------------------

test("pathInScope: any include glob matching wins", () => {
  const s = scope("src/**", "test/**", "README.md");
  assert.equal(pathInScope(s, "src/lib/date.ts"), true);
  assert.equal(pathInScope(s, "test/scope.test.ts"), true);
  assert.equal(pathInScope(s, "README.md"), true);
  assert.equal(pathInScope(s, "package.json"), false);
  assert.equal(pathInScope(s, "docs/x.md"), false);
});

test("pathInScope: empty include covers nothing", () => {
  assert.equal(pathInScope(scope(), "src/x.ts"), false);
  assert.equal(pathInScope(scope(), ""), false);
});

test("pathInScope: a malformed glob in the list does not match, others still can", () => {
  const s = scope("src/{a}/**", "test/**");
  assert.equal(pathInScope(s, "src/a/x"), false); // malformed glob ignored
  assert.equal(pathInScope(s, "test/x"), true);
});

test("pathInScope: defensive against missing/malformed scope", () => {
  assert.equal(pathInScope(undefined as unknown as Scope, "x"), false);
  assert.equal(pathInScope({} as unknown as Scope, "x"), false);
  assert.equal(pathInScope({ include: "src/**" } as unknown as Scope, "src/x"), false);
});

// ---------------------------------------------------------------------------
// scopesOverlap
// ---------------------------------------------------------------------------

test("scopesOverlap: identical scopes overlap", () => {
  assert.equal(scopesOverlap(scope("src/**"), scope("src/**")), true);
});

test("scopesOverlap: disjoint directories do not overlap", () => {
  assert.equal(scopesOverlap(scope("src/**"), scope("test/**")), false);
  assert.equal(scopesOverlap(scope("src/a/**"), scope("src/b/**")), false);
  assert.equal(scopesOverlap(scope("README.md"), scope("LICENSE")), false);
});

test("scopesOverlap: ** overlaps anything (both directions)", () => {
  assert.equal(scopesOverlap(scope("**"), scope("src/lib/date.ts")), true);
  assert.equal(scopesOverlap(scope("src/lib/date.ts"), scope("**")), true);
  assert.equal(scopesOverlap(scope("**"), scope("**")), true);
  assert.equal(scopesOverlap(scope("src/**"), scope("**/date.ts")), true);
});

test("scopesOverlap: is symmetric", () => {
  const a = scope("src/*/util.ts");
  const b = scope("src/billing/**");
  assert.equal(scopesOverlap(a, b), scopesOverlap(b, a));
  assert.equal(scopesOverlap(a, b), true);
});

test("scopesOverlap: * segment unifies with a concrete segment", () => {
  assert.equal(scopesOverlap(scope("src/*/util.ts"), scope("src/billing/util.ts")), true);
  assert.equal(scopesOverlap(scope("src/*/util.ts"), scope("src/billing/other.ts")), false);
  assert.equal(scopesOverlap(scope("src/*.ts"), scope("src/date.ts")), true);
  assert.equal(scopesOverlap(scope("src/a*.ts"), scope("src/b*.ts")), false);
  assert.equal(scopesOverlap(scope("src/a*.ts"), scope("src/*b.ts")), true); // "ab.ts"
});

test("scopesOverlap: differing lengths without ** do not overlap", () => {
  assert.equal(scopesOverlap(scope("src/lib"), scope("src/lib/date.ts")), false);
  assert.equal(scopesOverlap(scope("src/*"), scope("src/lib/date.ts")), false);
});

test("scopesOverlap: interior ** absorbing a concrete tail segment", () => {
  assert.equal(scopesOverlap(scope("src/**/x.ts"), scope("src/a/b/x.ts")), true);
  assert.equal(scopesOverlap(scope("src/**/x.ts"), scope("src/a/b/y.ts")), false);
  assert.equal(scopesOverlap(scope("a/**/d"), scope("a/b/c/d")), true);
});

test("scopesOverlap: any overlapping pair across multi-glob scopes", () => {
  const a = scope("docs/**", "src/lib/**");
  const b = scope("build/**", "src/lib/date.ts");
  assert.equal(scopesOverlap(a, b), true); // src/lib/** vs src/lib/date.ts
  assert.equal(scopesOverlap(scope("docs/**"), scope("build/**", "dist/**")), false);
});

test("scopesOverlap: empty include on either side means no overlap", () => {
  assert.equal(scopesOverlap(scope(), scope("**")), false);
  assert.equal(scopesOverlap(scope("**"), scope()), false);
  assert.equal(scopesOverlap(scope(), scope()), false);
});

test("scopesOverlap: malformed glob overlaps nothing (matches nothing)", () => {
  assert.equal(scopesOverlap(scope("src/{a}/**"), scope("src/**")), false);
  assert.equal(scopesOverlap(scope("!src/**"), scope("src/**")), false);
});

test("scopesOverlap: defensive against missing scopes", () => {
  assert.equal(scopesOverlap(undefined as unknown as Scope, scope("**")), false);
  assert.equal(scopesOverlap(scope("**"), null as unknown as Scope), false);
});

// ---------------------------------------------------------------------------
// suggestGlobForPath
// ---------------------------------------------------------------------------

test("suggestGlobForPath: nested file suggests parent dir + /**", () => {
  assert.equal(suggestGlobForPath("src/lib/date.ts"), "src/lib/**");
  assert.equal(suggestGlobForPath("src/a/b/c/x.ts"), "src/a/b/c/**");
  assert.equal(suggestGlobForPath("test/scope.test.ts"), "test/**");
});

test("suggestGlobForPath: top-level file suggests itself", () => {
  assert.equal(suggestGlobForPath("README.md"), "README.md");
  assert.equal(suggestGlobForPath("package.json"), "package.json");
});

test("suggestGlobForPath: normalizes separators and . segments first", () => {
  assert.equal(suggestGlobForPath("src\\lib\\date.ts"), "src/lib/**");
  assert.equal(suggestGlobForPath("./src/lib/date.ts"), "src/lib/**");
  assert.equal(suggestGlobForPath("src/lib/"), "src/**");
});

test("suggestGlobForPath: empty input yields empty string", () => {
  assert.equal(suggestGlobForPath(""), "");
  assert.equal(suggestGlobForPath("."), "");
});
