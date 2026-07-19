#!/usr/bin/env bash
# Spike C Test 1: worktree churn. 8x add -> remove + branch -D. Per-op ms.
set -u
FIX="C:/Users/phill/AppData/Local/Temp/claude/d--Projects-Argus/0636ba7b-5673-4655-ba57-197243db7acd/scratchpad/kiosk-fixture"
cd "$FIX" || exit 1
now_ms() { date +%s%3N; }
echo "N,add_ms,add_rc,remove_ms,remove_rc,branchD_ms,branchD_rc"
for N in 1 2 3 4 5 6 7 8; do
  WT=".argus/worktrees/task-$N"
  BR="spike/task-$N"
  t0=$(now_ms); out_add=$(git worktree add "$WT" -b "$BR" 2>&1); rc_add=$?; t1=$(now_ms)
  out_rm=$(git worktree remove "$WT" 2>&1); rc_rm=$?; t2=$(now_ms)
  out_bd=$(git branch -D "$BR" 2>&1); rc_bd=$?; t3=$(now_ms)
  echo "$N,$((t1-t0)),$rc_add,$((t2-t1)),$rc_rm,$((t3-t2)),$rc_bd"
  if [ $rc_add -ne 0 ]; then echo "  ADD_ERR: $out_add"; fi
  if [ $rc_rm -ne 0 ]; then echo "  RM_ERR: $out_rm"; fi
  if [ $rc_bd -ne 0 ]; then echo "  BD_ERR: $out_bd"; fi
done
echo "=== final worktree list ==="
git worktree list
echo "=== prune ==="
git worktree prune -v 2>&1
