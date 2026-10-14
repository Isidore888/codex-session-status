$ErrorActionPreference='Stop'
$sourceProject=Split-Path -Parent $PSScriptRoot
Add-Type -LiteralPath (Join-Path $sourceProject 'scripts\watch-console.cs')
. (Join-Path $sourceProject 'scripts\build-watch-launcher.ps1')
$ProjectRoot=Join-Path $sourceProject 'runtime\verification\gui-launcher-fixture'
$RuntimeRoot=Join-Path $ProjectRoot 'runtime'
[IO.Directory]::CreateDirectory((Join-Path $ProjectRoot 'scripts')) | Out-Null
# Override review only in this isolated fixture, never in production or task management.
function Assert-StatusReview {}
@'
param([switch]$Run)
Add-Type -LiteralPath $env:STATUS_CONSOLE_FIXTURE_SOURCE
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class FixtureWindow{[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);}'
$visible=[FixtureWindow]::IsWindowVisible([FixtureWindow]::GetConsoleWindow())
$null=[SessionStatusConsole]::DetachOwnStandaloneConsole($PSCommandPath)
@{console=[SessionStatusConsole]::ConsoleProcessCount();visible=$visible;watch=[bool]$Run} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'result.json')
exit 19
'@ | Set-Content -LiteralPath (Join-Path $ProjectRoot 'scripts\watch.ps1') -Encoding ascii
[IO.Directory]::CreateDirectory($RuntimeRoot) | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceProject 'runtime\environment.json') -Destination (Join-Path $RuntimeRoot 'environment.json')
$env:STATUS_CONSOLE_FIXTURE_SOURCE=Join-Path $sourceProject 'scripts\watch-console.cs'
try {
    Build-StatusLauncher
    if(-not (Test-StatusLauncher)){throw 'gui-build-invalid'}
    $exe=Get-StatusLauncherPath
    $bytes=[IO.File]::ReadAllBytes($exe);$pe=[BitConverter]::ToInt32($bytes,60)
    if([BitConverter]::ToUInt16($bytes,$pe+24+68) -ne 2){throw 'not-windows-gui-subsystem'}
    $info=[Diagnostics.ProcessStartInfo]::new($exe)
    $info.UseShellExecute=$false;$info.CreateNoWindow=$false;$info.WindowStyle='Hidden'
    $process=[Diagnostics.Process]::Start($info)
    if(-not $process.WaitForExit(15000)){throw 'gui-fixture-timeout'}
    if($process.ExitCode -ne 19){throw 'gui-child-exit-not-propagated'}
    $result=Get-Content -LiteralPath (Join-Path $ProjectRoot 'result.json') -Raw | ConvertFrom-Json
    if($result.console -ne 0 -or $result.visible -or $result.watch -ne $true){throw 'gui-child-has-visible-console-or-wrong-arguments'}
    $rejected=[SessionStatusConsole]::RunHidden($exe,@('unexpected'),$ProjectRoot)
    if($rejected.ExitCode -ne 2){throw 'gui-unexpected-arguments-accepted'}
    $bytes[$bytes.Length-1]=$bytes[$bytes.Length-1] -bxor 1
    [IO.File]::WriteAllBytes($exe,$bytes)
    if(Test-StatusLauncher){throw 'gui-tampered-binary-accepted'}
    Build-StatusLauncher
    if(-not (Test-StatusLauncher)){throw 'gui-rebuild-invalid'}
    Write-Output 'PASS: Windows GUI subsystem; console-free PS7 child; fixed Run arguments; child exit; tamper rejection'
} finally { Remove-Item Env:\STATUS_CONSOLE_FIXTURE_SOURCE }
