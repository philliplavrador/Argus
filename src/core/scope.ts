/**
 * Path normalization and the scope/glob engine ScopeGuard runs on every write.
 * No `vscode` imports, no SDK — pure functions, unit-testable under node:test.
 *
 * This is a security boundary: a false "in scope" lets an agent write where it
 * shouldn't. Every function therefore fails CLOSED — a malformed glob, a weird
 * path, or a non-string input is treated as "no match" / "out of scope" rather
 * than throwing. `scopesOverlap` is the one exception to "closed by default":
 * it is a conservative collision warning that must never under-report, so it
 * errs toward reporting overlap when uncertain.
 *
 * The supported glob subset (see types.ts `Scope`) is `**`, `*`, `?`, all
 * matched case-insensitively (Windows-first product). Braces, extglobs, and
 * negation are unsupported and rejected as malformed. Matching is implemented
 * by segment-wise recursion — never by building a RegExp from user input.
 */

import { Scope } from "./types";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Canonicalize a path to forward slashes, textually resolving `.`/`..`:
 * backslashes become `/`, duplicate slashes collapse, `.` segments drop, `..`
 * pops the previous segment (clamped at root — leading `..` are discarded, so
 * `a/../../b` → `b`), a trailing slash is stripped (except a bare root `/`),
 * and a leading `./` is stripped. Case is preserved. Non-string input → `""`.
 */
export function normalizePath(p: string): string {
  if (typeof p !== "string") {
    return "";
  }
  const slashed = p.replace(/\\/g, "/");
  const absolute = slashed.startsWith("/");
  const out: string[] = [];
  for (const seg of slashed.split("/")) {
    if (seg === "" || seg === ".") {
      continue; // duplicate slash or `.` segment
    }
    if (seg === "..") {
      if (out.length > 0) {
        out.pop();
      }
      continue; // clamp at root: excess `..` discarded
    }
    out.push(seg);
  }
  const joined = out.join("/");
  return absolute ? "/" + joined : joined;
}

/** Split a normalized path into its non-empty segments. */
function segmentsOf(normalized: string): string[] {
  return normalized.split("/").filter((s) => s.length > 0);
}

/**
 * Repo-relative form of absolute `pAbs`, or `null` when `pAbs` is not under
 * absolute `rootAbs`. Comparison is case-insensitive and segment-boundary-safe
 * (`C:/repo2/x` is NOT under `C:/repo`), tolerant of mixed separators and
 * drive-letter case (`c:` vs `C:`). Returns `""` when `pAbs` IS `rootAbs`.
 * Non-string input → `null`.
 */
export function toRepoRelative(rootAbs: string, pAbs: string): string | null {
  if (typeof rootAbs !== "string" || typeof pAbs !== "string") {
    return null;
  }
  const rootSegs = segmentsOf(normalizePath(rootAbs));
  const pSegs = segmentsOf(normalizePath(pAbs));
  if (pSegs.length < rootSegs.length) {
    return null;
  }
  for (let i = 0; i < rootSegs.length; i++) {
    if (rootSegs[i].toLowerCase() !== pSegs[i].toLowerCase()) {
      return null;
    }
  }
  return pSegs.slice(rootSegs.length).join("/");
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * A glob is malformed (and thus matches nothing) if it contains any brace or
 * bracket — `{`, `}`, `[`, `]` — or begins with `!`. These signal brace
 * expansion, character classes, or negation, none of which the subset
 * supports; rejecting them keeps matching from silently mis-scoping a write.
 */
function isGlobMalformed(glob: string): boolean {
  if (typeof glob !== "string") {
    return true;
  }
  if (/[{}[\]]/.test(glob)) {
    return true;
  }
  return glob[0] === "!";
}

/**
 * Whether single-segment pattern `pat` (with `*` = zero+ chars, `?` = one
 * char) matches `text`, case-insensitively. Neither wildcard crosses `/` — the
 * caller has already split on segment boundaries. Iterative greedy match with
 * backtracking over `*`; no RegExp involved.
 */
function matchSegment(pat: string, text: string): boolean {
  const p = pat.toLowerCase();
  const t = text.toLowerCase();
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) {
      pi++;
      ti++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi;
      mark = ti;
      pi++;
    } else if (star !== -1) {
      pi = star + 1;
      mark++;
      ti = mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") {
    pi++;
  }
  return pi === p.length;
}

/**
 * Whether glob segments `g` match path segments `p` starting at `gi`/`pi`.
 * `**` matches zero or more whole segments (so `dir/**` matches `dir` itself);
 * other segments match one-to-one via `matchSegment`.
 */
function matchSegments(g: string[], p: string[], gi: number, pi: number): boolean {
  while (gi < g.length) {
    if (g[gi] === "**") {
      for (let k = pi; k <= p.length; k++) {
        if (matchSegments(g, p, gi + 1, k)) {
          return true;
        }
      }
      return false;
    }
    if (pi >= p.length) {
      return false;
    }
    if (!matchSegment(g[gi], p[pi])) {
      return false;
    }
    gi++;
    pi++;
  }
  return pi === p.length;
}

/**
 * Whether `glob` matches repo-relative `relPath`, case-insensitively, over the
 * subset `**` (zero+ whole segments), `*` (within one segment), `?` (one char
 * within a segment). A malformed glob or non-string input → `false` (fail
 * closed). `relPath` is normalized first, so mixed separators and `.` segments
 * are handled.
 */
export function matchGlob(glob: string, relPath: string): boolean {
  if (typeof glob !== "string" || typeof relPath !== "string") {
    return false;
  }
  if (isGlobMalformed(glob)) {
    return false;
  }
  const gSegs = segmentsOf(normalizePath(glob));
  const pSegs = segmentsOf(normalizePath(relPath));
  return matchSegments(gSegs, pSegs, 0, 0);
}

// ---------------------------------------------------------------------------
// Scope membership
// ---------------------------------------------------------------------------

/**
 * Whether `relPath` is covered by `scope` — true if ANY include glob matches.
 * An empty (or missing/malformed) include list covers nothing → `false`.
 */
export function pathInScope(scope: Scope, relPath: string): boolean {
  if (!scope || !Array.isArray(scope.include)) {
    return false;
  }
  for (const glob of scope.include) {
    if (typeof glob === "string" && matchGlob(glob, relPath)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Overlap (conservative collision detection)
// ---------------------------------------------------------------------------

/**
 * Whether two single-segment patterns could match a common string. Precise
 * over `*`/`?`: recursion consumes literals/`?` in lockstep and lets either
 * `*` absorb zero or more characters of the other side. Case-insensitive.
 */
function segmentsIntersect(a: string, b: string, i: number, j: number): boolean {
  while (i < a.length && j < b.length) {
    if (a[i] === "*") {
      // `*` matches empty (advance a) or absorbs one char of b.
      return segmentsIntersect(a, b, i + 1, j) || segmentsIntersect(a, b, i, j + 1);
    }
    if (b[j] === "*") {
      return segmentsIntersect(a, b, i, j + 1) || segmentsIntersect(a, b, i + 1, j);
    }
    if (a[i] === "?" || b[j] === "?" || a[i].toLowerCase() === b[j].toLowerCase()) {
      i++;
      j++;
    } else {
      return false;
    }
  }
  // Whatever remains on either side must be all `*` to match the empty tail.
  while (i < a.length && a[i] === "*") {
    i++;
  }
  while (j < b.length && b[j] === "*") {
    j++;
  }
  return i === a.length && j === b.length;
}

/**
 * Whether glob segments `a` and `b` could share a common path, by simultaneous
 * segment unification: `**` on either side absorbs zero or more segments of the
 * other; ordinary segments must pairwise intersect. Conservative — returns
 * true whenever a common path could exist.
 */
function overlapSegments(a: string[], b: string[], i: number, j: number): boolean {
  while (true) {
    if (i < a.length && a[i] === "**") {
      for (let k = j; k <= b.length; k++) {
        if (overlapSegments(a, b, i + 1, k)) {
          return true;
        }
      }
      return false;
    }
    if (j < b.length && b[j] === "**") {
      for (let k = i; k <= a.length; k++) {
        if (overlapSegments(a, b, k, j + 1)) {
          return true;
        }
      }
      return false;
    }
    if (i >= a.length && j >= b.length) {
      return true; // both fully consumed
    }
    if (i >= a.length || j >= b.length) {
      return false; // one ran out with no `**` to absorb the rest
    }
    if (!segmentsIntersect(a[i], b[j], 0, 0)) {
      return false;
    }
    i++;
    j++;
  }
}

/**
 * Whether globs `g1` and `g2` could match a common repo-relative path. A
 * malformed glob matches nothing, so it overlaps nothing → `false`. Otherwise
 * conservative: true whenever a shared path could exist.
 */
function globsOverlap(g1: string, g2: string): boolean {
  if (isGlobMalformed(g1) || isGlobMalformed(g2)) {
    return false;
  }
  const s1 = segmentsOf(normalizePath(g1));
  const s2 = segmentsOf(normalizePath(g2));
  return overlapSegments(s1, s2, 0, 0);
}

/**
 * Whether scopes `a` and `b` could both cover some common path — the collision
 * warning ScopeGuard surfaces. Conservative: MUST return true whenever a shared
 * path could exist (false positives acceptable, false negatives not). An empty
 * include on either side covers nothing → `false`.
 */
export function scopesOverlap(a: Scope, b: Scope): boolean {
  if (!a || !b || !Array.isArray(a.include) || !Array.isArray(b.include)) {
    return false;
  }
  for (const g1 of a.include) {
    if (typeof g1 !== "string") {
      continue;
    }
    for (const g2 of b.include) {
      if (typeof g2 === "string" && globsOverlap(g1, g2)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/**
 * The default expand-scope suggestion for a path: its parent directory plus
 * `/**` (`src/lib/date.ts` → `src/lib/**`). A top-level file has no parent
 * directory, so it suggests itself (`README.md` → `README.md`). `relPath` is
 * normalized first; empty input → `""`.
 */
export function suggestGlobForPath(relPath: string): string {
  const norm = normalizePath(relPath);
  const segs = segmentsOf(norm);
  if (segs.length <= 1) {
    return norm;
  }
  return segs.slice(0, -1).join("/") + "/**";
}
