$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $ProjectRoot 'runtime'

function Resolve-Node {
    $saved = Join-Path $RuntimeRoot 'environment.json'
    if (Test-Path -LiteralPath $saved) {
        $environment = Get-Content -LiteralPath $saved -Raw | ConvertFrom-Json
        if ($environment.node -and (Test-Path -LiteralPath $environment.node -PathType Leaf)) {
            return [string]$environment.node
        }
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $command) { throw '找不到 Node.js 22 或更新版本，请重新配置入口。' }
    return $command.Source
}

function Resolve-Codex {
    $packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending)
    $roots = [Collections.Generic.List[string]]::new()
    foreach ($package in $packages) { if ($package.InstallLocation) { $roots.Add($package.InstallLocation) } }
    foreach ($process in @(Get-Process ChatGPT,Codex -ErrorAction SilentlyContinue)) {
        if ($process.Path) { $roots.Add((Split-Path -Parent (Split-Path -Parent $process.Path))) }
    }
    # Store inventory can be unavailable in a constrained host; current-user registration
    # is a second dynamic source, before the last verified installation location.
    $registry = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages'
    if (Test-Path -LiteralPath $registry) {
        foreach ($key in @(Get-ChildItem -LiteralPath $registry -ErrorAction SilentlyContinue |
                Where-Object PSChildName -Like 'OpenAI.Codex_*' | Sort-Object PSChildName -Descending)) {
            $location = (Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue).PackageRootFolder
            if ($location) { $roots.Add([string]$location) }
        }
    }
    $saved = Join-Path $RuntimeRoot 'environment.json'
    if (Test-Path -LiteralPath $saved) {
        $environment = Get-Content -LiteralPath $saved -Raw | ConvertFrom-Json
        if ($environment.lastAppRoot) { $roots.Add([string]$environment.lastAppRoot) }
    }
    foreach ($root in @($roots | Select-Object -Unique)) {
        $manifestFile = Join-Path $root 'AppxManifest.xml'
        if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) { continue }
        [xml]$manifest = Get-Content -LiteralPath $manifestFile -Raw
        if ([string]$manifest.Package.Identity.Name -ne 'OpenAI.Codex') { continue }
        $application = @($manifest.Package.Applications.Application) |
            Where-Object { $_.Id -eq 'App' -and $_.Executable -match '(?i)\.exe$' } | Select-Object -First 1
        if (-not $application) { continue }
        $exe = Join-Path $root $application.Executable
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { continue }
        $package = $packages | Where-Object InstallLocation -EQ $root | Select-Object -First 1
        $family = if ($package) { $package.PackageFamilyName } else {
            $folder = Split-Path -Leaf $root
            if ($folder -notmatch '__([a-z0-9]+)$') { continue }
            [string]$manifest.Package.Identity.Name + '_' + $Matches[1]
        }
        return [pscustomobject]@{ Root=$root; Exe=$exe;
            AppId=($family + '!' + $application.Id); Version=[string]$manifest.Package.Identity.Version }
    }
    throw '未找到当前 Codex Store 版本。请先从原图标启动一次，再重新配置入口。'
}

function Get-CdpTargets([int]$Port) {
    try {
        # Assignment unwraps the single JSON-array pipeline object before enumeration.
        $targets = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/json/list') -TimeoutSec 1 -MaximumRedirection 0
        return @($targets | Where-Object {
            $_.type -eq 'page' -and $_.url -match '^app://[^/]+/index\.html([?#]|$)' -and
            $_.url -notmatch '[?&]initialRoute=' -and
            $_.webSocketDebuggerUrl -match ('^ws://127\.0\.0\.1:' + $Port + '/')
        })
    } catch { return @() }
}

function Find-CdpPort {
    $candidates = [Collections.Generic.List[int]]::new()
    foreach ($file in @('state.json','launch.json')) {
        $source = Join-Path $RuntimeRoot $file
        if (Test-Path -LiteralPath $source) {
            try {
                $value = Get-Content -LiteralPath $source -Raw | ConvertFrom-Json
                if ($value.port -ge 1024 -and $value.port -le 65535) { $candidates.Add([int]$value.port) }
            } catch {}
        }
    }
    $candidates.Add(9345)
    # Also discover an existing client connection opened outside this launcher.
    $clientPids = @(Get-Process ChatGPT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if ($clientPids.Count -and (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
        try {
            foreach ($listener in @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -ErrorAction Stop |
                    Where-Object OwningProcess -In $clientPids)) {
                if ($listener.LocalPort -ge 1024) { $candidates.Add([int]$listener.LocalPort) }
            }
        } catch {}
    }
    foreach ($port in @($candidates | Select-Object -Unique)) {
        if (@(Get-CdpTargets $port).Count -gt 0) { return $port }
    }
    return 0
}

function Find-FreePort {
    for ($port=9345; $port -le 9376; $port++) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
        try { $listener.Start(); return $port }
        catch {}
        finally { $listener.Stop() }
    }
    throw '状态栏使用的本机端口均已占用，请稍后重试。'
}

function Initialize-StatusActivation {
    if (-not ('SessionStatusActivation' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISessionStatusActivation {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id,
    [MarshalAs(UnmanagedType.LPWStr)] string args, int options, out uint pid);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] public class SessionStatusActivationManager {}
public static class SessionStatusActivation {
  public static uint Launch(string id, string args) {
    var manager = (ISessionStatusActivation)new SessionStatusActivationManager();
    uint pid; int result = manager.ActivateApplication(id, args, 0, out pid);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
    return pid;
  }
}
'@
    }
}
function Start-CodexWithPort($App, [int]$Port) {
    Initialize-StatusActivation
    $arguments = '--remote-debugging-port=' + $Port + ' --remote-debugging-address=127.0.0.1'
    [void][SessionStatusActivation]::Launch($App.AppId, $arguments)
}

function Show-StatusMessage([string]$Message) {
    Add-Type -AssemblyName PresentationFramework
    [void][Windows.MessageBox]::Show($Message, 'Codex 状态栏')
}
