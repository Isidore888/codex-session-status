[CmdletBinding()]
param([switch]$ProjectOnly, [switch]$RepairOwned)
. (Join-Path $PSScriptRoot 'scripts\windows.ps1')
$node = (Get-Command node.exe -ErrorAction Stop).Source
$version = & $node --version
if ($version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw '需要 Node.js 22 或更新版本。' }
$pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { throw '未找到已有 PowerShell 7；请先确认运行环境。' }
$app = Resolve-Codex
New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
@{ node=$node; powershell=$pwsh; lastAppRoot=$app.Root } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $RuntimeRoot 'environment.json') -Encoding utf8
if (-not $ProjectOnly) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop 'Codex 状态栏.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $quote = [char]34
    $arguments = '-NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File ' + $quote + (Join-Path $ProjectRoot 'scripts\bootstrap.ps1') + $quote
    $previous = '-NoProfile -WindowStyle Hidden -File ' + $quote + (Join-Path $ProjectRoot 'scripts\launch.ps1') + $quote
    $previousBootstrap = '-NoProfile -WindowStyle Hidden -File ' + $quote + (Join-Path $ProjectRoot 'scripts\bootstrap.ps1') + $quote
    if (Test-Path -LiteralPath $shortcutPath) {
        if (-not $RepairOwned -or $shortcut.WorkingDirectory -ne $ProjectRoot -or
            $shortcut.Arguments -notin @($arguments,$previous,$previousBootstrap)) {
            throw '同名桌面快捷方式已存在，未覆盖；请选择项目内启动文件。'
        }
    }
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $ProjectRoot
    $shortcut.Description = '启动 Codex 并自动显示四项会话状态'
    $iconSource = Join-Path (Split-Path -Parent $app.Exe) 'resources\icon-chatgpt.ico'
    if (Test-Path -LiteralPath $iconSource) {
        $icon = Join-Path $RuntimeRoot 'codex.ico'
        Copy-Item -LiteralPath $iconSource -Destination $icon
        $shortcut.IconLocation = $icon + ',0'
    }
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    $verified = $shell.CreateShortcut($shortcutPath)
    if ($verified.WorkingDirectory -ne $ProjectRoot -or $verified.TargetPath -ne $shortcut.TargetPath -or
        $verified.Arguments -ne $shortcut.Arguments) {
        throw '快捷方式回读校验失败。'
    }
    Write-Output ('已创建并校验：' + $shortcutPath)
}
Write-Output '配置完成。当前客户端未关闭；首次启用前请正常退出，再使用新入口。'
