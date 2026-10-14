using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Text;

// Only detach this dedicated helper process; never signal or close another console.
public static class SessionStatusConsole {
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetConsoleProcessList(uint[] ids, uint count);
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Size; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public int Size; public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedSize; public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
    public static uint ConsoleProcessCount() { return GetConsoleProcessList(new uint[1], 1); }
    static string QuoteArgument(string value) {
        if (value == null) throw new ArgumentNullException("value");
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(c);
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }
    static ProcessStartInfo HiddenInfo(string executable, string[] args, string directory) {
        var command = new StringBuilder();
        foreach (var arg in args) { if (command.Length > 0) command.Append(' '); command.Append(QuoteArgument(arg)); }
        return new ProcessStartInfo {
            FileName = executable, Arguments = command.ToString(), WorkingDirectory = directory,
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
        };
    }
    public sealed class Result { public int ExitCode; public string Output; }
    public static Result RunHidden(string executable, string[] args, string directory) {
        var info = HiddenInfo(executable, args, directory);
        info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        using (var process = Process.Start(info)) {
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            process.WaitForExit();
            error.GetAwaiter().GetResult(); // Drain without logging arbitrary helper diagnostics.
            return new Result { ExitCode = process.ExitCode, Output = output.GetAwaiter().GetResult() };
        }
    }
    public static int StartHidden(string executable, string[] args, string directory) {
        // Restrict inheritance to one NUL handle. .NET Framework otherwise passes
        // unrelated captured pipes too, keeping a completed launcher alive.
        IntPtr nul=IntPtr.Zero, list=IntPtr.Zero, handles=IntPtr.Zero;
        bool initialized=false;
        var security=new SecurityAttributes { Size=Marshal.SizeOf(typeof(SecurityAttributes)), Inherit=true };
        try {
            nul=CreateFile("NUL",0xc0000000,3,ref security,3,0x80,IntPtr.Zero);
            if(nul==new IntPtr(-1)) throw new InvalidOperationException("hidden-null-handle-failed");
            IntPtr size=IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            if(size.ToInt64()<=0 || size.ToInt64()>65536) throw new InvalidOperationException("hidden-attributes-size-failed");
            list=Marshal.AllocHGlobal(size);
            if(!InitializeProcThreadAttributeList(list,1,0,ref size)) throw new InvalidOperationException("hidden-attributes-init-failed");
            initialized=true;
            handles=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(handles,nul);
            if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new InvalidOperationException("hidden-handle-list-failed");
            var startup=new StartupInfoEx { Attributes=list };
            startup.Info.Size=Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Info.Flags=0x100; startup.Info.Input=nul; startup.Info.Output=nul; startup.Info.Error=nul;
            var command=new StringBuilder(QuoteArgument(executable));
            foreach(var arg in args) command.Append(' ').Append(QuoteArgument(arg));
            ProcessInformation process;
            // CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT; never request elevated
            // identity, breakaway, another console, or any operation on other processes.
            if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080000,IntPtr.Zero,directory,ref startup,out process)) throw new InvalidOperationException("hidden-process-start-failed");
            try { return checked((int)process.ProcessId); }
            finally { CloseHandle(process.Thread); CloseHandle(process.Process); }
        } finally {
            if(initialized) DeleteProcThreadAttributeList(list);
            if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
            if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if(nul!=IntPtr.Zero && nul!=new IntPtr(-1)) CloseHandle(nul);
        }
    }
    public static bool DetachOwnStandaloneConsole(string scriptPath) {
        var args = Environment.GetCommandLineArgs();
        for (int i=1; i+1<args.Length; i++) {
            if (!String.Equals(args[i], "-File", StringComparison.OrdinalIgnoreCase)) continue;
            try {
                if (String.Equals(Path.GetFullPath(args[i+1]), Path.GetFullPath(scriptPath), StringComparison.OrdinalIgnoreCase)) return FreeConsole();
            } catch { return false; }
        }
        // A script invoked from an existing interactive shell must leave that shell attached.
        return false;
    }
}
