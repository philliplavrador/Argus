#!/usr/bin/env bash
# Spike C Test 5a: cold npm install of frontend inside a worktree. Time-boxed 10 min.
set -u
FIX="C:/Users/phill/AppData/Local/Temp/claude/d--Projects-Argus/0636ba7b-5673-4655-ba57-197243db7acd/scratchpad/kiosk-fixture"
unset ANTHROPIC_API_KEY
cd "$FIX" || exit 1
# fresh worktree
git worktree add .argus/worktrees/wt-npm -b spike/wt-npm >/dev/null 2>&1
FE="$FIX/.argus/worktrees/wt-npm/app/frontend"
echo "target: $FE"
echo "npm version: $(npm --version)"
t0=$(date +%s%3N)
# time-box 600s via timeout; capture rc
( cd "$FE" && timeout 600 npm install --no-audit --no-fund > "$FIX/npm-cold.log" 2>&1 ); RC=$?
t1=$(date +%s%3N)
echo "npm_install_rc=$RC"
echo "npm_install_ms=$((t1-t0))"
echo "=== tail of npm-cold.log ==="
tail -15 "$FIX/npm-cold.log"
echo "=== node_modules size + count ==="
du -sh "$FE/node_modules" 2>/dev/null | cut -f1
echo "top-level pkg count:"; ls -1 "$FE/node_modules" 2>/dev/null | wc -l
echo "=== require-resolution sanity (react + vite) ==="
( cd "$FE" && node -e "require.resolve('react'); require.resolve('vite'); console.log('RESOLVE_OK react+vite')" 2>&1 )
