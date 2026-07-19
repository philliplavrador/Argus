#!/usr/bin/env bash
# Spike C Test 4: long path handling inside a worktree.
set -u
FIX="C:/Users/phill/AppData/Local/Temp/claude/d--Projects-Argus/0636ba7b-5673-4655-ba57-197243db7acd/scratchpad/kiosk-fixture"
cd "$FIX" || exit 1
git worktree add .argus/worktrees/wt-long -b spike/wt-long >/dev/null 2>&1
BASE="$FIX/.argus/worktrees/wt-long"
echo "worktree base len: ${#BASE}"
# Build nested dirs to push absolute path well past 260
SEG="deeply_nested_segment_dir_abcdefghijklmnopqrstuvwxyz_0123456789"
REL="$SEG/$SEG/$SEG/$SEG"
DEEP="$BASE/$REL"
FILE="$DEEP/some_long_file_name_that_pushes_us_over_the_windows_maxpath_limit.txt"
echo "target abs path len: ${#FILE}"
echo "=== mkdir -p (via git bash) ==="
mkdir -p "$DEEP" 2>&1 && echo "mkdir OK" || echo "mkdir FAILED"
echo "=== write file ==="
printf 'long path content\n' > "$FILE" 2>&1 && echo "write OK" || echo "write FAILED"
echo "=== git add + status (run from worktree, core.longpaths currently unset) ==="
cd "$BASE" || exit 1
echo "-- default (longpaths unset) --"
git add "$REL/some_long_file_name_that_pushes_us_over_the_windows_maxpath_limit.txt" 2>&1; echo "add rc=$?"
git status --porcelain 2>&1 | head -5; echo "status rc=${PIPESTATUS[0]}"
echo "-- now with -c core.longpaths=true --"
git -c core.longpaths=true add "$REL/some_long_file_name_that_pushes_us_over_the_windows_maxpath_limit.txt" 2>&1; echo "add rc=$?"
git -c core.longpaths=true status --porcelain 2>&1 | head -5; echo "status rc=${PIPESTATUS[0]}"
echo "=== effective config from inside worktree ==="
git config --get core.longpaths 2>&1 || echo "(unset -> defaults to false)"
# cleanup
cd "$FIX"
git worktree remove --force .argus/worktrees/wt-long 2>&1
git branch -D spike/wt-long 2>&1
