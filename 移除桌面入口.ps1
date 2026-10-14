[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param()
. (Join-Path $PSScriptRoot 'scripts\windows.ps1')
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex 状态栏.lnk'
if (-not (Test-Path -LiteralPath $shortcutPath)) { Write-Output '专用快捷方式不存在。'; return }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$expected = '-NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "' + (Join-Path $ProjectRoot 'scripts\bootstrap.ps1') + '"'
if ($shortcut.WorkingDirectory -ne $ProjectRoot -or $shortcut.Arguments -ne $expected) {
    throw '快捷方式不属于本项目，未删除。'
}
if ($PSCmdlet.ShouldProcess($shortcutPath, '删除本项目专用快捷方式')) {
    Remove-Item -LiteralPath $shortcutPath
    if (Test-Path -LiteralPath $shortcutPath) { throw '快捷方式仍存在。' }
    Write-Output '已移除专用入口。原来的 Codex 图标可以继续使用。'
}
