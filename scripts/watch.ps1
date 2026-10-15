[CmdletBinding()]
param([switch]$Run)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'watch-common.ps1')
if (-not $Run) { throw 'Use manage.ps1 to install, inspect or stop the watcher.' }
if (-not ('SessionStatusConsole' -as [type])) { Add-Type -LiteralPath (Join-Path $PSScriptRoot 'watch-console.cs') }
$null=[SessionStatusConsole]::DetachOwnStandaloneConsole($PSCommandPath)
[IO.Directory]::CreateDirectory($RuntimeRoot) | Out-Null
$mutex=[Threading.Mutex]::new($false,$WatchMutexName)
$locked=$false
$control=$null
try {
    try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
    if (-not $locked) { exit 0 }
    $control=[SessionStatusWatchControl]::new($WatchPipe)
    $seen=[Collections.Generic.HashSet[string]]::new()
    $held=$false
    $manualDebug=$false
    $lastCode=''
    $activePort=0
    $trial=$null
    $trialFile=Join-Path $RuntimeRoot 'trial-request.json'
    if (Test-Path -LiteralPath $trialFile) {
        $trial=Get-Content -LiteralPath $trialFile -Raw | ConvertFrom-Json
        Remove-Item -LiteralPath $trialFile
        # Trial authority expires; never reuse an old target after a reboot or PID reuse.
        if (-not (Test-StatusTrialRequest $trial)) { $trial=$null }
    }
    $app=Resolve-Codex
    $appResolvedAt=[DateTime]::UtcNow
    foreach ($client in @(Get-StatusClientProcesses $app)) { [void]$seen.Add($client.Key) }
    if ($trial) { [void]$seen.Remove([string]$trial.identityKey) }
    Write-WatchLog 'watch-started'
    $manualFile=Join-Path $RuntimeRoot 'manual-reopen-request.json'
    if (Test-Path -LiteralPath $manualFile) {
        # A manual debug run remains observe-only after this single relaunch.
        $held=$true; $manualDebug=$true; $trial=$null
        $manual=Get-Content -LiteralPath $manualFile -Raw | ConvertFrom-Json
        Remove-Item -LiteralPath $manualFile
        . (Join-Path $PSScriptRoot 'source-gates.ps1')
        Assert-StatusReview
        try {
            $result=Invoke-StatusManualReopen $manual $control
            if ($result.ok) {
                Assert-StatusReview
                if ($control.StopRequested) { $result=@{ok=$false;code='manual-cancelled'} }
                else {
                    Invoke-StatusMonitor $result.port $result.app $result.identity
                    $activePort=$result.port; [void]$seen.Add($result.identity.Key)
                }
            }
            @{stage=if($result.ok){'ready'}else{'failed'};code=$result.code;
              port=$activePort;clientKey=if($result.ok){$result.identity.Key}else{$null};
              appVersion=if($result.ok){$result.app.Version}else{$null};launchMethod='installed-exe';
              at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'verification/manual-reopen.json') -Encoding utf8
        } catch {
            @{stage='failed';code='manual-operation-unavailable';at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'verification/manual-reopen.json') -Encoding utf8
            Write-WatchLog 'manual-operation-unavailable'
        }
    }
    while (-not $control.StopRequested) {
        $phase='watching'; $code='idle'; $clientPid=0
        try {
            if (-not $app -or ([DateTime]::UtcNow-$appResolvedAt).TotalSeconds -ge 15 -or -not (Test-Path -LiteralPath $app.Exe -PathType Leaf)) {
                $app=Resolve-Codex
                $appResolvedAt=[DateTime]::UtcNow
            }
            $clients=@(Get-StatusClientProcesses $app)
            if (-not $clients.Count) {
                $seen.Clear(); $held=$false
                if ($activePort) { Invoke-StatusNode @((Join-Path $ProjectRoot 'src\monitor.mjs'),'--stop') | Out-Null; $activePort=0 }
            } elseif ($clients.Count -ne 1) { $code='ambiguous-client' }
            else {
                $client=$clients[0]; $clientPid=$client.Pid
                $port=Find-StatusOwnedCdp $client
                $age=([DateTime]::UtcNow-[DateTime]::FromFileTimeUtc($client.StartTicks)).TotalSeconds
                $decision=Get-WatchDecision $client $port ($manualDebug -or $held -or $seen.Contains($client.Key)) $clients.Count $age
                if ($decision -eq 'attach') {
                    Invoke-StatusMonitor $port $app $client; $activePort=$port; [void]$seen.Add($client.Key); $phase='attached'; $code='cdp-attached'
                } elseif ($decision -eq 'takeover') {
                    [void]$seen.Add($client.Key)
                    $control.Health=@{ok=$true;phase='reopening';watcherPid=$PID;clientPid=$clientPid} | ConvertTo-Json -Compress
                    $result=Invoke-StatusTakeover $client $app $control
                    $code=$result.code
                    if ($result.ok) {
                        [void]$seen.Add($result.identity.Key)
                        Invoke-StatusMonitor $result.port $result.app $result.identity; $activePort=$result.port; $phase='attached'
                    } else { $held=$true; $phase='failed' }
                    if ($trial) {
                        [IO.Directory]::CreateDirectory((Join-Path $RuntimeRoot 'verification')) | Out-Null
                        @{checkedAt=[DateTime]::UtcNow.ToString('o'); normalExitPassed=(-not [SessionStatusNative]::Matches($client));
                          launchMethod='installed-exe';cdpPassed=[bool]$result.ok; code=$code; clientVersion=$app.Version; initialIdentity=$client.Key;
                          port=$activePort;diagnostics=$result.diagnostics;launchedPid=$result.launchedPid} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'verification\native-startup-exe.json') -Encoding UTF8
                        $trial=$null
                        if ($result.ok) {
                            $node=Resolve-Node
                            [void][SessionStatusConsole]::StartHidden($node,@((Join-Path $PSScriptRoot 'verify-client.mjs')),$ProjectRoot)
                        }
                    }
                } elseif ($decision -eq 'observe') { $code='existing-client-observed' }
                else { $code='startup-grace' }
            }
        } catch {
            $phase='failed'; $code='watch-operation-unavailable'; $held=$true
        }
        $control.Health=@{ok=$true;phase=$phase;code=$code;watcherPid=$PID;clientPid=$clientPid;port=$activePort} | ConvertTo-Json -Compress
        if ($code -ne $lastCode) {
            Write-WatchLog $code; $lastCode=$code
            [IO.File]::WriteAllText((Join-Path $RuntimeRoot 'watch-state.json'),$control.Health)
        }
        $waitTicks=if($code -eq 'idle'){2}else{4}
        for ($i=0;$i -lt $waitTicks -and -not $control.StopRequested;$i++) { Start-Sleep -Milliseconds 250 }
    }
} finally {
    if ($locked) {
        try { Invoke-StatusNode @((Join-Path $ProjectRoot 'src\monitor.mjs'),'--stop') | Out-Null } catch {}
        if ($control) { $control.Dispose() }
        Write-WatchLog 'watch-stopped'
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
