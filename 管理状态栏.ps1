[CmdletBinding(SupportsShouldProcess)]
param([ValidateSet('Install','Start','Health','Stop','Uninstall','EnableLogon','DisableLogon','Probe','Trial','ManualTrial','Hashes')][string]$Action='Health')
$ErrorActionPreference='Stop'
$settings=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime\environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $settings.powershell -PathType Leaf)) { throw 'PowerShell 7 unavailable' }
$arguments=@('-NoProfile','-File',(Join-Path $PSScriptRoot 'scripts\manage.ps1'),'-Action',$Action)
if ($WhatIfPreference) { $arguments+='-WhatIf' }
& $settings.powershell @arguments
if ($LASTEXITCODE) { throw ('Status management failed: '+$LASTEXITCODE) }
