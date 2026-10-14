using System;
using System.IO;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;

// Built as a Windows application: Task Scheduler never starts a console host.
internal static class StatusWatchLauncher {
    [DataContract]
    sealed class Settings { [DataMember(Name="powershell")] public string PowerShell; }
    [STAThread]
    static int Main(string[] args) {
        if (args.Length != 0) return 2;
        try {
            string directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string project = Path.GetFullPath(Path.Combine(directory, "..", ".."));
            string watcher = Path.Combine(project, "scripts", "watch.ps1");
            Settings settings;
            using (var file = File.OpenRead(Path.Combine(project, "runtime", "environment.json"))) {
                settings = (Settings)new DataContractJsonSerializer(typeof(Settings)).ReadObject(file);
            }
            string shell = settings.PowerShell;
            if (String.IsNullOrEmpty(shell) || !Path.IsPathRooted(shell)
                || !String.Equals(Path.GetFileName(shell), "pwsh.exe", StringComparison.OrdinalIgnoreCase)
                || !File.Exists(watcher) || !File.Exists(shell)) return 3;
            return SessionStatusConsole.RunHidden(shell, new string[] {
                "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned",
                "-File", watcher, "-Run"
            }, project).ExitCode;
        } catch { return 4; } // No message contents, process arguments or credentials in logs.
    }
}
