$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows.ps1')
$app = Resolve-Codex
& (Resolve-Node) (Join-Path $PSScriptRoot 'inspect-startup.mjs') $app.Root $app.Version
if ($LASTEXITCODE -ne 0) { throw '启动兼容性检查失败。未更改任何系统启动配置。' }
