# Spike C Test 5b/5c via PowerShell (native robocopy + mklink).
$ErrorActionPreference = 'Continue'
$FIX = 'C:\Users\phill\AppData\Local\Temp\claude\d--Projects-Argus\0636ba7b-5673-4655-ba57-197243db7acd\scratchpad\kiosk-fixture'
$src = Join-Path $FIX '.argus\worktrees\wt-npm\app\frontend\node_modules'
Write-Output "SRC exists: $(Test-Path $src)"

# ---- 5b robocopy /MIR ----
$dstRobo = Join-Path $FIX '.argus\worktrees\wt-robo\app\frontend\node_modules'
Write-Output "`n=== 5b robocopy /MIR ==="
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$null = robocopy $src $dstRobo /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1
$rc = $LASTEXITCODE
$sw.Stop()
Write-Output "robocopy_rc=$rc (0-7=ok, >=8=fail)"
Write-Output ("robocopy_ms=" + [int]$sw.Elapsed.TotalMilliseconds)
Write-Output ("dst top-level count: " + (Get-ChildItem $dstRobo -ErrorAction SilentlyContinue | Measure-Object).Count)
Push-Location (Join-Path $FIX '.argus\worktrees\wt-robo\app\frontend')
node -e "require.resolve('react');require.resolve('vite');console.log('ROBO RESOLVE_OK')"
Pop-Location

# ---- 5c junction ----
$dstJ = Join-Path $FIX '.argus\worktrees\wt-junction\app\frontend\node_modules'
Write-Output "`n=== 5c junction (mklink /J) ==="
$sw = [System.Diagnostics.Stopwatch]::StartNew()
cmd /c mklink /J "$dstJ" "$src"
$rc = $LASTEXITCODE
$sw.Stop()
Write-Output "mklink_rc=$rc"
Write-Output ("mklink_ms=" + [int]$sw.Elapsed.TotalMilliseconds)
Write-Output ("dst (via junction) top-level count: " + (Get-ChildItem $dstJ -ErrorAction SilentlyContinue | Measure-Object).Count)
Push-Location (Join-Path $FIX '.argus\worktrees\wt-junction\app\frontend')
node -e "require.resolve('react');require.resolve('vite');console.log('JUNCTION RESOLVE_OK')"
Pop-Location
Write-Output "reparsepoint check:"
$item = Get-Item $dstJ -Force
Write-Output ("Attributes: " + $item.Attributes + " LinkType: " + $item.LinkType + " Target: " + $item.Target)
