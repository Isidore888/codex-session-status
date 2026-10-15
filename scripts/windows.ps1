$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $ProjectRoot 'runtime'

function Resolve-Node {
    $saved = Join-Path $RuntimeRoot 'environment.json'
    if (Test-Path -LiteralPath $saved) {
        try {
            $environment = Get-Content -LiteralPath $saved -Raw | ConvertFrom-Json
            if ($environment.node -and (Test-Path -LiteralPath $environment.node -PathType Leaf)) {
                return [string]$environment.node
            }
        } catch {}
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $command) { throw '找不到 Node.js 22 或更新版本，请先安装 Node.js 22+。' }
    return $command.Source
}

function Resolve-PowerShell7 {
    $saved = Join-Path $RuntimeRoot 'environment.json'
    if (Test-Path -LiteralPath $saved) {
        try {
            $environment = Get-Content -LiteralPath $saved -Raw | ConvertFrom-Json
            if ($environment.powershell -and (Test-Path -LiteralPath $environment.powershell -PathType Leaf)) {
                return [string]$environment.powershell
            }
        } catch {}
    }
    $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($pwsh) { return $pwsh.Source }
    $candidatePaths = @(
        (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'PowerShell\7\pwsh.exe')
    )
    foreach ($candidate in $candidatePaths) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    throw '未找到 PowerShell 7 (pwsh.exe)；请先安装 PowerShell 7。'
}

function Ensure-StatusEnvironment {
    $node = Resolve-Node
    $version = & $node --version
    if ($version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw '需要 Node.js 22 或更新版本。' }
    $pwsh = Resolve-PowerShell7
    $app = Resolve-Codex
    New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
    $envFile = Join-Path $RuntimeRoot 'environment.json'
    $payload = @{ node = $node; powershell = $pwsh; lastAppRoot = $app.Root }
    $payload | ConvertTo-Json | Set-Content -LiteralPath $envFile -Encoding utf8
    return [pscustomobject]$payload
}

function Remove-LegacyDesktopShortcut {
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        if (-not $desktop) { return $false }
        $shortcutPath = Join-Path $desktop 'Codex 状态栏.lnk'
        if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { return $false }
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        if ($shortcut.WorkingDirectory -ieq $ProjectRoot) {
            Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
            return -not (Test-Path -LiteralPath $shortcutPath)
        }
    } catch {}
    return $false
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
    throw '未找到当前 Codex Store 版本。请先从原图标启动一次，再重新运行。'
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

function Show-StatusClientWindow($App, $Identity = $null, [int]$Port = 0) {
    if (-not $App -or $App.Version -eq 'fixture' -or [string]::IsNullOrEmpty($App.AppId) -or ($Identity -and $Identity.Key -eq 'fixture')) { return }
    try {
        if (-not ('SessionStatusNative' -as [type])) {
            $nativeFile = Join-Path $PSScriptRoot 'watch-native.cs'
            if (Test-Path -LiteralPath $nativeFile -PathType Leaf) {
                Add-Type -LiteralPath $nativeFile
            }
        }
        $targetPid = if ($Identity -and $Identity.Pid) { [uint32]$Identity.Pid } else {
            $proc = Get-Process ChatGPT -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($proc) { [uint32]$proc.Id } else { [uint32]0 }
        }
        # Always send one Store AUMID ActivateApplication to grant Windows foreground rights
        # and tell Electron to un-minimize / un-hide its main window.
        Initialize-StatusActivation
        try { [void][SessionStatusActivation]::Launch($App.AppId, '') } catch {}
        $visibleCount = 0
        for ($i = 0; $i -lt 20; $i++) {
            if ($i -eq 6 -or $i -eq 12) {
                try { [void][SessionStatusActivation]::Launch($App.AppId, '') } catch {}
            }
            if ('SessionStatusNative' -as [type]) {
                if ([SessionStatusNative]::ShowMainWindow($targetPid, $App.Exe)) {
                    $visibleCount++
                    # Confirm across two checks (~360ms apart) so delayed Electron state restore cannot re-minimize it.
                    if ($visibleCount -ge 2) { break }
                } else {
                    $visibleCount = 0
                }
            }
            Start-Sleep -Milliseconds 180
        }
    } catch {}
}

function Initialize-StatusSplashType {
    if ('SessionStatusSplash' -as [type]) { return $true }
    try {
        Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Threading;
using System.Windows.Forms;

public sealed class SessionStatusSplash : IDisposable {
    Form form;
    string subtitle;
    int angle;
    bool closing;

    sealed class SplashForm : Form {
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams {
            get {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x08000088; // WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW
                return cp;
            }
        }
        public SplashForm() { DoubleBuffered = true; }
    }

    public static SessionStatusSplash Show(string text) {
        if (!Environment.UserInteractive) return null;
        var instance = new SessionStatusSplash { subtitle = text ?? "正在开启调试连接并重新进入 Codex..." };
        var ready = new ManualResetEventSlim(false);
        var thread = new Thread(() => {
            try {
                var f = new SplashForm {
                    FormBorderStyle = FormBorderStyle.None,
                    StartPosition = FormStartPosition.Manual,
                    ShowInTaskbar = false,
                    TopMost = true,
                    Width = 340,
                    Height = 88,
                    BackColor = Color.FromArgb(28, 28, 34),
                    Opacity = 0.0
                };
                var area = Screen.PrimaryScreen != null ? Screen.PrimaryScreen.WorkingArea : new Rectangle(0, 0, 1280, 720);
                f.Location = new Point(area.Left + (area.Width - f.Width) / 2, area.Top + (area.Height - f.Height) / 2);
                using (var path = new GraphicsPath()) {
                    int d = 24;
                    path.AddArc(0, 0, d, d, 180, 90);
                    path.AddArc(f.Width - d, 0, d, d, 270, 90);
                    path.AddArc(f.Width - d, f.Height - d, d, d, 0, 90);
                    path.AddArc(0, f.Height - d, d, d, 90, 90);
                    path.CloseFigure();
                    f.Region = new Region(path);
                }
                f.Paint += (s, e) => {
                    var g = e.Graphics;
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                    using (var border = new Pen(Color.FromArgb(68, 68, 82), 1.5f)) {
                        g.DrawRectangle(border, 1, 1, f.Width - 3, f.Height - 3);
                    }
                    var spinnerRect = new Rectangle(22, 24, 38, 38);
                    using (var trackPen = new Pen(Color.FromArgb(52, 52, 64), 3.5f)) {
                        g.DrawEllipse(trackPen, spinnerRect);
                    }
                    using (var arcPen = new Pen(Color.FromArgb(99, 179, 237), 3.5f)) {
                        arcPen.StartCap = LineCap.Round;
                        arcPen.EndCap = LineCap.Round;
                        g.DrawArc(arcPen, spinnerRect, instance.angle, 110);
                    }
                    using (var titleFont = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Bold))
                    using (var subFont = new Font("Microsoft YaHei UI", 8.75f, FontStyle.Regular))
                    using (var titleBrush = new SolidBrush(Color.FromArgb(242, 242, 247)))
                    using (var subBrush = new SolidBrush(Color.FromArgb(174, 174, 188))) {
                        g.DrawString("Codex 状态栏正在启动", titleFont, titleBrush, new PointF(74, 22));
                        g.DrawString(instance.subtitle, subFont, subBrush, new PointF(74, 46));
                    }
                };
                var timer = new System.Windows.Forms.Timer { Interval = 30 };
                timer.Tick += (s, e) => {
                    instance.angle = (instance.angle + 12) % 360;
                    if (!instance.closing && f.Opacity < 0.95) f.Opacity = Math.Min(0.96, f.Opacity + 0.12);
                    else if (instance.closing) {
                        if (f.Opacity > 0.15) f.Opacity = Math.Max(0.0, f.Opacity - 0.18);
                        else { timer.Stop(); f.Close(); }
                    }
                    f.Invalidate();
                };
                f.Shown += (s, e) => { instance.form = f; timer.Start(); ready.Set(); };
                f.FormClosed += (s, e) => { timer.Dispose(); Application.ExitThread(); };
                Application.Run(f);
            } catch { ready.Set(); }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        ready.Wait(600);
        return instance;
    }

    public void UpdateText(string text) {
        if (String.IsNullOrEmpty(text)) return;
        subtitle = text;
        var f = form;
        if (f != null && !f.IsDisposed) {
            try { f.BeginInvoke((Action)(() => f.Invalidate())); } catch {}
        }
    }

    public void Dispose() {
        closing = true;
        var f = form;
        if (f != null && !f.IsDisposed) {
            try { f.BeginInvoke((Action)(() => { closing = true; })); } catch {}
        }
    }
}
'@
        return $true
    } catch { return $false }
}

function Start-StatusSplash([string]$Message = '正在开启调试连接并重新进入 Codex...') {
    if ($env:CODEX_STATUS_NO_SPLASH -eq '1') { return $null }
    if (-not (Initialize-StatusSplashType)) { return $null }
    try { return [SessionStatusSplash]::Show($Message) } catch { return $null }
}

function Update-StatusSplash($Splash, [string]$Message) {
    if ($null -eq $Splash) { return }
    try { $Splash.UpdateText($Message) } catch {}
}

function Stop-StatusSplash($Splash) {
    if ($null -eq $Splash) { return }
    try { $Splash.Dispose() } catch {}
}

function Show-StatusMessage([string]$Message) {
    Add-Type -AssemblyName PresentationFramework
    [void][Windows.MessageBox]::Show($Message, 'Codex 状态栏')
}
