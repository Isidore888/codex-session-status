$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\windows.ps1')
if(-not (Initialize-StatusSplashType)){throw ('splash-compile-failed: '+$Error[0])}
if(-not ('SessionStatusSplash' -as [type])){throw 'splash-type-missing'}
$splash=[SessionStatusSplash]::new()
$splash.UpdateText('isolated-check')
$splash.Dispose()
Update-StatusSplash $null 'no-window'
Stop-StatusSplash $null
Write-Output 'PASS: splash compiles on the saved runtime and cleanup tolerates an unshown or absent window; no window opened'
