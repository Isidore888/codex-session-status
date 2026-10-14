$ErrorActionPreference='Stop'
$statusProject=Split-Path -Parent $PSScriptRoot
$statusSettings=Get-Content -LiteralPath (Join-Path $statusProject 'runtime\environment.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$statusNode=[string]$statusSettings.node
if(-not (Test-Path -LiteralPath $statusNode -PathType Leaf)){throw 'configured-node-unavailable'}
Add-Type -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\watch-console.cs')
if([SessionStatusConsole]::DetachOwnStandaloneConsole('C:\unrelated\not-this-script.ps1')) { throw 'non-owned-script-detached' }
if(-not [SessionStatusConsole]::DetachOwnStandaloneConsole($PSCommandPath)) { throw 'dedicated-test-process-detach-failed' }
if([SessionStatusConsole]::ConsoleProcessCount() -ne 0) { throw 'console-remains-after-detach' }
$result=[SessionStatusConsole]::RunHidden($statusNode,@('-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','space argument','quote"argument','trailing\'),$statusProject)
if($result.ExitCode -ne 0) { throw 'hidden-helper-failed' }
$arguments=$result.Output | ConvertFrom-Json
if($arguments.Count -ne 3 -or $arguments[0] -ne 'space argument' -or $arguments[1] -ne 'quote"argument' -or $arguments[2] -ne 'trailing\') { throw 'hidden-argument-roundtrip-failed' }
if([SessionStatusConsole]::ConsoleProcessCount() -ne 0) { throw 'helper-reattached-console' }
$statusClock=[Diagnostics.Stopwatch]::StartNew()
$statusShell=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$result=[SessionStatusConsole]::RunHidden($statusShell,@('-NoProfile','-ExecutionPolicy','RemoteSigned','-File',(Join-Path $PSScriptRoot 'hidden-parent-fixture.ps1')),$statusProject)
$statusClock.Stop()
Write-Output ('hidden-parent-fixture: exit='+$result.ExitCode+' elapsedMs='+$statusClock.ElapsedMilliseconds+' output='+$result.Output.Trim())
if($result.ExitCode -ne 0 -or $result.Output.Trim() -ne 'hidden-parent-exited'){throw 'hidden-parent-output-failed'}
if($statusClock.ElapsedMilliseconds -ge 3000){throw 'background-child-inherited-parent-output-pipe'}
Write-Output 'PASS: detach only own standalone helper process; other script paths rejected'
