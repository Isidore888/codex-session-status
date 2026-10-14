$ErrorActionPreference='Stop'
trap { Write-Output ('hidden-parent-failed: '+$_.Exception.Message); exit 1 }
$statusProject=Split-Path -Parent $PSScriptRoot
Add-Type -LiteralPath (Join-Path $statusProject 'scripts\watch-console.cs')
$settings=Get-Content -LiteralPath (Join-Path $statusProject 'runtime\environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
[void][SessionStatusConsole]::StartHidden([string]$settings.node,@('-e','setTimeout(()=>{},4000)'),$statusProject)
Write-Output 'hidden-parent-exited'
