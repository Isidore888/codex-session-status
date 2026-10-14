$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\watch-common.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\source-gates.ps1')
function Assert($Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
$request=[pscustomobject]@{identityKey='123:134361439404200569';expiresAt=[DateTime]::UtcNow.AddMinutes(5).ToString('o')}
Assert (Test-StatusTrialRequest $request) 'valid-ISO-trial-expired'
$parsed=$request | ConvertTo-Json | ConvertFrom-Json
Assert (Test-StatusTrialRequest $parsed) 'deserialized-UTC-trial-expired'
$request.expiresAt=[DateTime]::UtcNow.AddSeconds(-1)
Assert (-not (Test-StatusTrialRequest $request)) 'expired-trial-accepted'
$request.expiresAt='invalid'
Assert (-not (Test-StatusTrialRequest $request)) 'invalid-trial-accepted'
# Real identity check is read-only and targets this test process, never the client.
$identity=[SessionStatusNative]::ReadIdentity([uint32]$PID)
Assert ([SessionStatusNative]::Matches($identity)) 'self-identity-failed'
Assert ($identity.UserSid -eq [SessionStatusNative]::CurrentUserSid) 'self-user-unverified'
$identity.UserSid='S-1-5-18'
Assert (-not [SessionStatusNative]::Matches($identity)) 'different-user-not-rejected'
$identity.UserSid=[SessionStatusNative]::CurrentUserSid
$identity.StartTicks++
Assert (-not [SessionStatusNative]::Matches($identity)) 'PID-reuse-not-rejected'
$fake=[pscustomobject]@{Pid=1;Key='fixture';StartTicks=1}
Assert ((Get-WatchDecision $fake 0 $true 1 10) -eq 'observe') 'baseline-reopened'
Assert ((Get-WatchDecision $fake 0 $false 1 1) -eq 'wait') 'grace-missing'
Assert ((Get-WatchDecision $fake 9345 $true 1 10) -eq 'attach') 'existing-CDP-not-reused'
Assert ((Get-WatchDecision $fake 0 $false 2 10) -eq 'ambiguous-client') 'ambiguous-takeover'
Assert ((Get-WatchDecision $fake 0 $false 1 10) -eq 'takeover') 'new-root-not-handled'
# Execute the actual watcher wait with a virtual sleep; no client or elapsed delay.
$watchSource=Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\watch.ps1'
$watchAst=[Management.Automation.Language.Parser]::ParseFile($watchSource,[ref]$null,[ref]$null)
$waitAssignment=$watchAst.Find({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$waitTicks'},$true)
$waitLoop=$watchAst.Find({param($node) $node -is [Management.Automation.Language.ForStatementAst] -and $node.Body.Extent.Text -match 'Start-Sleep -Milliseconds 250'},$true)
Assert ($null -ne $waitLoop) 'watch-wait-not-found'
$script:waitCalls=0;$script:stopAfter=0
function Start-Sleep { param($Milliseconds) Assert ($Milliseconds -eq 250) 'uninterruptible-wait';$script:waitCalls++;if($script:stopAfter -and $script:waitCalls -eq $script:stopAfter){$control.StopRequested=$true} }
try {
    foreach($case in @(@('idle',40),@('cdp-attached',8),@('existing-client-observed',8),@('watch-operation-unavailable',8))) {
        $code=$case[0];$control=[pscustomobject]@{StopRequested=$false};$script:waitCalls=0
        if($waitAssignment){. ([scriptblock]::Create($waitAssignment.Extent.Text))}
        . ([scriptblock]::Create($waitLoop.Extent.Text))
        Assert ($script:waitCalls -eq $case[1]) ('wrong-wait-'+$code)
    }
    $code='idle';$control=[pscustomobject]@{StopRequested=$false};$script:waitCalls=0;$script:stopAfter=4
    if($waitAssignment){. ([scriptblock]::Create($waitAssignment.Extent.Text))}
    . ([scriptblock]::Create($waitLoop.Extent.Text))
    Assert ($script:waitCalls -eq 4) 'idle-stop-delayed'
} finally { Remove-Item Function:\Start-Sleep }
# Actual launcher body with only process creation/health substituted and isolated files.
Add-Type 'public static class FixtureStatusConsole { public static int Starts; public static int StartHidden(string exe,string[] args,string cwd){Starts++;return 1;} }'
function Resolve-FixtureNode { 'fixture-node' }
function Invoke-FixtureNode { param($NodeArguments) if($script:fixtureMonitorLive){'{"ok":true}'}else{'{"ok":false}'} }
$monitorBody=(Get-Item Function:\Invoke-StatusMonitor).Definition.Replace('Resolve-Node','Resolve-FixtureNode').Replace('Invoke-StatusNode','Invoke-FixtureNode').Replace('[SessionStatusConsole]::StartHidden','[FixtureStatusConsole]::StartHidden')
$monitorFixture=[scriptblock]::Create($monitorBody)
$savedRuntime=$RuntimeRoot
$RuntimeRoot=Join-Path $ProjectRoot ('runtime\unit\ui-recovery-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $RuntimeRoot | Out-Null
try {
    $state=[pscustomobject]@{port=9345;clientKey='A';appVersion='1';exitReason='client-incompatible'}
    $state | ConvertTo-Json | Set-Content (Join-Path $RuntimeRoot 'state.json')
    $script:fixtureMonitorLive=$false
    & $monitorFixture 9345 ([pscustomobject]@{Version='1'}) ([pscustomobject]@{Key='A'})
    Assert ([FixtureStatusConsole]::Starts -eq 1) 'legacy-ui-failure-blocks-recovery'
    $launch=Get-Content (Join-Path $RuntimeRoot 'launch.json') -Raw | ConvertFrom-Json
    Assert ($launch.clientKey -eq 'A' -and $launch.port -eq 9345 -and $launch.appVersion -eq '1') 'recovery-launch-identity-changed'
    $script:fixtureMonitorLive=$true
    & $monitorFixture 9345 ([pscustomobject]@{Version='1'}) ([pscustomobject]@{Key='A'})
    Assert ([FixtureStatusConsole]::Starts -eq 1) 'live-monitor-duplicated'
} finally {
    foreach($name in @('state.json','launch.json')) { $file=Join-Path $RuntimeRoot $name;if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file} }
    Remove-Item -LiteralPath $RuntimeRoot
    $RuntimeRoot=$savedRuntime
}
# Own, random, current-user pipe: singleton control and bounded protocol.
$pipe='codex-status-test-'+[Guid]::NewGuid().ToString('N')
$control=[SessionStatusWatchControl]::new($pipe)
try {
    $control.Health='{"ok":true,"phase":"fixture"}'
    $result=[SessionStatusWatchControl]::Request($pipe,'health') | ConvertFrom-Json
    Assert ($result.phase -eq 'fixture') 'health-failed'
    $result=[SessionStatusWatchControl]::Request($pipe,'arbitrary-command') | ConvertFrom-Json
    Assert (-not $result.ok) 'unapproved-command'
    $null=[SessionStatusWatchControl]::Request($pipe,'stop')
    Assert $control.StopRequested 'stop-failed'
} finally { $control.Dispose() }
# All restart effects below are substitutes; no native shutdown/activation is called.
$script:normal=0; $script:debug=0; $script:exitCalls=0
$script:rmCode='rm-impact-rejected'; $script:exitSucceeded=$true; $script:portFailure=$false; $script:discoveryFailure=$false
function Test-StatusIdentity { param($Identity) $true }
function Find-FreePort { if ($script:portFailure) { throw 'fixture-port-occupied' }; 9345 }
function Request-StatusNormalExit { param($Identity) $script:exitCalls++; $script:rmCode }
function Wait-StatusExit { param($Identity) $script:exitSucceeded }
function Write-WatchLog { param($Code) }
function Start-StatusClientNormally { param($App) $script:normal++ }
function Resolve-Codex { [pscustomobject]@{Version='fixture';Exe='fixture.exe'} }
function Start-StatusClientWithPort { param($App,$Port) $script:debug++; 1 }
function Get-StatusLaunchDiagnostics { param($App,$Port,$Identity) @{identityVerified=$true} }
function Get-StatusClientProcesses { param($App) if($script:discoveryFailure){throw 'fixture-discovery'}; $fake }
function Find-StatusOwnedCdp { param($Identity) 9345 }
$app=Resolve-Codex; $flag=[pscustomobject]@{StopRequested=$false}
$result=Invoke-StatusTakeover $fake $app $flag
Assert ($result.code -eq 'rm-impact-rejected' -and $script:debug -eq 0 -and $script:normal -eq 0) 'foreign-impact-not-stopped'
$script:portFailure=$true
try { Invoke-StatusTakeover $fake $app $flag | Out-Null; throw 'occupied-port-not-rejected' } catch { Assert ($_.Exception.Message -eq 'fixture-port-occupied') 'occupied-port-not-rejected' }
Assert ($script:exitCalls -eq 1) 'exit-before-port-check'
$script:portFailure=$false; $script:rmCode='rm-shutdown-351'; $script:exitSucceeded=$false
$result=Invoke-StatusTakeover $fake $app $flag
Assert ($result.code -eq 'normal-exit-failed' -and $script:normal -eq 1 -and $script:debug -eq 0) 'failed-quit-not-restored'
$script:exitSucceeded=$true; $script:rmCode='shutdown-requested'; $script:discoveryFailure=$true
$result=Invoke-StatusTakeover $fake $app $flag
Assert ($result.code -eq 'exe-launch-failed' -and $script:normal -eq 2) 'discovery-error-not-restored'
$script:discoveryFailure=$false
$result=Invoke-StatusTakeover $fake $app $flag
Assert ($result.ok -and $script:normal -eq 2) 'successful-attach-failed'
$flag.StopRequested=$true
$result=Invoke-StatusTakeover $fake $app $flag
Assert ($result.code -eq 'takeover-cancelled' -and $script:normal -eq 3) 'cancel-not-restored'
$hashes=Get-StatusSourceHashes | ConvertTo-Json | ConvertFrom-Json
Assert (Test-StatusSourceHashes $hashes) 'matching-source-hashes-rejected'
$first=@($hashes.PSObject.Properties)[0].Name
$hashes.$first='stale'
Assert (-not (Test-StatusSourceHashes $hashes)) 'stale-review-accepted'
Write-Output 'PASS: watcher policy, PID reuse, own pipe, port failure, exit refusal, restoration, cancellation, hash gates'
