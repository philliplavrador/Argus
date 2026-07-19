# Spike C — Git worktrees on Windows, at Argus scale

Machine: Windows 11 Pro 10.0.26200, git 2.51.0.windows.1, Node v22.19.0, npm 10.9.3.
Fixture: disposable clone at `…/scratchpad/kiosk-fixture`, branch `feat/restructure`, **443 tracked files** (`git ls-files | wc -l` = 443). Mutated freely; restored clean at end (only `feat/restructure`, empty `.argus/worktrees/`, clean `git status`). The original repo it was cloned from was never referenced in any command.

All numbers below are quoted verbatim from command output. Scripts live in `d:\Projects\Argus\.argus-spikes\scripts\`.

---

## Test 1 — Churn (8× add → remove → branch -D)

`c1-churn.sh`, per-op wall-clock in ms. **All 24 ops rc=0, zero failures.**

| N | add_ms | remove_ms | branchD_ms |
|---|--------|-----------|------------|
| 1 | 275 | 4075 | 42 |
| 2 | 272 | 2906 | 43 |
| 3 | 262 | 2396 | 43 |
| 4 | 252 | 2723 | 48 |
| 5 | 267 | 2820 | 42 |
| 6 | 265 | 3523 | 66 |
| 7 | 307 | 4403 | 56 |
| 8 | 285 | 5967 | 47 |

**Finding — asymmetric cost.** `add` (checks out 443 files) is cheap and stable (**~252–307 ms**). `remove` is **10–20× slower (2.4–6.0 s)** and trends upward — Windows small-file *deletion* dominates. Budget worktree teardown at multiple seconds, not milliseconds. `branch -D` is negligible (~42–66 ms).

---

## Test 2 — Handle contention (live process holding an open file inside the worktree)

`c2-holder.mjs` opens `HELD_OPEN.txt` for write and `setInterval`s forever with cwd = worktree. Verified live: `ProcessId : 30572  CommandLine : D:\Apps\Node\node.exe …c2-holder.mjs`.

**Attempt 1 — plain `git worktree remove` (process alive):**
```
fatal: '.argus/worktrees/held' contains modified or untracked files, use --force to delete it
rc=128
```
(This guard fires on the *untracked* `HELD_OPEN.txt`, not the lock.)

**Attempt 2 — `git worktree remove --force` (process still alive):**
```
error: failed to delete 'C:/…/kiosk-fixture/.argus/worktrees/held': Permission denied
rc=255
```
**Critical:** despite the error, `--force` **deregistered the worktree from git metadata** — `git worktree list` immediately after showed only the main worktree, yet the directory **still existed on disk** (orphaned, holding the locked file).

**Attempt 3 — plain `git worktree remove` after killing the process:**
```
fatal: '.argus/worktrees/held' is not a working tree
rc=128
```
Because Attempt 2 already deregistered it. The orphaned dir had to be cleaned with a filesystem `rm -rf` (`manual rm -rf OK`), and `.git/worktrees` was already empty.

**Clean ordering verified (`kill FIRST`, then remove):** after `Stop-Process`, plain `remove` still returns `contains modified or untracked files … rc=128` (untracked-file guard — agents always leave untracked files), but **`git worktree remove --force` then succeeds: `rc=0`, 70 ms, dir gone.**

**Verdict (ii):** Removal policy = **kill the agent process, wait for exit, then `git worktree remove --force`.** `--force` is mandatory (untracked agent files trip plain remove). **Never** `remove --force` while the process is live: git deregisters the worktree but a `Permission denied` leaves a locked orphan directory that git can no longer see. If `--force` still fails (locks or long paths), fall back to git-bash `rm -rf <dir>` + `git worktree prune`.

---

## Test 3 — index.lock contention (concurrent `git worktree add`)

`c3-lock.mjs`: 4 concurrent `worktree add -b` via `Promise.all` over `child_process.execFile`. `c3b-stress.mjs`: 8 concurrent, each add followed by file write + `git add` + `git commit` (24 ops) to also stress shared refs/HEAD.

| scenario | runs | ops/run | failures | lockErrs |
|----------|------|---------|----------|----------|
| 4× concurrent `add` | 3 | 4 | **0** | **0** |
| 8× concurrent `add`+commit | 2 | 24 | **0** | **0** |

Every op `rc=0`, e.g. `rc=0 ms=273 lockErr=false :: worktree add .argus/worktrees/conc-1 -b spike/conc-1`. `SUMMARY: N=4 failures=0 lockErrs=0` (all runs). No `index.lock`, `config.lock`, `packed-refs.lock`, or "another git process" errors ever surfaced.

**Verdict (i):** **Serialization is NOT required for correctness.** The PLAN's assumption is **refuted** for `worktree add` on git 2.51 — each new worktree gets its own index and its own `refs/heads/spike/*`, so shared-lock contention did not materialize across 5 runs / 44 concurrent ops. WorktreeManager may keep a serializing mutex as cheap belt-and-suspenders, but it is not load-bearing. (Note this is about *add*; *removal* still needs the kill-then-force ordering from Test 2, unrelated to index.lock.)

---

## Test 4 — Long paths (>260 chars) inside a worktree

`c4-longpath.sh`. Worktree base path = 145 chars; nested dirs pushed the target file to **absolute length 471 chars**. `mkdir`/write via git-bash succeeded (MSYS is long-path aware); git behavior:

**Default (core.longpaths unset):**
```
warning: could not open directory '…/': Filename too long
fatal: pathspec '…maxpath_limit.txt' did not match any files      # git add rc=128
```
`git status --porcelain` also prints `Filename too long` but returns **rc=0** — it silently cannot see the file (worse than a hard error: no failure signal).

**With `-c core.longpaths=true`:** `git add` **rc=0**, `git status` shows the file staged (`A  …maxpath_limit.txt`).

**Config posture (verbatim):** `system: (unset)`, `global: (unset)`, `local: (unset)` → git default **false**. Confirmed again from inside the worktree: `(unset -> defaults to false)`.

**Bonus hazard:** `git worktree remove --force` on the long-path worktree failed:
```
error: failed to delete 'C:/…/wt-long': Filename too long
```
(deregistered the worktree but orphaned the directory). git-bash `rm -rf` cleaned it (`rm -rf OK`). This same failure recurred in Test 5 on worktrees containing `node_modules` (deep nested paths).

**Verdict (iii):** **core.longpaths is DISABLED on this machine at every scope.** With it off, long paths break `git add` (hard fail), make `git status` silently blind, **and break `git worktree remove`** (orphaned dirs). Argus **must** enable it — set `git config core.longpaths true` (repo-local) at provisioning, or pass `-c core.longpaths=true` on every git invocation. This is not optional for a 443-file repo whose worktrees live under a deep `…/scratchpad/kiosk-fixture/.argus/worktrees/<name>/…` prefix plus `node_modules`.

---

## Test 5 — node_modules provisioning (also gates v2.2 live-preview)

**package.json layout (4 manifests):** root (`concurrently, playwright, wait-on`), `app/backend` (12 deps + 6 dev), `app/frontend` (7 deps + 16 dev — **biggest set**, react/vite/tailwind/testing-library), `app/cleanup-server` (2 deps). Frontend chosen: largest dependency set **and** the live-preview-relevant one.

Installed set (frontend): **18,175 files, 179.9 MB, 384 top-level package dirs** (`added 463 packages`). npm cache confirmed **warm** (`C:\Users\phill\AppData\Local\npm-cache\_cacache` present) — so the install below is *cold-worktree / warm-cache*, the realistic Argus repeat-provisioning case, **not** a first-ever network install.

| variant | wall-clock | rc | require.resolve('react'), ('vite') |
|---------|-----------|----|-----------------------------------|
| (a) `npm install` (warm cache) | **6,643 ms** | 0 | `RESOLVE_OK` |
| (b) `robocopy /MIR` | **7,700 ms** | 1 (0–7 = success) | `ROBO RESOLVE_OK` |
| (c) junction `mklink /J` | **21 ms** | 0 | `JUNCTION RESOLVE_OK` |

Junction confirmed a real reparse point: `Attributes: Directory, ReparsePoint  LinkType: Junction  Target: …\wt-npm\…\node_modules`.

**Junction write-back hazard — CONFIRMED.** Writing `node_modules/.vite/deps/marker.txt` *through* the junction (simulating vite/esbuild caching) landed in the **shared source**: `YES - WRITE-BACK CONFIRMED. content: cachedata-from-junction-worktree`. Any build tool that writes inside `node_modules` (vite's `.vite`, patch-package, postinstall, `.bin` regen) corrupts every worktree sharing the junction. Junctions are also fragile on teardown: removing a worktree that contains a junction risks git recursing into the target — mitigated here by unlinking with `cmd /c rmdir` (removes the link, `source node_modules/react intact: True`) before deleting.

**Verdict (iv) — provisioning strategy.** Default to **per-worktree `npm ci` / `npm install` against the warm shared npm cache**: ~6.6 s, ~180 MB, fully isolated, correct `.bin` shims and platform-correct optional deps — and it actually **beats robocopy (7.7 s)** on both speed and correctness when the cache is warm. `robocopy /MIR` only wins if the npm cache is cold (network-bound); keep it as a fallback, not the default. **Junction (21 ms) is 300×+ faster but UNSAFE for anything that writes `node_modules`** — restrict it to read-only consumers (e.g. lint/typecheck/test runs that never mutate the tree), never for builds or live-preview.

**v2.2 live-preview affordability call.** A frontend preview (vite dev server) writes `node_modules/.vite`, so it **cannot share a junction** — each concurrent preview needs its **own** `node_modules`: **≈ 7 s startup + ≈ 180 MB disk per preview** (warm cache). That is affordable for a handful of concurrent previews (4 previews ≈ 28 s of parallelizable install + ~720 MB). Two hard prerequisites: (1) **pre-warm the npm cache once** — a cold-cache/first-ever install is network-bound and was *not* measured here, so treat it as the real cost floor; (2) **`core.longpaths=true`** must be set or `node_modules` breaks both add and removal (Test 4/5). A junction-with-redirected-cache-dir hybrid (`vite --cacheDir` outside node_modules) is possible but is config surgery — do not rely on it for v2.2; per-worktree install is the safe default.

---

## Four explicit verdicts

1. **Serialize worktree ops?** — **No** (for `add`). git 2.51 handled 4-way and 8-way concurrent `add` (+commit), 44 ops, zero index.lock/failures across 5 runs. PLAN assumption refuted; optional mutex only.
2. **Removal policy with live processes?** — **Kill the agent, wait, then `git worktree remove --force`.** `--force` is required (untracked files); doing it while alive deregisters the worktree but orphans a `Permission denied` locked dir. Fallback on failure: git-bash `rm -rf` + `git worktree prune`.
3. **longpaths posture?** — **Disabled** (unset at system/global/local → default false). Breaks add, blinds status, breaks worktree removal. **Argus must set `core.longpaths=true`.**
4. **Provisioning + live-preview cost?** — Default **per-worktree `npm install` on warm cache (~6.6 s / 180 MB, isolated)**; robocopy (7.7 s) as cold-cache fallback; **junction (21 ms) read-only only — write-back into shared node_modules confirmed.** Live-preview needs its own node_modules per worktree (~7 s + 180 MB each); affordable for a few concurrent previews given a pre-warmed npm cache and longpaths enabled.
