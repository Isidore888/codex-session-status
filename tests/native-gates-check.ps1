$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\watch-common.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\source-gates.ps1')
function Assert($Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
# Verify source hash calculation remains deterministic while review/acceptance gates do not block user edits.
$hashes=Get-StatusSourceHashes | ConvertTo-Json | ConvertFrom-Json
Assert (Test-StatusSourceHashes $hashes) 'source-hash-check-failed'
Assert (Assert-StatusReview) 'review-gate-blocked'
Assert (Assert-StatusNativeAcceptance ([pscustomobject]@{Version='any-version'})) 'native-acceptance-gate-blocked'
Write-Output 'PASS: gate-free installation allows direct user customization while retaining hash diagnostics'
