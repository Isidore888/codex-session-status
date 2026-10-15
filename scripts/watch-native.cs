using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;

// Native calls are restricted to verified current-session process identities.
public static class SessionStatusNative {
    [StructLayout(LayoutKind.Sequential)] public struct FileTime {
        public uint Low; public uint High;
        public long Ticks { get { return ((long)High << 32) | Low; } }
    }
    [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint Pid; public FileTime Started; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;
        public int AppType; public uint Status; public uint Session;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    public sealed class Identity {
        public uint Pid; public string Path; public long StartTicks; public uint Session; public string UserSid;
        public string Key { get { return Pid + ":" + StartTicks; } }
    }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, uint size, out uint needed);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern uint RmStartSession(out uint session, uint flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern uint RmRegisterResources(uint session, uint files, string[] filenames, uint applications, UniqueProcess[] processes, uint services, string[] serviceNames);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern uint RmGetList(uint session, out uint needed, ref uint count, [In,Out] ProcessInfo[] processes, ref uint rebootReasons);
    [DllImport("rstrtmgr.dll")] static extern uint RmShutdown(uint session, uint flags, IntPtr callback);
    [DllImport("rstrtmgr.dll")] static extern uint RmEndSession(uint session);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out Rect lpRect);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint dwProcessId);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    public static Identity ReadIdentity(uint pid) {
        IntPtr h=OpenProcess(0x1000, false, pid); // QUERY_LIMITED_INFORMATION, never terminate access.
        if(h==IntPtr.Zero) return null;
        try {
            var text=new StringBuilder(32768); uint size=(uint)text.Capacity, session;
            FileTime created, exited, kernel, user;
            if(!QueryFullProcessImageName(h,0,text,ref size) || !GetProcessTimes(h,out created,out exited,out kernel,out user) || !ProcessIdToSessionId(pid,out session)) return null;
            string sid=ReadUserSid(h);
            if(sid==null) return null;
            return new Identity { Pid=pid, Path=text.ToString(), StartTicks=created.Ticks, Session=session, UserSid=sid };
        } finally { CloseHandle(h); }
    }
    public static string CurrentUserSid { get { using(var identity=WindowsIdentity.GetCurrent()) return identity.User.Value; } }
    static string ReadUserSid(IntPtr process) {
        IntPtr token;
        if(!OpenProcessToken(process,0x0008,out token)) return null; // TOKEN_QUERY; TokenUser only.
        IntPtr data=IntPtr.Zero;
        try {
            uint needed;
            GetTokenInformation(token,1,IntPtr.Zero,0,out needed);
            if(needed==0 || needed>65536) return null;
            data=Marshal.AllocHGlobal((int)needed);
            if(!GetTokenInformation(token,1,data,needed,out needed)) return null;
            return new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;
        } finally { if(data!=IntPtr.Zero) Marshal.FreeHGlobal(data); CloseHandle(token); }
    }
    public static bool Matches(Identity expected) {
        if(expected==null) return false; var actual=ReadIdentity(expected.Pid);
        return actual!=null && expected.UserSid==CurrentUserSid && actual.UserSid==expected.UserSid && actual.StartTicks==expected.StartTicks && actual.Session==expected.Session && String.Equals(actual.Path,expected.Path,StringComparison.OrdinalIgnoreCase);
    }
    static List<IntPtr> FindClientWindows(uint rootPid, string exePath, bool visibleOnly) {
        var found = new List<IntPtr>();
        uint currentSession = (uint)Process.GetCurrentProcess().SessionId;
        string currentSid = CurrentUserSid;
        EnumWindows((hWnd, lParam) => {
            if (GetWindow(hWnd, 4) != IntPtr.Zero) return true; // Skip owned child/popup windows.
            if (visibleOnly && !IsWindowVisible(hWnd)) return true;
            if (GetWindowTextLength(hWnd) <= 0) return true;
            var cls = new StringBuilder(128);
            if (GetClassName(hWnd, cls, cls.Capacity) <= 0 || cls.ToString() != "Chrome_WidgetWin_1") return true;
            uint winPid;
            GetWindowThreadProcessId(hWnd, out winPid);
            if (winPid == 0) return true;
            bool match = (rootPid != 0 && winPid == rootPid);
            if (!match && !String.IsNullOrEmpty(exePath)) {
                var id = ReadIdentity(winPid);
                match = id != null && id.Session == currentSession && id.UserSid == currentSid
                    && String.Equals(id.Path, exePath, StringComparison.OrdinalIgnoreCase);
            }
            if (!match) return true;
            if (!IsIconic(hWnd)) {
                Rect r;
                if (GetWindowRect(hWnd, out r) && ((r.Right - r.Left) < 240 || (r.Bottom - r.Top) < 160)) return true;
            }
            found.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static bool HasVisibleMainWindow(uint rootPid, string exePath) {
        foreach (var hWnd in FindClientWindows(rootPid, exePath, true)) {
            if (!IsIconic(hWnd)) return true;
        }
        return false;
    }
    static void RestoreAndFocusWindow(IntPtr hWnd) {
        uint fgPid;
        IntPtr fgWnd = GetForegroundWindow();
        uint fgThread = fgWnd != IntPtr.Zero ? GetWindowThreadProcessId(fgWnd, out fgPid) : 0;
        uint curThread = GetCurrentThreadId();
        bool attached = false;
        try {
            if (fgThread != 0 && fgThread != curThread) {
                attached = AttachThreadInput(curThread, fgThread, true);
            }
            if (IsIconic(hWnd)) {
                IntPtr res;
                // WM_SYSCOMMAND (0x0112) + SC_RESTORE (0xF120) un-minimizes taskbar windows cleanly
                SendMessageTimeout(hWnd, 0x0112, new IntPtr(0xF120), IntPtr.Zero, 0x0002, 400, out res);
                ShowWindow(hWnd, 9); // SW_RESTORE (do not follow immediately with SW_SHOW)
            } else if (!IsWindowVisible(hWnd)) {
                ShowWindow(hWnd, 5); // SW_SHOW
                ShowWindow(hWnd, 9); // SW_RESTORE
            }
            SwitchToThisWindow(hWnd, true);
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
        } finally {
            if (attached) AttachThreadInput(curThread, fgThread, false);
        }
    }
    public static bool ShowMainWindow(uint rootPid, string exePath) {
        try { AllowSetForegroundWindow(0xFFFFFFFF); } catch {}
        if (rootPid != 0) { try { AllowSetForegroundWindow(rootPid); } catch {} }
        var windows = FindClientWindows(rootPid, exePath, true);
        if (windows.Count == 0) windows = FindClientWindows(rootPid, exePath, false);
        foreach (var hWnd in windows) {
            RestoreAndFocusWindow(hWnd);
        }
        return HasVisibleMainWindow(rootPid, exePath);
    }
    // ProbeOnly registers one unique process and reads its impact list, but never quits it.
    public static string RestartManager(Identity expected, bool probeOnly) {
        if(!Matches(expected) || expected.Session!=(uint)Process.GetCurrentProcess().SessionId) return "identity-unavailable";
        uint handle; var key=new StringBuilder(33); uint rc=RmStartSession(out handle,0,key);
        if(rc!=0) return "rm-start-"+rc;
        try {
            var ft=new FileTime { Low=(uint)(expected.StartTicks & 0xffffffff), High=(uint)(expected.StartTicks >> 32) };
            rc=RmRegisterResources(handle,0,null,1,new[]{new UniqueProcess{Pid=expected.Pid,Started=ft}},0,null);
            if(rc!=0) return "rm-register-"+rc;
            uint needed=0,count=0,reboot=0; rc=RmGetList(handle,out needed,ref count,null,ref reboot);
            if(rc!=0 && rc!=234) return "rm-list-"+rc;
            if(needed>32 || reboot!=0) return "rm-impact-rejected";
            var list=new ProcessInfo[Math.Max(needed,1)]; count=(uint)list.Length;
            rc=RmGetList(handle,out needed,ref count,list,ref reboot);
            if(rc!=0 || reboot!=0) return "rm-list-"+rc;
            if(count!=1 || list[0].Process.Pid!=expected.Pid || list[0].Process.Started.Ticks!=expected.StartTicks || list[0].Session!=expected.Session || !String.IsNullOrEmpty(list[0].ServiceName)) return "rm-impact-rejected";
            if(!Matches(expected)) return "identity-changed";
            if(probeOnly) return "probe-ready";
            // Exactly zero flags. RmForceShutdown is never requested; no services/files registered.
            rc=RmShutdown(handle,0,IntPtr.Zero);
            return rc==0 ? "shutdown-requested" : "rm-shutdown-"+rc;
        } finally { RmEndSession(handle); }
    }
}

public sealed class SessionStatusWatchControl : IDisposable {
    readonly CancellationTokenSource cancel=new CancellationTokenSource();
    readonly string name; readonly Task worker;
    public volatile bool StopRequested;
    public volatile string Health="{\"ok\":true,\"phase\":\"starting\"}";
    public SessionStatusWatchControl(string pipeName) { name=pipeName; worker=Task.Run(Run); }
    async Task Run() {
        while(!cancel.IsCancellationRequested) {
            try {
                using(var pipe=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly,1024,1024)) {
                    await pipe.WaitForConnectionAsync(cancel.Token);
                    using(var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel.Token)) {
                        timeout.CancelAfter(1500); byte[] bytes=new byte[33]; int size=0;
                        while(size<bytes.Length) { int n=await pipe.ReadAsync(bytes,size,1,timeout.Token); if(n==0) break; size+=n; if(bytes[size-1]==10) break; }
                        string action=Encoding.UTF8.GetString(bytes,0,size).Trim(); string answer="{\"ok\":false}";
                        if(size<=32 && action=="health") answer=Health;
                        if(size<=32 && action=="stop") { StopRequested=true; answer="{\"ok\":true,\"stopping\":true}"; }
                        byte[] output=Encoding.UTF8.GetBytes(answer+"\n"); await pipe.WriteAsync(output,0,output.Length,timeout.Token); await pipe.FlushAsync(timeout.Token);
                    }
                }
            } catch(OperationCanceledException) {} catch(IOException) {} catch(UnauthorizedAccessException) { StopRequested=true; break; }
        }
    }
    public static string Request(string name,string command) {
        if(command!="health" && command!="stop") return "{\"ok\":false}";
        try {
            using(var pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut,PipeOptions.Asynchronous)) {
                pipe.Connect(1000); byte[] request=Encoding.UTF8.GetBytes(command+"\n"); pipe.Write(request,0,request.Length); pipe.Flush();
                byte[] output=new byte[65536]; var read=pipe.ReadAsync(output,0,output.Length);
                if(!read.Wait(1500)) return "{\"ok\":false}";
                return Encoding.UTF8.GetString(output,0,read.Result).Trim();
            }
        } catch { return "{\"ok\":false}"; }
    }
    public void Dispose() { cancel.Cancel(); try { worker.Wait(2000); } catch {} cancel.Dispose(); }
}
