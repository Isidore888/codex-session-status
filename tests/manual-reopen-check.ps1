$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/watch-common.ps1')
function Assert($v,$message){if(-not $v){throw $message}}
$script:starts=0; $script:restores=0; $script:exitCalls=0; $script:launchFails=$false
$script:manualNow=[DateTime]::UtcNow; $script:step=0; $script:cdpReady=$true
$script:portCancels=$false; $script:cdpCancels=$false
function Get-StatusManualTime { $script:manualNow }
$initial=[pscustomobject]@{Pid=123;Key='123:456'}
$new=[pscustomobject]@{Pid=124;Key='124:457'}
$script:clients=[Collections.Generic.Queue[object]]::new()
function Queue-Clients($items){$script:clients.Clear();foreach($item in $items){$script:clients.Enqueue($item)}}
function Resolve-Codex { [pscustomobject]@{Version='fixture';Exe='fixture.exe'} }
function Get-StatusClientProcesses {param($App) if($script:clients.Count){$next=$script:clients.Dequeue();if($null -ne $next){$next}}else{$new}}
function Start-Sleep {param($Milliseconds) $script:manualNow=$script:manualNow.AddSeconds($script:step)}
function Request-StatusNormalExit {param($Identity) $script:exitCalls++;throw 'native-shutdown-forbidden'}
function Find-FreePort {if($script:portCancels){$control.StopRequested=$true};9345}
function Start-StatusClientWithPort {param($App,$Port) $script:starts++;if($script:launchFails){throw 'fixture-launch-failed'};124}
function Start-StatusClientNormally {param($App) $script:restores++}
function Find-StatusOwnedCdp {param($Identity) if($script:cdpCancels){$control.StopRequested=$true};if($script:cdpReady){9345}else{0}}
$control=[pscustomobject]@{StopRequested=$false;Health=''}
$request=[pscustomobject]@{identityKey='123:456';expiresAt=[DateTime]::UtcNow.AddMinutes(5)}
Queue-Clients @($initial,$initial,$null,$new)
$result=Invoke-StatusManualReopen $request $control
Assert ($result.ok -and $script:starts -eq 1 -and $script:exitCalls -eq 0) 'manual-wait-did-not-launch-once-without-quit'
Assert (($control.Health | ConvertFrom-Json).phase -eq 'waiting-for-user-exit') 'manual-wait-state-missing'
Queue-Clients @($initial,[pscustomobject]@{Pid=123;Key='123:999'})
$result=Invoke-StatusManualReopen $request $control
Assert ($result.code -eq 'manual-client-changed' -and $script:starts -eq 1) 'PID-reuse-reopened'
$control.StopRequested=$true
Queue-Clients @($initial)
$result=Invoke-StatusManualReopen $request $control
Assert ($result.code -eq 'manual-cancelled' -and $script:starts -eq 1) 'cancel-reopened'
$control.StopRequested=$false
$request.expiresAt=[DateTime]::UtcNow.AddSeconds(-1)
$result=Invoke-StatusManualReopen $request $control
Assert ($result.code -eq 'manual-request-invalid' -and $script:starts -eq 1) 'expired-request-reopened'
$request.expiresAt=[DateTime]::UtcNow.AddMinutes(5)
$script:launchFails=$true
Queue-Clients @($initial,$null,$null)
$result=Invoke-StatusManualReopen $request $control
Assert ($result.code -eq 'manual-launch-failed' -and $script:restores -eq 1 -and $script:exitCalls -eq 0) 'manual-launch-failure-not-restored'
Queue-Clients @($initial,$null,$new)
$result=Invoke-StatusManualReopen $request $control
Assert ($result.code -eq 'manual-launch-failed' -and $script:restores -eq 1) 'replacement-client-was-reactivated'
$script:launchFails=$false
$before=$script:starts
$script:manualNow=[DateTime]::UtcNow; $script:step=301
Queue-Clients @($initial,$null)
$result=Invoke-StatusManualReopen $request $control
Assert ($result.code -eq 'manual-expired' -and $script:starts -eq $before) 'expired-during-wait-reopened'
$script:manualNow=[DateTime]::UtcNow; $script:step=61; $script:cdpReady=$false
Queue-Clients @($initial,$null,$null,$null)
$result=Invoke-StatusManualReopen $request $control
Assert ($result.code -eq 'manual-cdp-not-ready' -and $script:restores -eq 2) 'post-launch-client-exit-not-restored'
$script:manualNow=[DateTime]::UtcNow
Queue-Clients @($initial,$null,$new,$new)
$result=Invoke-StatusManualReopen $request $control
Assert ($result.code -eq 'manual-cdp-not-ready' -and $script:restores -eq 2) 'CDP-failure-reactivated-existing-client'
$script:manualNow=[DateTime]::UtcNow; $script:step=0; $script:cdpReady=$true
$before=$script:starts; $script:portCancels=$true
Queue-Clients @($initial,$null)
$result=Invoke-StatusManualReopen $request $control
Assert ($result.code -eq 'manual-cancelled' -and $script:starts -eq $before) 'cancel-during-port-check-reopened'
$control.StopRequested=$false; $script:portCancels=$false; $script:cdpCancels=$true
Queue-Clients @($initial,$null,$new)
$result=Invoke-StatusManualReopen $request $control
Assert ($result.code -eq 'manual-cancelled' -and $script:starts -eq ($before+1)) 'cancel-during-CDP-check-returned-ready'
Write-Output 'PASS: isolated manual exit/reopen policy (no native shutdown)'
