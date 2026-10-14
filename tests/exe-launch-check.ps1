$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\watch-common.ps1')
function Assert($Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
$script:current=[pscustomobject]@{Root=(Join-Path $RuntimeRoot 'mock package');Exe=(Join-Path $RuntimeRoot 'mock package\app\ChatGPT.exe');Version='1';AppId='OpenAI.Codex_fixture!App'}
$script:running=@();$script:launchCount=0;$script:arguments=@();$script:launchedPath='';$script:fileAvailable=$true
function Resolve-Codex { $script:current }
function Get-StatusClientProcesses { param($App) $script:running }
function Test-Path { param($LiteralPath,$PathType) $script:fileAvailable -and $LiteralPath -eq $script:current.Exe }
function Start-Process {
    param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru)
    Assert $PassThru 'launch-PID-missing'
    Assert ($WindowStyle -eq 'Normal') 'native-client-hidden'
    Assert ($WorkingDirectory -eq (Split-Path -Parent $FilePath)) 'wrong-working-directory'
    $script:launchCount++;$script:arguments=@($ArgumentList);$script:launchedPath=$FilePath
    [pscustomobject]@{Id=64100}
}
$app=$script:current.PSObject.Copy()
Assert ((Start-StatusClientWithPort $app 9345) -eq 64100) 'wrong-launch-PID'
Assert ($script:arguments.Count -eq 2 -and $script:arguments[0] -eq '--remote-debugging-port=9345' -and $script:arguments[1] -eq '--remote-debugging-address=127.0.0.1') 'wrong-debug-arguments'
Assert ($script:launchedPath -eq $app.Exe) 'wrong-executable'
function Reject([scriptblock]$Call,[string]$Code) {
    try { & $Call | Out-Null } catch { Assert ($_.Exception.Message -eq $Code) ('wrong-failure-'+$Code);return }
    throw ('accepted-'+$Code)
}
Reject {Start-StatusClientWithPort $app 0} 'invalid-launch-port'
$script:running=@([pscustomobject]@{Pid=1})
Reject {Start-StatusClientWithPort $app 9345} 'client-already-running'
$script:running=@();$script:current.Version='2'
Reject {Start-StatusClientWithPort $app 9345} 'installation-changed'
$script:current.Version='1';$script:fileAvailable=$false
Reject {Start-StatusClientWithPort $app 9345} 'invalid-launch-executable'
$script:fileAvailable=$true;$script:current.Exe=Join-Path $RuntimeRoot 'mock package-other\ChatGPT.exe'
$app=$script:current.PSObject.Copy()
Reject {Start-StatusClientWithPort $app 9345} 'invalid-launch-executable'
Assert ($script:launchCount -eq 1) 'failed-guard-launched-process'
Write-Output 'PASS: installed EXE launch args/PID, invalid ports, live-client race, changed install, missing/outside executable'
