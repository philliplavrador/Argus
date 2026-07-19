#!/usr/bin/env bash
# Spike C Test 2: remove a worktree with a live process holding an open handle inside it.
set -u
FIX="C:/Users/phill/AppData/Local/Temp/claude/d--Projects-Argus/0636ba7b-5673-4655-ba57-197243db7acd/scratchpad/kiosk-fixture"
HOLDER="d:/Projects/Argus/.argus-spikes/scripts/c2-holder.mjs"
cd "$FIX" || exit 1
WT=".argus/worktrees/held"
BR="spike/held"
ABS_WT="$FIX/$WT"

echo "### add worktree"
git worktree add "$WT" -b "$BR" 2>&1

echo "### spawn holder with cwd inside worktree"
# Launch node detached, cwd = worktree. Capture pid.
( cd "$ABS_WT" && node "$HOLDER" > "$FIX/holder.out" 2>&1 & echo $! > "$FIX/holder.pid" )
sleep 2
PID=$(cat "$FIX/holder.pid")
echo "holder pid=$PID"
echo "holder.out:"; cat "$FIX/holder.out"
# Windows PID: node under bash may report bash-subshell pid; capture the node via wmic too
echo "### node processes:"
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*c2-holder*' } | Select-Object ProcessId,CommandLine | Format-List" 2>&1

echo ""
echo "### ATTEMPT 1: plain git worktree remove (expect failure)"
git worktree remove "$WT" 2>&1; echo "rc=$?"

echo ""
echo "### ATTEMPT 2: git worktree remove --force (process still alive)"
git worktree remove --force "$WT" 2>&1; echo "rc=$?"

echo ""
echo "### list after force attempt"
git worktree list 2>&1
echo "worktree dir still exists? "; [ -d "$ABS_WT" ] && echo "YES" || echo "NO"

echo ""
echo "### KILL holder (all matching node processes)"
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*c2-holder*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force; Write-Output ('killed ' + \$_.ProcessId) }" 2>&1
sleep 2

echo ""
echo "### ATTEMPT 3: plain git worktree remove after kill (expect success)"
git worktree remove "$WT" 2>&1; echo "rc=$?"
echo "worktree dir still exists? "; [ -d "$ABS_WT" ] && echo "YES" || echo "NO"

echo ""
echo "### cleanup branch + prune"
git branch -D "$BR" 2>&1
git worktree prune -v 2>&1
git worktree list 2>&1
rm -f "$FIX/holder.out" "$FIX/holder.pid"
