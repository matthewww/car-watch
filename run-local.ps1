# Duster Watch — local scheduled fetcher.
# AutoTrader 503-blocks GitHub-hosted runners, so this script runs via Windows
# Task Scheduler ("DusterWatch" task), commits any data changes, and pushes;
# the push-alert.yml workflow then relays data/alert.txt to ntfy.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$log = Join-Path $PSScriptRoot "watch.log"

function Log($m) { "$(Get-Date -Format s) $m" | Add-Content $log }

Log "run start"
# analyst reads ANALYZE_API_KEY (CI secret name); map from the local user env
if (-not $env:ANALYZE_API_KEY -and $env:OPENCODE_TOGETHER_AI) { $env:ANALYZE_API_KEY = $env:OPENCODE_TOGETHER_AI }
$out = node fetch-listings.mjs 2>&1
$out | Out-File -Append -Encoding utf8 $log
if ($LASTEXITCODE -ne 0) { Log "FAILED: fetch-listings exited $LASTEXITCODE"; exit 1 }

$out = node analyze.mjs 2>&1
$out | Out-File -Append -Encoding utf8 $log
if ($LASTEXITCODE -ne 0) { Log "FAILED: analyze exited $LASTEXITCODE"; exit 1 }

git add data
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -q -m "scheduled update $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
  git push -q
  if ($LASTEXITCODE -eq 0) { Log "pushed data update" } else { Log "FAILED: push" ; exit 1 }
} else {
  Log "no changes"
}
Log "run ok"