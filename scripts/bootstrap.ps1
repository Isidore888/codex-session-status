# ASCII bootstrap for the Windows-bundled PowerShell 5.1; all app logic runs in saved PowerShell 7.
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$Watch, [switch]$Setup)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'windows.ps1')
$envFile = Join-Path $project 'runtime\environment.json'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    $null = Ensure-StatusEnvironment
}
$settings = Get-Content -LiteralPath $envFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $settings.powershell -PathType Leaf)) {
    $settings = Ensure-StatusEnvironment
}
if ($CheckOnly) {
    & $settings.powershell -NoProfile -File (Join-Path $PSScriptRoot 'launch.ps1') -CheckOnly -NoDialog
    exit $LASTEXITCODE
}
if ($Setup) {
    & $settings.powershell -NoProfile -ExecutionPolicy RemoteSigned -File (Join-Path $PSScriptRoot 'manage.ps1') -Action Setup | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Show-StatusMessage '自动配置后台开机自启失败，请检查 PowerShell 7 与 Node.js 22+ 环境。'
        exit $LASTEXITCODE
    }
    $app = Resolve-Codex
    if (@(Get-Process ChatGPT -ErrorAction SilentlyContinue).Count -eq 0) {
        $quote = [char]34
        $arguments = '-NoProfile -WindowStyle Hidden -File ' + $quote + (Join-Path $PSScriptRoot 'launch.ps1') + $quote
        Start-Process -FilePath $settings.powershell -ArgumentList $arguments -WorkingDirectory $project -WindowStyle Hidden
    } else {
        # If ChatGPT is already running with CDP but hidden in the system tray, pop its window up.
        $existingPort = Find-CdpPort
        if ($existingPort -gt 0) {
            Show-StatusClientWindow $app $null $existingPort
        }
        Show-StatusMessage 'Codex 状态栏已安装并开启开机自启！后台正在自动连接并显示客户端窗口。'
    }
    exit 0
}
if ($Watch) {
    if (-not ('SessionStatusConsole' -as [type])) { Add-Type -LiteralPath (Join-Path $PSScriptRoot 'watch-console.cs') }
    $null=[SessionStatusConsole]::DetachOwnStandaloneConsole($PSCommandPath)
    $result=[SessionStatusConsole]::RunHidden($settings.powershell,@('-NoProfile','-File',(Join-Path $PSScriptRoot 'watch.ps1'),'-Run'),$project)
    exit $result.ExitCode
}
$quote = [char]34
$arguments = '-NoProfile -WindowStyle Hidden -File ' + $quote + (Join-Path $PSScriptRoot 'launch.ps1') + $quote
Start-Process -FilePath $settings.powershell -ArgumentList $arguments -WorkingDirectory $project -WindowStyle Hidden
