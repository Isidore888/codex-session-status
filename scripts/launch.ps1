[CmdletBinding()]
param([switch]$CheckOnly, [switch]$NoDialog)
. (Join-Path $PSScriptRoot 'windows.ps1')
$mutex = [Threading.Mutex]::new($false, 'Local\CodexSessionStatusLauncher')
$held = $false
$splash = $null
try {
    try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { exit 0 }
    $node = Resolve-Node
    $app = Resolve-Codex
    $port = Find-CdpPort
    if ($CheckOnly) {
        [pscustomobject]@{ Node=$node; AppVersion=$app.Version; Exe=$app.Exe;
            AppId=$app.AppId; ExistingCdpPort=$port; CodexRunning=@(Get-Process ChatGPT -ErrorAction SilentlyContinue).Count -gt 0 } |
            ConvertTo-Json
        exit 0
    }
    New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
    $monitor = Join-Path $ProjectRoot 'src\monitor.mjs'
    $health = & $node $monitor --health | ConvertFrom-Json
    if ($health.ok -and $port) {
        # If the client was minimized or hidden to the system tray, pop its main window up.
        Show-StatusClientWindow $app $null $port
        exit 0
    }
    if ($health.ok) {
        # A just-closed client can leave its companion in the reload grace period.
        # Stop only the companion, so an immediate second launch can start Codex normally.
        & $node $monitor --stop | Out-Null
        for ($attempt=0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 500
            $health = & $node $monitor --health | ConvertFrom-Json
            if (-not $health.ok) { break }
        }
        if ($health.ok) { throw '上一个状态栏正在停止，请稍后再启动。客户端未被关闭。' }
    }
    if (-not $port) {
        if (@(Get-Process ChatGPT -ErrorAction SilentlyContinue).Count -gt 0) {
            Show-StatusClientWindow $app $null 0
            $message = 'Codex 当前未开放状态栏连接。请先保存工作并正常退出 Codex，或双击“启动状态栏.cmd”开启自动接管。'
            if ($NoDialog) { Write-Output $message } else { Show-StatusMessage $message }
            exit 2
        }
        $splash = if (-not $NoDialog) { Start-StatusSplash '正在启动 Codex 并加载会话状态栏...' } else { $null }
        $port = Find-FreePort
        Start-CodexWithPort $app $port
        $deadline = [DateTime]::UtcNow.AddSeconds(180)
        while ([DateTime]::UtcNow -lt $deadline -and @(Get-CdpTargets $port).Count -eq 0) {
            Start-Sleep -Milliseconds 400
        }
        if (@(Get-CdpTargets $port).Count -eq 0) {
            throw 'Codex 已启动，但暂时无法连接状态栏；客户端可以继续正常使用。'
        }
        Update-StatusSplash $splash '正在挂载实时会话状态栏...'
    }
    @{ port=$port; appVersion=$app.Version } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $RuntimeRoot 'launch.json') -Encoding utf8
    $quote = [char]34
    $argument = $quote + $monitor + $quote + ' --run'
    $child = Start-Process -FilePath $node -ArgumentList $argument -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
    for ($attempt=0; $attempt -lt 12; $attempt++) {
        Start-Sleep -Milliseconds 500
        $health = & $node $monitor --health | ConvertFrom-Json
        if ($health.ok) {
            Stop-StatusSplash $splash
            $splash = $null
            Show-StatusClientWindow $app $null $port
            exit 0
        }
        if ($child.HasExited) { break }
    }
    throw '状态栏没有成功启动。请查看项目 runtime\monitor.log；Codex 可以继续正常使用。'
} catch {
    Stop-StatusSplash $splash
    $splash = $null
    if ($NoDialog) { Write-Error $_.Exception.Message } else { Show-StatusMessage $_.Exception.Message }
    exit 1
} finally {
    Stop-StatusSplash $splash
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
