[CmdletBinding(SupportsShouldProcess)]
param([ValidateSet('Setup','Install','Start','Health','Stop','Uninstall','EnableLogon','DisableLogon','Probe','Trial','ManualTrial','Hashes')][string]$Action='Setup')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'scripts\windows.ps1')
$envFile=Join-Path $PSScriptRoot 'runtime\environment.json'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    $null=Ensure-StatusEnvironment
}
$settings=Get-Content -LiteralPath $envFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $settings.powershell -PathType Leaf)) {
    $settings=Ensure-StatusEnvironment
}
$arguments=@('-NoProfile','-File',(Join-Path $PSScriptRoot 'scripts\manage.ps1'),'-Action',$Action)
if ($WhatIfPreference) { $arguments+='-WhatIf' }
& $settings.powershell @arguments
if ($LASTEXITCODE) { throw ('Status management failed: '+$LASTEXITCODE) }
