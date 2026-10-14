# ASCII bootstrap for the Windows-bundled PowerShell 5.1; all app logic runs in saved PowerShell 7.
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$Watch)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$settings = Get-Content -LiteralPath (Join-Path $project 'runtime\environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $settings.powershell -PathType Leaf)) { throw 'Reconfigure the status-bar launcher: PowerShell 7 path unavailable.' }
if ($CheckOnly) {
    & $settings.powershell -NoProfile -File (Join-Path $PSScriptRoot 'launch.ps1') -CheckOnly -NoDialog
    exit $LASTEXITCODE
}
if ($Watch) {
    if (-not ('SessionStatusConsole' -as [type])) { Add-Type -LiteralPath (Join-Path $PSScriptRoot 'watch-console.cs') }
    $null=[SessionStatusConsole]::DetachOwnStandaloneConsole($PSCommandPath)
    $result=[SessionStatusConsole]::RunHidden($settings.powershell,@('-NoProfile','-File',(Join-Path $PSScriptRoot 'watch.ps1'),'-Run'),$project)
    exit $result.ExitCode
}
$quote = [char]34
$arguments = '-NoProfile -WindowStyle Hidden -File ' + $quote + (Join-Path $PSScriptRoot 'launch.ps1') + $quote
Start-Process -FilePath $settings.powershell -ArgumentList $arguments -WorkingDirectory $project -WindowStyle Hidden
