[CmdletBinding(SupportsShouldProcess)]
param([ValidateSet('Install','Start','Health','Stop','Uninstall','EnableLogon','DisableLogon','Probe','Trial','ManualTrial','Hashes')][string]$Action='Health')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'watch-common.ps1')
. (Join-Path $PSScriptRoot 'source-gates.ps1')
. (Join-Path $PSScriptRoot 'build-watch-launcher.ps1')
$guiLauncher=Get-StatusLauncherPath
$bootstrap=Join-Path $PSScriptRoot 'bootstrap.ps1'
$shell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArguments='-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "'+$bootstrap+'" -Watch'
$description='codex-session-status|'+$statusHash+'|'+$ProjectRoot
$userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Get-OwnedStatusTask {
    $task=Get-ScheduledTask -TaskPath '\' -TaskName $WatchTaskName -ErrorAction SilentlyContinue
    if (-not $task) { return $null }
    $actions=@($task.Actions)
    $principal=$task.Principal.UserId
    try { if ($principal -notmatch '^S-1-') { $principal=([Security.Principal.NTAccount]::new($principal)).Translate([Security.Principal.SecurityIdentifier]).Value } } catch { throw 'task-ownership-unverified' }
    $ownedAction=$actions.Count -eq 1 -and (($actions[0].Execute -ieq $shell -and $actions[0].Arguments -eq $taskArguments) -or ($actions[0].Execute -ieq $guiLauncher -and [string]::IsNullOrEmpty($actions[0].Arguments)))
    if ($task.Description -ne $description -or -not $ownedAction -or $actions[0].WorkingDirectory -ine $ProjectRoot -or $principal -ne $userSid -or $task.Principal.RunLevel -ne 'Limited' -or $task.Principal.LogonType -ne 'Interactive' -or $task.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'task-ownership-unverified' }
    $triggers=@($task.Triggers | Where-Object { $null -ne $_ })
    if ($triggers.Count -gt 1) { throw 'task-ownership-unverified' }
    if ($triggers.Count -eq 1) {
        $triggerSid=$triggers[0].UserId
        # Task Scheduler may return an account name even when registered with a SID.
        try { if ($triggerSid -notmatch '^S-1-') { $triggerSid=([Security.Principal.NTAccount]::new($triggerSid)).Translate([Security.Principal.SecurityIdentifier]).Value } } catch { throw 'task-ownership-unverified' }
        if ($triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or $triggerSid -ne $userSid) { throw 'task-ownership-unverified' }
    }
    return $task
}
function Stop-StatusWatch {
    $response=[SessionStatusWatchControl]::Request($WatchPipe,'stop') | ConvertFrom-Json
    Invoke-StatusNode @((Join-Path $ProjectRoot 'src\monitor.mjs'),'--stop') | Out-Null
    $deadline=[DateTime]::UtcNow.AddSeconds(210)
    do { $health=Get-WatchHealth; if (-not $health.ok) { break }; Start-Sleep -Milliseconds 500 } while ([DateTime]::UtcNow -lt $deadline)
    if ($health.ok) { throw 'watch-stop-timeout' }
    # The live task handle must be terminal too; missing pipe alone is not proof of exit.
    $task=Get-OwnedStatusTask
    if ($task -and $task.State -eq 'Running') {
        $deadline=[DateTime]::UtcNow.AddSeconds(10)
        do { Start-Sleep -Milliseconds 250; $task=Get-OwnedStatusTask } while ($task.State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
        if ($task.State -eq 'Running') { throw 'task-still-running' }
    }
    return @{ok=$true;stopped=$true}
}

switch ($Action) {
    'Start' {
        Assert-StatusReview
        $task=Get-OwnedStatusTask
        if (-not $task) { throw 'owned-task-missing' }
        if ($task.Actions[0].Execute -ieq $guiLauncher -and -not (Test-StatusLauncher)) { throw 'launcher-build-unverified' }
        if ((Test-Path -LiteralPath (Join-Path $RuntimeRoot 'trial-request.json')) -or (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'manual-reopen-request.json'))) { throw 'pending-debug-request' }
        if ($task.State -eq 'Running' -and (Get-WatchHealth).ok) { @{ok=$true;alreadyRunning=$true} | ConvertTo-Json; break }
        if ($PSCmdlet.ShouldProcess($WatchTaskName,'Start existing owned watcher without a client restart request')) {
            Start-ScheduledTask -TaskPath '\' -TaskName $WatchTaskName
            @{ok=$true;started=$true} | ConvertTo-Json
        }
        break
    }
    'Hashes' { Get-StatusSourceHashes | ConvertTo-Json -Depth 3; break }
    'Health' {
        $health=Get-WatchHealth
        $task=Get-OwnedStatusTask
        @{watcher=$health;taskExists=[bool]$task;taskState=if($task){[string]$task.State}else{'absent'};
          logonEnabled=if($task){@($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }).Count -gt 0}else{$false}} | ConvertTo-Json -Depth 4
        break
    }
    'Probe' {
        $app=Resolve-Codex
        $clients=@(Get-StatusClientProcesses $app)
        $report=@{checkedAt=[DateTime]::UtcNow.ToString('o');clientVersion=$app.Version;clientCount=$clients.Count;results=@()}
        foreach ($client in $clients) { $report.results+=@{pid=$client.Pid;identityKey=$client.Key;code=[SessionStatusNative]::RestartManager($client,$true);cdpPort=(Find-StatusOwnedCdp $client)} }
        [IO.Directory]::CreateDirectory((Join-Path $RuntimeRoot 'verification')) | Out-Null
        $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'verification\startup-probe.json') -Encoding UTF8
        $report | ConvertTo-Json -Depth 4
        break
    }
    'Install' {
        Assert-StatusReview
        $app=Resolve-Codex; $null=Resolve-Node
        $settings=Get-Content -LiteralPath (Join-Path $RuntimeRoot 'environment.json') -Raw | ConvertFrom-Json
        if (-not (Test-Path -LiteralPath $settings.powershell -PathType Leaf)) { throw 'powershell-runtime-unavailable' }
        $existing=Get-OwnedStatusTask
        if ($existing -and ($existing.State -eq 'Running' -or (Get-WatchHealth).ok)) { throw 'stop-watcher-before-install' }
        if (-not $PSCmdlet.ShouldProcess($WatchTaskName,'Register current-user demand-only status watcher')) { break }
        Build-StatusLauncher
        $taskAction=New-ScheduledTaskAction -Execute $guiLauncher -WorkingDirectory $ProjectRoot
        if ($existing) {
            Set-ScheduledTask -TaskPath '\' -TaskName $WatchTaskName -Action $taskAction | Out-Null
            if (-not (Get-OwnedStatusTask)) { throw 'task-registration-unverified' }
            @{ok=$true;task=$WatchTaskName;reused=$true;consoleFree=$true} | ConvertTo-Json; break
        }
        $principal=New-ScheduledTaskPrincipal -UserId $userSid -LogonType Interactive -RunLevel Limited
        $taskSettings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $definition=New-ScheduledTask -Action $taskAction -Principal $principal -Settings $taskSettings -Description $description
        Register-ScheduledTask -TaskPath '\' -TaskName $WatchTaskName -InputObject $definition | Out-Null
        if (-not (Get-OwnedStatusTask)) { throw 'task-registration-unverified' }
        @{ok=$true;task=$WatchTaskName;logonEnabled=$false} | ConvertTo-Json
        break
    }
    'ManualTrial' {
        Assert-StatusReview
        $task=Get-OwnedStatusTask
        if (-not $task) { throw 'install-demand-task-first' }
        if ($task.Actions[0].Execute -ieq $guiLauncher -and -not (Test-StatusLauncher)) { throw 'launcher-build-unverified' }
        if ($task.State -eq 'Running' -or (Get-WatchHealth).ok) { throw 'stop-watcher-before-trial' }
        $app=Resolve-Codex; $clients=@(Get-StatusClientProcesses $app)
        if ($clients.Count -ne 1) { throw 'trial-client-identity-unavailable' }
        if (-not $PSCmdlet.ShouldProcess($WatchTaskName,'Wait for user exit, then relaunch once for native verification')) { break }
        @{identityKey=$clients[0].Key;expiresAt=[DateTime]::UtcNow.AddMinutes(5).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'manual-reopen-request.json') -Encoding utf8
        Start-ScheduledTask -TaskPath '\' -TaskName $WatchTaskName
        @{ok=$true;manualTrialStarted=$true;logonEnabled=$false} | ConvertTo-Json
        break
    }
    'Trial' {
        Assert-StatusReview
        $task=Get-OwnedStatusTask
        if (-not $task) { throw 'install-demand-task-first' }
        if ($task.Actions[0].Execute -ieq $guiLauncher -and -not (Test-StatusLauncher)) { throw 'launcher-build-unverified' }
        if ($task.State -eq 'Running' -or (Get-WatchHealth).ok) { throw 'stop-watcher-before-trial' }
        $app=Resolve-Codex; $clients=@(Get-StatusClientProcesses $app)
        if ($clients.Count -ne 1) { throw 'trial-client-identity-unavailable' }
        $probe=[SessionStatusNative]::RestartManager($clients[0],$true)
        if ($probe -ne 'probe-ready') { throw ('trial-'+$probe) }
        if (-not $PSCmdlet.ShouldProcess($WatchTaskName,'Start one normal client reopen and native acceptance trial')) { break }
        @{identityKey=$clients[0].Key;expiresAt=[DateTime]::UtcNow.AddMinutes(5).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'trial-request.json') -Encoding UTF8
        Start-ScheduledTask -TaskPath '\' -TaskName $WatchTaskName
        @{ok=$true;trialStarted=$true;logonEnabled=$false} | ConvertTo-Json
        break
    }
    'EnableLogon' {
        Assert-StatusReview; $app=Resolve-Codex; Assert-StatusNativeAcceptance $app
        $task=Get-OwnedStatusTask
        if (-not $task) { throw 'demand-task-missing' }
        if (-not $PSCmdlet.ShouldProcess($WatchTaskName,'Add verified current-user logon trigger')) { break }
        $trigger=New-ScheduledTaskTrigger -AtLogOn -User $userSid
        Set-ScheduledTask -TaskPath '\' -TaskName $WatchTaskName -Trigger $trigger | Out-Null
        if (-not (Get-OwnedStatusTask)) { throw 'task-registration-unverified' }
        @{ok=$true;task=$WatchTaskName;logonEnabled=$true} | ConvertTo-Json
        break
    }
    'DisableLogon' {
        $task=Get-OwnedStatusTask
        if (-not $task) { throw 'owned-task-missing' }
        if (-not @($task.Triggers | Where-Object { $null -ne $_ }).Count) { @{ok=$true;logonEnabled=$false;alreadyDisabled=$true} | ConvertTo-Json; break }
        if ($PSCmdlet.ShouldProcess($WatchTaskName,'Remove only this owned task logon trigger')) {
            [xml]$definition=Export-ScheduledTask -TaskPath '\' -TaskName $WatchTaskName
            $definition.Task.Triggers.RemoveAll()
            Register-ScheduledTask -TaskPath '\' -TaskName $WatchTaskName -Xml $definition.OuterXml -Force | Out-Null
            $task=Get-OwnedStatusTask
            if (-not $task -or @($task.Triggers | Where-Object { $null -ne $_ }).Count) { throw 'logon-disable-unverified' }
            @{ok=$true;logonEnabled=$false} | ConvertTo-Json
        }
        break
    }
    'Stop' { if ($PSCmdlet.ShouldProcess($WatchTaskName,'Stop this tool and remove its rows')) { Stop-StatusWatch | ConvertTo-Json }; break }
    'Uninstall' {
        $task=Get-OwnedStatusTask
        if (-not $task) { @{ok=$true;taskAbsent=$true} | ConvertTo-Json; break }
        if (-not $PSCmdlet.ShouldProcess($WatchTaskName,'Stop and unregister only this verified watcher task')) { break }
        $null=Stop-StatusWatch
        $null=Get-OwnedStatusTask
        Unregister-ScheduledTask -TaskPath '\' -TaskName $WatchTaskName -Confirm:$false
        if (Get-ScheduledTask -TaskPath '\' -TaskName $WatchTaskName -ErrorAction SilentlyContinue) { throw 'task-removal-unverified' }
        @{ok=$true;uninstalled=$true;sourcePreserved=$true} | ConvertTo-Json
        break
    }
}
