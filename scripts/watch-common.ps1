$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows.ps1')
if (-not ('SessionStatusNative' -as [type])) { Add-Type -LiteralPath (Join-Path $PSScriptRoot 'watch-native.cs') }
if (-not ('SessionStatusConsole' -as [type])) { Add-Type -LiteralPath (Join-Path $PSScriptRoot 'watch-console.cs') }
$statusHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLowerInvariant()))).Substring(0,20).ToLowerInvariant()
$WatchPipe = 'codex-session-status-watch-' + $statusHash
$WatchTaskName = 'CodexSessionStatus-' + $statusHash
$WatchMutexName = 'Local\' + $WatchTaskName

function Write-WatchLog([string]$Code) {
    if ($Code -notmatch '^[a-z0-9-]{1,80}$') { $Code='unexpected-failure' }
    $file=Join-Path $RuntimeRoot 'watch.log'
    if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt 524288) { [IO.File]::WriteAllText($file,'') }
    [IO.File]::AppendAllText($file, [DateTime]::UtcNow.ToString('o')+' '+$Code+"`n")
}
function Get-WatchHealth { [SessionStatusWatchControl]::Request($WatchPipe,'health') | ConvertFrom-Json }
function Invoke-StatusNode([string[]]$NodeArguments) {
    $result=[SessionStatusConsole]::RunHidden((Resolve-Node),$NodeArguments,$ProjectRoot)
    if ($result.ExitCode -ne 0 -and ($NodeArguments.Count -lt 2 -or $NodeArguments[1] -ne '--health')) { throw 'node-helper-failed' }
    return $result.Output
}
function Test-StatusTrialRequest($Request) {
    if (-not $Request -or [string]$Request.identityKey -notmatch '^\d+:\d+$') { return $false }
    try {
        # New PowerShell versions deserialize ISO dates as DateTime; do not stringify/reparse.
        $expiry=if ($Request.expiresAt -is [DateTime]) { $Request.expiresAt.ToUniversalTime() }
            else { [DateTime]::Parse([string]$Request.expiresAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
        $now=[DateTime]::UtcNow
        return $expiry -gt $now -and $expiry -le $now.AddMinutes(6)
    } catch { return $false }
}

function Get-StatusClientProcesses($App) {
    $leaf=[IO.Path]::GetFileName($App.Exe)
    if ($leaf -notmatch '^[a-zA-Z0-9._-]+\.exe$') { throw 'invalid-client-executable' }
    # Only parse --type/parent identity. Never export command lines or message contents.
    $records=@(Get-CimInstance Win32_Process -Filter ("Name='"+$leaf+"'") -ErrorAction Stop)
    $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
    $imagePids=@($records | ForEach-Object {
        $identity=[SessionStatusNative]::ReadIdentity([uint32]$_.ProcessId)
        if ($identity -and $identity.UserSid -eq [SessionStatusNative]::CurrentUserSid -and $identity.Session -eq $session -and $identity.Path -ieq $App.Exe) { [uint32]$_.ProcessId }
    })
    foreach ($record in $records) {
        if ($record.ProcessId -notin $imagePids -or $record.ParentProcessId -in $imagePids) { continue }
        if (-not $record.CommandLine -or $record.CommandLine -match '(?i)(?:^|\s)--type(?:=|\s)') { continue }
        $identity=[SessionStatusNative]::ReadIdentity([uint32]$record.ProcessId)
        if ($identity -and $identity.UserSid -eq [SessionStatusNative]::CurrentUserSid -and $identity.Path -ieq $App.Exe -and $identity.Session -eq $session) { $identity }
    }
}
function Find-StatusOwnedCdp($Identity) {
    if (-not [SessionStatusNative]::Matches($Identity)) { return 0 }
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object OwningProcess -EQ $Identity.Pid)
    foreach ($listener in $listeners) {
        if ($listener.LocalAddress -ne '127.0.0.1') { continue }
        $port=[int]$listener.LocalPort
        if ($listeners | Where-Object { $_.LocalPort -eq $port -and $_.LocalAddress -notin @('127.0.0.1','::1') }) { continue }
        if (@(Get-CdpTargets $port).Count -and [SessionStatusNative]::Matches($Identity)) { return $port }
    }
    return 0
}
function Invoke-StatusMonitor([int]$Port,$App,$Identity) {
    $node=Resolve-Node
    $old=Invoke-StatusNode @((Join-Path $ProjectRoot 'src\monitor.mjs'),'--health') | ConvertFrom-Json
    if ($old.ok) {
        $state=Get-Content -LiteralPath (Join-Path $RuntimeRoot 'state.json') -Raw | ConvertFrom-Json
        if ($state.port -eq $Port -and $state.clientKey -eq $Identity.Key -and $state.appVersion -eq $App.Version) { return }
        Invoke-StatusNode @((Join-Path $ProjectRoot 'src\monitor.mjs'),'--stop') | Out-Null
        $until=[DateTime]::UtcNow.AddSeconds(20)
        do { Start-Sleep -Milliseconds 250; $old=Invoke-StatusNode @((Join-Path $ProjectRoot 'src\monitor.mjs'),'--health') | ConvertFrom-Json } while ($old.ok -and [DateTime]::UtcNow -lt $until)
        if ($old.ok) { throw 'monitor-stop-timeout' }
    }
    @{port=$Port; appVersion=$App.Version;clientKey=$Identity.Key} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'launch.json') -Encoding UTF8
    [void][SessionStatusConsole]::StartHidden($node,@((Join-Path $ProjectRoot 'src\monitor.mjs'),'--run'),$ProjectRoot)
}
function Start-StatusClientNormally($App) { Initialize-StatusActivation; [void][SessionStatusActivation]::Launch($App.AppId,'') }
function Start-StatusClientWithPort($App,[int]$Port) {
    if ($Port -lt 9345 -or $Port -gt 9376) { throw 'invalid-launch-port' }
    $current=Resolve-Codex
    if ($current.Exe -ine $App.Exe -or $current.Version -ne $App.Version -or $current.AppId -ne $App.AppId) { throw 'installation-changed' }
    $root=[IO.Path]::GetFullPath($current.Root).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
    $exe=[IO.Path]::GetFullPath($current.Exe)
    if (-not $exe.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'invalid-launch-executable' }
    if (@(Get-StatusClientProcesses $current).Count) { throw 'client-already-running' }
    # This is the interactive client requested by the user, not a background helper window.
    $process=Start-Process -FilePath $exe -ArgumentList @("--remote-debugging-port=$Port",'--remote-debugging-address=127.0.0.1') -WorkingDirectory (Split-Path -Parent $exe) -WindowStyle Normal -PassThru
    return [uint32]$process.Id
}
function Get-StatusLaunchDiagnostics($App,[int]$Port,$Identity) {
    $report=@{clientPresent=[bool]$Identity;requestedPort=$Port;identityVerified=$false;
      hasDebugPort=$false;hasLoopbackFlag=$false;ownedLoopbackListener=$false;unsafeListener=$false;endpointReady=$false;pageCount=0;recognizedPages=0}
    if (-not $Identity -or -not [SessionStatusNative]::Matches($Identity)) { return $report }
    $report.identityVerified=$true
    $record=Get-CimInstance Win32_Process -Filter ('ProcessId='+$Identity.Pid) -ErrorAction Stop
    # Export only booleans/counts. Never retain a command line, target URL or response body.
    $report.hasDebugPort=$record.CommandLine -match ('--remote-debugging-port(?:=|\s+)'+$Port+'(?:\s|$)')
    $report.hasLoopbackFlag=$record.CommandLine -match '--remote-debugging-address(?:=|\s+)127\.0\.0\.1(?:\s|$)'
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port -and $_.OwningProcess -eq $Identity.Pid })
    $report.ownedLoopbackListener=@($listeners | Where-Object LocalAddress -EQ '127.0.0.1').Count -gt 0
    $report.unsafeListener=@($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }).Count -gt 0
    if ($report.ownedLoopbackListener -and -not $report.unsafeListener -and [SessionStatusNative]::Matches($Identity)) {
        try {
            $targets=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$Port+'/json/list') -TimeoutSec 1 -MaximumRedirection 0
            $report.endpointReady=$true
            $report.pageCount=@($targets | Where-Object type -EQ 'page').Count
            $report.recognizedPages=@(Get-CdpTargets $Port).Count
        } catch {}
    }
    return $report
}
function Test-StatusIdentity($Identity) { [SessionStatusNative]::Matches($Identity) }
function Request-StatusNormalExit($Identity) { [SessionStatusNative]::RestartManager($Identity,$false) }
function Wait-StatusExit($Identity) {
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    while ((Test-StatusIdentity $Identity) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
    return -not (Test-StatusIdentity $Identity)
}

# Demand-only debug trial: Task Scheduler owns this process, so the user's app exit
# cannot remove the waiter. Never request shutdown or infer exit from a closed window.
function Get-StatusManualTime { [DateTime]::UtcNow }
function Invoke-StatusManualReopen($Request,$Control) {
    if (-not (Test-StatusTrialRequest $Request)) { return @{ok=$false;code='manual-request-invalid'} }
    $app=Resolve-Codex
    $clients=@(Get-StatusClientProcesses $app)
    if ($clients.Count -ne 1 -or $clients[0].Key -ne $Request.identityKey) { return @{ok=$false;code='manual-client-changed'} }
    $expiry=if ($Request.expiresAt -is [DateTime]) { $Request.expiresAt.ToUniversalTime() } else { [DateTime]::Parse([string]$Request.expiresAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
    $Control.Health=@{ok=$true;phase='waiting-for-user-exit';watcherPid=$PID;clientPid=$clients[0].Pid} | ConvertTo-Json -Compress
    do {
        if ($Control.StopRequested) { return @{ok=$false;code='manual-cancelled'} }
        if ((Get-StatusManualTime) -ge $expiry) { return @{ok=$false;code='manual-expired'} }
        Start-Sleep -Milliseconds 500
        $app=Resolve-Codex
        $clients=@(Get-StatusClientProcesses $app)
        if ($clients.Count -and ($clients.Count -ne 1 -or $clients[0].Key -ne $Request.identityKey)) { return @{ok=$false;code='manual-client-changed'} }
    } while ($clients.Count)
    if ($Control.StopRequested) { return @{ok=$false;code='manual-cancelled'} }
    if ((Get-StatusManualTime) -ge $expiry) { return @{ok=$false;code='manual-expired'} }
    try {
        $port=Find-FreePort
        if ($Control.StopRequested) { return @{ok=$false;code='manual-cancelled'} }
        if ((Get-StatusManualTime) -ge $expiry) { return @{ok=$false;code='manual-expired'} }
        $launchedPid=Start-StatusClientWithPort $app $port
    } catch {
        # The user really exited. Restore ordinary activation only if no replacement
        # client appeared; never close or reopen a client the user already launched.
        if (-not $Control.StopRequested) {
            $app=Resolve-Codex
            if (-not @(Get-StatusClientProcesses $app).Count) { Start-StatusClientNormally $app }
        }
        return @{ok=$false;code='manual-launch-failed'}
    }
    $deadline=(Get-StatusManualTime).AddSeconds(60)
    do {
        if ($Control.StopRequested) { return @{ok=$false;code='manual-cancelled'} }
        Start-Sleep -Milliseconds 500
        $clients=@(Get-StatusClientProcesses $app)
        if ($clients.Count -gt 1) { return @{ok=$false;code='manual-client-changed'} }
        $owned=if($clients.Count -eq 1){Find-StatusOwnedCdp $clients[0]}else{0}
    } while (-not $owned -and (Get-StatusManualTime) -lt $deadline)
    if ($Control.StopRequested) { return @{ok=$false;code='manual-cancelled'} }
    if (-not $owned) {
        if (-not $Control.StopRequested) {
            $app=Resolve-Codex
            if (-not @(Get-StatusClientProcesses $app).Count) { Start-StatusClientNormally $app }
        }
        return @{ok=$false;code='manual-cdp-not-ready'}
    }
    return @{ok=$true;code='manual-cdp-ready';identity=$clients[0];port=$owned;app=$app;launchedPid=$launchedPid}
}

function Get-WatchDecision($Identity,[int]$Port,[bool]$Seen,[int]$ClientCount,[double]$AgeSeconds) {
    if ($ClientCount -ne 1) { return 'ambiguous-client' }
    if ($Port -gt 0) { return 'attach' }
    if ($Seen) { return 'observe' }
    if ($AgeSeconds -lt 2) { return 'wait' }
    return 'takeover'
}

function Invoke-StatusTakeover($Identity,$App,$Control) {
    if (-not (Test-StatusIdentity $Identity)) { return @{ok=$false; code='identity-changed'} }
    # Reserve/check a port before requesting any client exit.
    $port=Find-FreePort
    $code=Request-StatusNormalExit $Identity
    Write-WatchLog $code
    if ($code -ne 'shutdown-requested' -and $code -notmatch '^rm-shutdown-') { return @{ok=$false;code=$code} }
    if (-not (Wait-StatusExit $Identity)) {
        # Reactivation restores a window if normal shutdown closed it but left the process.
        Start-StatusClientNormally $App
        return @{ok=$false; code='normal-exit-failed'}
    }
    # Identity disappearance, not an API success code, proves it exited.
    $ready=$false
    $diagnostics=$null
    $launchedPid=0
    try {
        $App=Resolve-Codex
        if ($Control.StopRequested) { return @{ok=$false; code='takeover-cancelled'} }
        $launchedPid=Start-StatusClientWithPort $App $port
        $deadline=[DateTime]::UtcNow.AddSeconds(60)
        $diagnoseAt=[DateTime]::UtcNow.AddSeconds(5)
        do {
            Start-Sleep -Milliseconds 500
            $clients=@(Get-StatusClientProcesses $App)
            if ($clients.Count -gt 1) { return @{ok=$false;code='ambiguous-client'} }
            foreach ($client in $clients) {
                $owned=Find-StatusOwnedCdp $client
                if ($owned -eq $port) {
                    $diagnostics=Get-StatusLaunchDiagnostics $App $port $client
                    $ready=$true; return @{ok=$true; code='takeover-ready'; port=$port; identity=$client; app=$App;diagnostics=$diagnostics;launchedPid=$launchedPid}
                }
            }
            if ([DateTime]::UtcNow -ge $diagnoseAt -and -not $diagnostics) {
                $candidate=if($clients.Count -eq 1){$clients[0]}else{$null}
                $diagnostics=Get-StatusLaunchDiagnostics $App $port $candidate
            }
        } while (-not $Control.StopRequested -and [DateTime]::UtcNow -lt $deadline)
        return @{ok=$false; code='cdp-connection-failed';diagnostics=$diagnostics;launchedPid=$launchedPid}
    } catch { return @{ok=$false;code='exe-launch-failed';diagnostics=$diagnostics;launchedPid=$launchedPid} }
    finally {
        # Restore ordinary activation on every failure after exit, including discovery errors.
        if (-not $ready) { Start-StatusClientNormally $App }
    }
}
