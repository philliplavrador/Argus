#!/usr/bin/env bash
# Spike C Test 5b/5c: provision node_modules into new worktrees via robocopy /MIR and junction.
set -u
FIX="C:/Users/phill/AppData/Local/Temp/claude/d--Projects-Argus/0636ba7b-5673-4655-ba57-197243db7acd/scratchpad/kiosk-fixture"
cd "$FIX" || exit 1
SRC_FE="$FIX/.argus/worktrees/wt-npm/app/frontend/node_modules"
# to Windows backslash form for cmd/robocopy/mklink
winpath() { echo "$1" | sed -e 's#/#\\#g' -e 's#^\\\([A-Za-z]\)\\#\1:\\#'; }

echo "=== source node_modules present? ==="
[ -d "$SRC_FE" ] && echo "YES" || { echo "NO - abort"; exit 1; }
echo "source top-level pkg count: $(ls -1 "$SRC_FE" | wc -l)"

# ---- 5b robocopy /MIR ----
git worktree add .argus/worktrees/wt-robo -b spike/wt-robo >/dev/null 2>&1
DST_ROBO="$FIX/.argus/worktrees/wt-robo/app/frontend/node_modules"
mkdir -p "$DST_ROBO"
SRC_W=$(winpath "$SRC_FE"); DST_W=$(winpath "$DST_ROBO")
echo ""; echo "=== 5b robocopy /MIR ==="
echo "src: $SRC_W"; echo "dst: $DST_W"
t0=$(date +%s%3N)
# robocopy exit codes 0-7 are success; >=8 failure. /NFL /NDL /NJH /NJS quiet.
cmd //c "robocopy \"$SRC_W\" \"$DST_W\" /MIR /NFL /NDL /NJH /NP /R:1 /W:1 >nul 2>&1"; RC=$?
t1=$(date +%s%3N)
echo "robocopy_rc=$RC (0-7=ok, >=8=fail)"; echo "robocopy_ms=$((t1-t0))"
echo "dst top-level pkg count: $(ls -1 "$DST_ROBO" 2>/dev/null | wc -l)"
echo "sanity require react+vite:"
( cd "$FIX/.argus/worktrees/wt-robo/app/frontend" && node -e "require.resolve('react');require.resolve('vite');console.log('ROBO RESOLVE_OK')" 2>&1 )

# ---- 5c junction ----
git worktree add .argus/worktrees/wt-junction -b spike/wt-junction >/dev/null 2>&1
DST_J="$FIX/.argus/worktrees/wt-junction/app/frontend/node_modules"
# ensure parent exists, ensure link target does NOT pre-exist
mkdir -p "$FIX/.argus/worktrees/wt-junction/app/frontend"
DST_JW=$(winpath "$DST_J")
echo ""; echo "=== 5c junction (mklink /J) ==="
echo "link: $DST_JW"; echo "target: $SRC_W"
t0=$(date +%s%3N)
cmd //c "mklink /J \"$DST_JW\" \"$SRC_W\"" 2>&1; RC=$?
t1=$(date +%s%3N)
echo "mklink_rc=$RC"; echo "mklink_ms=$((t1-t0))"
echo "dst (via junction) top-level pkg count: $(ls -1 "$DST_J" 2>/dev/null | wc -l)"
echo "sanity require react+vite:"
( cd "$FIX/.argus/worktrees/wt-junction/app/frontend" && node -e "require.resolve('react');require.resolve('vite');console.log('JUNCTION RESOLVE_OK')" 2>&1 )
echo "is junction? (fsutil reparsepoint):"
cmd //c "fsutil reparsepoint query \"$DST_JW\"" 2>&1 | head -3
