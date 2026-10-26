// biubiu AI installer. One file a user double-clicks: it asks only where to install (for the current user, so no
// administrator rights by default) and puts everything biubiu AI needs there: the companion, its local service and the
// Node.js runtime that runs the service; Microsoft's WebView2 Runtime too, where Windows lacks it. It adds Start menu and
// desktop shortcuts and an entry in Settings > Apps, can set biubiu AI to wait in the background from sign-in, and starts
// it. app/installer/package.mjs builds this file twice: with the payload it is the installer; without, Uninstall.exe,
// which removes exactly the files the installer listed. Neither touches ZCode or its configuration; the companion's own
// data folder (settings, log, site sign-in) goes only when the user ticks that in the uninstaller.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ModelHarbor.Setup
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            var options = Options.Parse(args);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                if (!Payload.Present) return Uninstall.Start(options);
                string problem = Requirements.Problem();
                if (problem != null) throw new SetupError(problem);
                if (options.Silent) return Install.Silent(options);
                Application.Run(new SetupForm(options));
                return 0;
            }
            catch (Exception e)
            {
                SetupLog.Write("stopped: " + e);
                if (!options.Silent) Look.Warn(null, e is SetupError ? e.Message : "安装程序出错了：" + e.Message + "\n详情见 " + SetupLog.LogFile);
                return 1;
            }
        }
    }

    // --silent installs (or uninstalls) without a window; --dir names the folder; --no-desktop and --no-startup leave out
    // the desktop shortcut and the start at sign-in; --update (the companion's one-click update) leaves both as they are;
    // --launch starts biubiu AI after a silent install; --remove-data has the uninstaller delete the companion's data
    // folder too. --from is the uninstaller's own copy in the temp folder.
    sealed class Options
    {
        public bool Silent, Desktop = true, Startup = true, Launch, RemoveData, Update;
        public string Dir, From;

        public static Options Parse(string[] args)
        {
            var o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                switch ((args[i] ?? "").Trim().ToLowerInvariant())
                {
                    case "--silent": o.Silent = true; break;
                    case "--dir": if (i + 1 < args.Length) o.Dir = args[++i]; break;
                    case "--no-desktop": o.Desktop = false; break;
                    case "--no-startup": o.Startup = false; break;
                    case "--launch": o.Launch = true; break;
                    case "--update": o.Update = true; break;
                    case "--remove-data": o.RemoveData = true; break;
                    case "--from": if (i + 1 < args.Length) o.From = args[++i]; break;
                }
            }
            return o;
        }
    }

    // A reason the setup stopped, in words for the user.
    sealed class SetupError : Exception
    {
        public SetupError(string message) : base(message) { }
    }

    static class Product
    {
        public const string Name = "biubiu AI";
        public const string Exe = "ModelHarbor.exe";
        public const string Uninstaller = "Uninstall.exe";
        public const string ListFile = "uninstall.list";
        public const string Link = "biubiu AI.lnk";
        public const string Tagline = "随 ZCode 显示的模型与账户助手";
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ModelHarbor";
        // The companion's own names (app/host/ModelHarbor.cs): the event that asks it to quit, its single-instance mutex,
        // its startup entry and its data folder.
        public const string QuitEvent = @"Local\ModelHarbor.Companion.Quit";
        public const string Mutex = @"Local\ModelHarbor.Companion.Instance";
        public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public const string RunValue = "ModelHarbor Companion";
        public static string DataDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ModelHarbor"); } }
        public static string DefaultDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Name); } }
        public static string ExeIn(string dir) { return Path.Combine(dir, "bin", Exe); }
        public static string StartMenuLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Link); } }
        public static string DesktopLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Link); } }
    }

    // %TEMP%\biubiu-ai-setup.log: what the installer and uninstaller did, for when something goes wrong. No keys,
    // tokens or passwords pass through either.
    static class SetupLog
    {
        public static readonly string LogFile = Path.Combine(Path.GetTempPath(), "biubiu-ai-setup.log");
        static readonly object Sync = new object();

        public static void Write(string message)
        {
            try
            {
                lock (Sync)
                {
                    var info = new FileInfo(LogFile);
                    if (info.Exists && info.Length > 1000000) info.Delete();
                    File.AppendAllText(LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch (Exception) { }
        }
    }

    // The files to install, a zip the build embeds: entries under app/ go into the install folder as they are named;
    // webview2/ holds Microsoft's WebView2 Runtime bootstrapper, run from the temp folder only where Windows lacks it.
    static class Payload
    {
        const string Resource = "payload.zip";
        public const string AppPrefix = "app/";
        public const string WebView2Setup = "webview2/MicrosoftEdgeWebview2Setup.exe";

        public static bool Present { get { return Assembly.GetExecutingAssembly().GetManifestResourceInfo(Resource) != null; } }

        public static ZipArchive Open() { return new ZipArchive(Assembly.GetExecutingAssembly().GetManifestResourceStream(Resource), ZipArchiveMode.Read); }
    }

    static class Requirements
    {
        // What stops biubiu AI from running on this Windows, in words for the user; null when nothing does.
        public static string Problem()
        {
            if (!Environment.Is64BitOperatingSystem) return "biubiu AI 需要 64 位的 Windows 10 或 Windows 11。";
            if (Environment.OSVersion.Version.Major < 10) return "biubiu AI 需要 Windows 10 或 Windows 11。";
            if (NetRelease() < 528040) return "biubiu AI 需要 .NET Framework 4.8（Windows 10 2019 年 5 月更新及以后的版本、Windows 11 都已自带）。请先通过 Windows 更新安装，或从 https://dotnet.microsoft.com/download/dotnet-framework/net48 下载安装后，再运行本程序。";
            return null;
        }

        static int NetRelease()
        {
            using (var hive = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (var key = hive.OpenSubKey(@"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full"))
            {
                object value = key == null ? null : key.GetValue("Release");
                return value is int ? (int)value : 0;
            }
        }

        // The WebView2 Runtime's version, installed for the machine or for this user; null when there is none.
        public static string WebView2()
        {
            const string client = @"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
            using (var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Default))
            {
                foreach (var found in new[] { Version(machine, @"SOFTWARE\WOW6432Node\" + client), Version(machine, @"SOFTWARE\" + client), Version(user, @"Software\" + client) })
                    if (found != null) return found;
            }
            return null;
        }

        static string Version(RegistryKey hive, string path)
        {
            using (var key = hive.OpenSubKey(path))
            {
                var value = key == null ? null : key.GetValue("pv") as string;
                return string.IsNullOrEmpty(value) || value == "0.0.0.0" ? null : value;
            }
        }
    }

    // A biubiu AI this installer put on the machine before, as Settings > Apps lists it.
    sealed class Installed
    {
        public string Dir, Version;

        public static Installed Find()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(Product.UninstallKey))
            {
                var dir = key == null ? null : key.GetValue("InstallLocation") as string;
                if (string.IsNullOrEmpty(dir) || !File.Exists(Product.ExeIn(dir))) return null;
                return new Installed { Dir = dir, Version = key.GetValue("DisplayVersion") as string };
            }
        }
    }

    static class Running
    {
        // Asks a running biubiu AI to quit, as ModelHarbor.exe --quit does, and waits until it has; true when none is left.
        public static bool Quit(int timeoutMs)
        {
            try { using (var handle = EventWaitHandle.OpenExisting(Product.QuitEvent)) handle.Set(); }
            catch (WaitHandleCannotBeOpenedException) { return !Exists(); }
            catch (UnauthorizedAccessException) { }
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < timeoutMs)
            {
                if (!Exists()) { Thread.Sleep(300); return true; }
                Thread.Sleep(100);
            }
            return !Exists();
        }

        static bool Exists()
        {
            try { using (System.Threading.Mutex.OpenExisting(Product.Mutex)) return true; }
            catch (WaitHandleCannotBeOpenedException) { return false; }
            catch (UnauthorizedAccessException) { return true; }
        }
    }

    static class Install
    {
        public sealed class Result { public string Dir, Warning; }

        // The folder biubiu AI goes in: the one given when it is new, empty or holds biubiu AI already; else, and at the
        // root of a drive, a "biubiu AI" folder inside it, so no other files share the folder the uninstaller cleans.
        public static string Folder(string chosen)
        {
            string text = Environment.ExpandEnvironmentVariables((chosen ?? "").Trim().Trim('"'));
            string full;
            try { full = Path.GetFullPath(text); }
            catch (Exception) { throw new SetupError("「" + text + "」不是有效的文件夹路径，请重新选择安装位置。"); }
            if (text.Length < 3 || text[1] != ':' || full.Length < 2 || full[1] != ':') throw new SetupError("请选择这台电脑磁盘上的文件夹，例如「" + Product.DefaultDir + "」。");
            full = full.TrimEnd('\\');
            if (full.Length <= 2) return Path.Combine(full + "\\", Product.Name);
            if (Directory.Exists(full) && !Holds(full) && !Empty(full)) return Path.Combine(full, Product.Name);
            return full;
        }

        static bool Empty(string dir)
        {
            try { return !Directory.EnumerateFileSystemEntries(dir).Any(); }
            catch (Exception) { return false; }
        }

        // A folder picked in the folder dialog gets a "biubiu AI" folder inside it, unless it is one or holds biubiu AI.
        public static string Picked(string picked)
        {
            string full = Path.GetFullPath(picked).TrimEnd('\\');
            if (Path.GetFileName(full).Equals(Product.Name, StringComparison.OrdinalIgnoreCase) || Holds(full)) return full;
            return Path.Combine(full.Length <= 2 ? full + "\\" : full, Product.Name);
        }

        public static bool Holds(string dir) { return File.Exists(Path.Combine(dir, Product.ListFile)) || File.Exists(Product.ExeIn(dir)); }

        // Without a choice (null), the desktop shortcut and the start at sign-in stay as they are.
        public static Result Run(string dir, bool? desktop, bool? startup, Action<int, string> report)
        {
            SetupLog.Write("install " + Release.Version + " to " + dir);
            Uninstall.CleanTemp();
            report(2, "正在准备…");
            EnsureWritable(dir);
            report(5, "正在关闭正在运行的 biubiu AI…");
            if (!Running.Quit(15000)) throw new SetupError("biubiu AI 正在运行，没能让它退出。请右键任务栏右下角的 biubiu AI 图标，选择「退出 biubiu AI」，再重新安装。");
            var before = ReadList(dir);
            var installed = new List<string>();
            long bytes = 0;
            using (var zip = Payload.Open())
            {
                var files = zip.Entries.Where(e => e.FullName.StartsWith(Payload.AppPrefix, StringComparison.Ordinal) && e.Name.Length > 0).ToList();
                long total = Math.Max(1, files.Sum(e => e.Length)), done = 0;
                foreach (var entry in files)
                {
                    string relative = entry.FullName.Substring(Payload.AppPrefix.Length).Replace('/', '\\');
                    string target = Inside(dir, relative);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    Extract(entry, target);
                    installed.Add(relative);
                    done += entry.Length;
                    report(8 + (int)(70 * done / total), "正在复制文件…");
                }
                bytes = total;
            }
            // Files an earlier version installed that this one no longer has.
            foreach (var relative in before.Except(installed, StringComparer.OrdinalIgnoreCase).Where(r => !r.Equals(Product.ListFile, StringComparison.OrdinalIgnoreCase)))
                TryDelete(Inside(dir, relative));
            installed.Add(Product.ListFile);
            WriteList(dir, installed);
            report(80, "正在检查 WebView2 运行时…");
            string warning = EnsureWebView2(report);
            report(92, "正在创建快捷方式…");
            string exe = Product.ExeIn(dir);
            Shortcut.Create(Product.StartMenuLink, exe);
            if (desktop == true) Shortcut.Create(Product.DesktopLink, exe);
            else if (desktop == false && Shortcut.PointsInto(Product.DesktopLink, dir)) TryDelete(Product.DesktopLink);
            Register(dir, bytes);
            report(96, "正在设置开机后台待命…");
            if (startup == true) RunQuiet(exe, "--install-startup");
            else if (startup == false && StartupPointsInto(dir)) RunQuiet(exe, "--uninstall-startup");
            report(100, "安装完成");
            SetupLog.Write("installed" + (warning != null ? "; WebView2 Runtime still missing" : ""));
            return new Result { Dir = dir, Warning = warning };
        }

        public static int Silent(Options o)
        {
            var installed = Installed.Find();
            string dir = Folder(o.Dir ?? (installed != null ? installed.Dir : Product.DefaultDir));
            if (o.Update) SetupLog.Write("update from biubiu AI: the desktop shortcut and the start at sign-in stay as they are");
            Run(dir, o.Update ? (bool?)null : o.Desktop, o.Update ? (bool?)null : o.Startup, (percent, text) => { });
            if (o.Launch) Launch(dir);
            return 0;
        }

        // An installer the user started as administrator, through a UAC prompt, starts biubiu AI through Explorer, so it
        // runs unelevated. Without such a prompt (UAC off, or the built-in Administrator) Explorer has the same rights, so
        // it starts biubiu AI itself, which keeps the environment it was given, as the companion's own update relies on.
        public static void Launch(string dir)
        {
            string exe = Product.ExeIn(dir);
            if (ElevatedByPrompt()) Process.Start(new ProcessStartInfo("explorer.exe", "\"" + exe + "\"") { UseShellExecute = false });
            else Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe) });
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);

        // The elevated half of a split token (TokenElevationType is TokenElevationTypeFull), which only a UAC prompt gives.
        static bool ElevatedByPrompt()
        {
            const int TokenElevationType = 18, TokenElevationTypeFull = 2;
            int type, returned;
            using (var identity = WindowsIdentity.GetCurrent())
                return GetTokenInformation(identity.Token, TokenElevationType, out type, sizeof(int), out returned) && type == TokenElevationTypeFull;
        }

        static void EnsureWritable(string dir)
        {
            try
            {
                Directory.CreateDirectory(dir);
                string probe = Path.Combine(dir, ".biubiu-setup-" + Guid.NewGuid().ToString("N"));
                File.WriteAllText(probe, "");
                File.Delete(probe);
            }
            catch (UnauthorizedAccessException) { throw new SetupError("没有权限写入「" + dir + "」。请换一个安装位置（例如默认的「" + Product.DefaultDir + "」），或右键安装程序选择「以管理员身份运行」。"); }
            catch (IOException e) { throw new SetupError("无法写入「" + dir + "」：" + e.Message); }
        }

        static void Extract(ZipArchiveEntry entry, string target)
        {
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    if (File.Exists(target)) File.SetAttributes(target, FileAttributes.Normal);
                    using (var input = entry.Open())
                    using (var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                        input.CopyTo(output);
                    return;
                }
                // A program that is still exiting, or a virus scanner, may hold the file for a moment.
                catch (IOException) when (attempt < 40) { Thread.Sleep(250); }
                catch (UnauthorizedAccessException) when (attempt < 40 && File.Exists(target)) { Thread.Sleep(250); }
            }
        }

        public static void ExtractTo(string entryName, string target)
        {
            using (var zip = Payload.Open())
            {
                var entry = zip.GetEntry(entryName);
                if (entry == null) throw new FileNotFoundException(entryName);
                Extract(entry, target);
            }
        }

        // The path of a listed file, refused when it would leave the install folder.
        public static string Inside(string dir, string relative)
        {
            string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            string full = Path.GetFullPath(Path.Combine(root, relative));
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("a file outside the install folder: " + relative);
            return full;
        }

        public static List<string> ReadList(string dir)
        {
            string file = Path.Combine(dir, Product.ListFile);
            if (!File.Exists(file)) return new List<string>();
            return File.ReadAllLines(file, Encoding.UTF8).Select(l => l.Trim()).Where(l => l.Length > 0 && !l.StartsWith("#", StringComparison.Ordinal)).ToList();
        }

        static void WriteList(string dir, IEnumerable<string> files)
        {
            var lines = new[] { "# biubiu AI " + Release.Version + ": the files the installer put here, which Uninstall.exe removes." }.Concat(files);
            File.WriteAllLines(Path.Combine(dir, Product.ListFile), lines, new UTF8Encoding(false));
        }

        public static void TryDelete(string file)
        {
            for (int attempt = 0; attempt < 40; attempt++)
            {
                try
                {
                    if (File.Exists(file)) { File.SetAttributes(file, FileAttributes.Normal); File.Delete(file); }
                    return;
                }
                catch (IOException) { Thread.Sleep(250); }
                catch (UnauthorizedAccessException) { Thread.Sleep(250); }
            }
            SetupLog.Write("could not delete " + file);
        }

        // Microsoft's bootstrapper fetches the runtime and installs it for this user (for the machine when elevated).
        static string EnsureWebView2(Action<int, string> report)
        {
            string version = Requirements.WebView2();
            if (version != null) { SetupLog.Write("WebView2 Runtime " + version); return null; }
            report(82, "正在安装 Microsoft Edge WebView2 运行时（需要联网，可能要几分钟）…");
            string temp = Path.Combine(Path.GetTempPath(), "biubiu-ai-webview2-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(temp);
                string setup = Path.Combine(temp, "MicrosoftEdgeWebview2Setup.exe");
                ExtractTo(Payload.WebView2Setup, setup);
                using (var process = Process.Start(new ProcessStartInfo(setup, "/silent /install") { UseShellExecute = false, CreateNoWindow = true }))
                {
                    if (process.WaitForExit(15 * 60 * 1000)) SetupLog.Write("WebView2 bootstrapper exited with " + process.ExitCode);
                    else { SetupLog.Write("WebView2 bootstrapper did not finish in 15 minutes"); try { process.Kill(); } catch (Exception) { } }
                }
            }
            catch (Exception e) { SetupLog.Write("WebView2 bootstrapper failed: " + e.Message); }
            finally { try { Directory.Delete(temp, true); } catch (Exception) { } }
            if (Requirements.WebView2() != null) return null;
            return "Microsoft Edge WebView2 运行时没有装上（可能是没有联网）。biubiu AI 已经装好，但要有这个运行时才能显示面板：请联网后再运行一次安装程序，或到 https://go.microsoft.com/fwlink/p/?LinkId=2124703 下载安装。";
        }

        static void Register(string dir, long bytes)
        {
            string uninstaller = Path.Combine(dir, Product.Uninstaller);
            using (var key = Registry.CurrentUser.CreateSubKey(Product.UninstallKey))
            {
                key.SetValue("DisplayName", Product.Name);
                key.SetValue("DisplayVersion", Release.Version);
                key.SetValue("Publisher", Product.Name);
                key.SetValue("DisplayIcon", Product.ExeIn(dir));
                key.SetValue("InstallLocation", dir);
                key.SetValue("UninstallString", "\"" + uninstaller + "\"");
                key.SetValue("QuietUninstallString", "\"" + uninstaller + "\" --silent");
                key.SetValue("URLInfoAbout", "https://ro.biubiu007.com");
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture));
                key.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, bytes / 1024), RegistryValueKind.DWord);
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        // The companion's own startup entry (ModelHarbor.exe --install-startup writes it), so its tray switch shows it.
        public static bool StartupPointsInto(string dir)
        {
            using (var key = Registry.CurrentUser.OpenSubKey(Product.RunKey))
            {
                var value = key == null ? null : key.GetValue(Product.RunValue) as string;
                return value != null && value.IndexOf(Product.ExeIn(dir), StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }

        public static void RunQuiet(string exe, string arguments)
        {
            try
            {
                using (var process = Process.Start(new ProcessStartInfo(exe, arguments) { UseShellExecute = false, CreateNoWindow = true }))
                    if (!process.WaitForExit(30000)) SetupLog.Write(Path.GetFileName(exe) + " " + arguments + " did not finish");
            }
            catch (Exception e) { SetupLog.Write(Path.GetFileName(exe) + " " + arguments + " failed: " + e.Message); }
        }
    }

    static class Uninstall
    {
        // Windows cannot delete a running program, so Uninstall.exe hands over to a copy of itself in the temp folder.
        public static int Start(Options o)
        {
            if (o.From == null)
            {
                string here = Path.GetDirectoryName(Path.GetFullPath(Application.ExecutablePath));
                string copy = Path.Combine(Path.GetTempPath(), "biubiu-ai-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 12) + ".exe");
                File.Copy(Application.ExecutablePath, copy);
                string arguments = "--from \"" + here + "\"" + (o.Silent ? " --silent" : "") + (o.RemoveData ? " --remove-data" : "");
                Process.Start(new ProcessStartInfo(copy, arguments) { UseShellExecute = false, WorkingDirectory = Path.GetTempPath() });
                return 0;
            }
            string dir = Path.GetFullPath(o.From).TrimEnd('\\');
            CleanTemp();
            if (!Install.Holds(dir))
            {
                if (!o.Silent) Look.Warn(null, "「" + dir + "」里没有 biubiu AI。");
                return 1;
            }
            if (o.Silent) { Run(dir, o.RemoveData, (percent, text) => { }); return 0; }
            Application.Run(new UninstallForm(dir));
            return 0;
        }

        // The uninstaller's copies from earlier uninstalls, which could not delete themselves.
        public static void CleanTemp()
        {
            string self = Path.GetFullPath(Application.ExecutablePath);
            try
            {
                foreach (var file in Directory.GetFiles(Path.GetTempPath(), "biubiu-ai-uninstall-*.exe"))
                    if (!file.Equals(self, StringComparison.OrdinalIgnoreCase)) try { File.Delete(file); } catch (Exception) { }
            }
            catch (Exception) { }
        }

        public static void Run(string dir, bool removeData, Action<int, string> report)
        {
            SetupLog.Write("uninstall from " + dir + (removeData ? " with the data folder" : ""));
            report(5, "正在关闭 biubiu AI…");
            if (!Running.Quit(15000)) throw new SetupError("biubiu AI 正在运行，没能让它退出。请右键任务栏右下角的 biubiu AI 图标，选择「退出 biubiu AI」，再卸载。");
            string exe = Product.ExeIn(dir);
            report(15, "正在移除开机后台待命…");
            if (File.Exists(exe) && Install.StartupPointsInto(dir)) Install.RunQuiet(exe, "--uninstall-startup");
            report(25, "正在删除快捷方式…");
            foreach (var link in new[] { Product.StartMenuLink, Product.DesktopLink })
                if (Shortcut.PointsInto(link, dir)) Install.TryDelete(link);
            report(35, "正在删除程序文件…");
            var listed = Install.ReadList(dir);
            // Without its list (an install that was cut short), only the names this installer uses go.
            if (listed.Count == 0) listed = KnownFiles(dir);
            listed = listed.Where(relative => Valid(dir, relative)).ToList();
            int done = 0;
            foreach (var relative in listed)
            {
                Install.TryDelete(Install.Inside(dir, relative));
                report(35 + 50 * ++done / Math.Max(1, listed.Count), "正在删除程序文件…");
            }
            RemoveEmptyFolders(dir, listed);
            using (var key = Registry.CurrentUser.OpenSubKey(Product.UninstallKey))
            {
                var location = key == null ? null : key.GetValue("InstallLocation") as string;
                if (location != null && Path.GetFullPath(location).TrimEnd('\\').Equals(dir, StringComparison.OrdinalIgnoreCase))
                {
                    key.Close();
                    Registry.CurrentUser.DeleteSubKeyTree(Product.UninstallKey, false);
                }
            }
            if (removeData)
            {
                report(92, "正在删除设置与登录状态…");
                try { if (Directory.Exists(Product.DataDir)) Directory.Delete(Product.DataDir, true); }
                catch (Exception e) { SetupLog.Write("data folder kept: " + e.Message); }
            }
            report(100, "已卸载");
            SetupLog.Write("uninstalled");
        }

        static bool Valid(string dir, string relative)
        {
            try { Install.Inside(dir, relative); return true; }
            catch (Exception) { SetupLog.Write("skipped a listed file outside the folder: " + relative); return false; }
        }

        static List<string> KnownFiles(string dir)
        {
            var files = new List<string> { Product.Uninstaller, Product.ListFile, "server.mjs" };
            foreach (var sub in new[] { "bin", "lib", "node" })
            {
                string folder = Path.Combine(dir, sub);
                if (Directory.Exists(folder)) files.AddRange(Directory.GetFiles(folder, "*", SearchOption.AllDirectories).Select(f => f.Substring(dir.Length + 1)));
            }
            return files;
        }

        static void RemoveEmptyFolders(string dir, IEnumerable<string> listed)
        {
            var folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var relative in listed)
                for (string folder = Path.GetDirectoryName(Install.Inside(dir, relative)); folder.Length > dir.Length; folder = Path.GetDirectoryName(folder))
                    folders.Add(folder);
            folders.Add(dir);
            foreach (var folder in folders.OrderByDescending(f => f.Length))
            {
                try { if (Directory.Exists(folder) && !Directory.EnumerateFileSystemEntries(folder).Any()) Directory.Delete(folder); }
                catch (Exception e) { SetupLog.Write("folder kept: " + folder + " (" + e.Message + ")"); }
            }
        }
    }

    static class Shortcut
    {
        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        class ShellLink { }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
        interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int size, IntPtr data, uint flags);
            void GetIDList(out IntPtr list);
            void SetIDList(IntPtr list);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int size);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int size);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int size);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
            void GetHotkey(out short key);
            void SetHotkey(short key);
            void GetShowCmd(out int show);
            void SetShowCmd(int show);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, out int index);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
            void Resolve(IntPtr window, uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
        }

        public static void Create(string link, string target)
        {
            var shell = (IShellLinkW)new ShellLink();
            try
            {
                shell.SetPath(target);
                shell.SetWorkingDirectory(Path.GetDirectoryName(target));
                shell.SetDescription(Product.Name + "：" + Product.Tagline);
                shell.SetIconLocation(target, 0);
                Directory.CreateDirectory(Path.GetDirectoryName(link));
                ((IPersistFile)shell).Save(link, true);
            }
            finally { Marshal.ReleaseComObject(shell); }
        }

        // Whether the shortcut opens a program inside dir; false when there is none, or it cannot be read.
        public static bool PointsInto(string link, string dir)
        {
            if (!File.Exists(link)) return false;
            var shell = (IShellLinkW)new ShellLink();
            try
            {
                ((IPersistFile)shell).Load(link, 0);
                var target = new StringBuilder(1024);
                shell.GetPath(target, target.Capacity, IntPtr.Zero, 0);
                return target.ToString().StartsWith(Path.GetFullPath(dir).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception) { return false; }
            finally { Marshal.ReleaseComObject(shell); }
        }
    }

    // Windows' own folder dialog (the one Explorer uses), or the older tree dialog where that is unavailable.
    static class FolderPicker
    {
        [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
        class FileOpenDialog { }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
        interface IFileDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint count, IntPtr specs);
            void SetFileTypeIndex(uint index);
            void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder(IShellItem item);
            void SetFolder(IShellItem item);
            void GetFolder(out IShellItem item);
            void GetCurrentSelection(out IShellItem item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void GetResult(out IShellItem item);
            void AddPlace(IShellItem item, int place);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
            void Close(int result);
            void SetClientGuid(ref Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr filter);
        }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
        interface IShellItem
        {
            void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
            void GetParent(out IShellItem parent);
            void GetDisplayName(uint kind, [MarshalAs(UnmanagedType.LPWStr)] out string name);
            void GetAttributes(uint mask, out uint attributes);
            void Compare(IShellItem other, uint hint, out int order);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);

        const uint PickFolders = 0x20, ForceFileSystem = 0x40, PathMustExist = 0x800, FileSystemPath = 0x80058000;

        // The folder the user picks, opening at start or its nearest existing parent; null when cancelled.
        public static string Pick(IWin32Window owner, string start)
        {
            IFileDialog dialog;
            try { dialog = (IFileDialog)new FileOpenDialog(); }
            catch (Exception) { return Legacy(owner, start); }
            try
            {
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | PickFolders | ForceFileSystem | PathMustExist);
                dialog.SetTitle("选择安装位置");
                dialog.SetOkButtonLabel("选择此文件夹");
                string existing = NearestExisting(start);
                if (existing != null)
                {
                    try
                    {
                        Guid iid = typeof(IShellItem).GUID;
                        IShellItem folder;
                        SHCreateItemFromParsingName(existing, IntPtr.Zero, ref iid, out folder);
                        dialog.SetFolder(folder);
                    }
                    catch (Exception) { }
                }
                if (dialog.Show(owner == null ? IntPtr.Zero : owner.Handle) != 0) return null;
                IShellItem result;
                dialog.GetResult(out result);
                string path;
                result.GetDisplayName(FileSystemPath, out path);
                return path;
            }
            catch (COMException) { return Legacy(owner, start); }
            finally { Marshal.ReleaseComObject(dialog); }
        }

        static string Legacy(IWin32Window owner, string start)
        {
            using (var dialog = new FolderBrowserDialog { Description = "选择安装位置", ShowNewFolderButton = true, SelectedPath = NearestExisting(start) ?? "" })
                return dialog.ShowDialog(owner) == DialogResult.OK ? dialog.SelectedPath : null;
        }

        static string NearestExisting(string path)
        {
            try { for (var dir = new DirectoryInfo(Path.GetFullPath(path)); dir != null; dir = dir.Parent) if (dir.Exists) return dir.FullName; }
            catch (Exception) { }
            return null;
        }
    }

    // The panel's look: paper and ink, small rounded corners, serif for the name.
    static class Look
    {
        public static readonly Color Paper = Color.FromArgb(0xf9, 0xf8, 0xf6), Ink = Color.FromArgb(0x1c, 0x1c, 0x1c);
        public static readonly Color Muted = Mix(0.66), Edge = Mix(0.45), Line = Mix(0.12), Hover = Mix(0.06), InkHover = Mix(0.86);
        public static readonly Color Accent = Color.FromArgb(0xc2, 0x41, 0x0c);
        public static readonly Font Body = new Font("Microsoft YaHei UI", 9.75f), Small = new Font("Microsoft YaHei UI", 9f);
        public static readonly Font Heading = new Font("Microsoft YaHei UI", 14f), Title = Serif(22f);

        static Color Mix(double ink)
        {
            return Color.FromArgb((int)Math.Round(Paper.R + (Ink.R - Paper.R) * ink), (int)Math.Round(Paper.G + (Ink.G - Paper.G) * ink), (int)Math.Round(Paper.B + (Ink.B - Paper.B) * ink));
        }

        static Font Serif(float size)
        {
            foreach (var name in new[] { "Sitka Heading", "Georgia" })
            {
                var font = new Font(name, size);
                if (font.Name == name) return font;
                font.Dispose();
            }
            return new Font("Microsoft YaHei UI", size);
        }

        public static void Warn(IWin32Window owner, string text) { MessageBox.Show(owner, text, Product.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning); }

        static Stream Resource(string name) { return Assembly.GetExecutingAssembly().GetManifestResourceStream(name); }

        public static Icon AppIcon()
        {
            try { using (var stream = Resource("biubiu.ico")) return stream == null ? null : new Icon(stream); }
            catch (Exception) { return null; }
        }

        public static Image Logo()
        {
            try { using (var stream = Resource("logo.png")) using (var image = Image.FromStream(stream)) return new Bitmap(image); }
            catch (Exception) { return null; }
        }

        public static GraphicsPath Rounded(RectangleF r, float radius)
        {
            float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            var path = new GraphicsPath();
            if (d <= 0) { path.AddRectangle(r); return path; }
            path.AddArc(r.Left, r.Top, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        public static Label Text(string text, Font font, Color color, int x, int y, int width, int height)
        {
            return new Label { Text = text, Font = font, ForeColor = color, BackColor = Paper, AutoSize = false, Bounds = new Rectangle(x, y, width, height), UseMnemonic = false };
        }
    }

    // A button like the panel's: ink with paper text for the main action, outlined for the others.
    sealed class Pill : Button
    {
        public bool Primary;
        bool hover;

        public Pill()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            Cursor = Cursors.Hand;
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Look.Paper);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Look.Rounded(new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f), Height * 0.2f))
            {
                Color fill = Primary ? (!Enabled ? Look.Edge : hover ? Look.InkHover : Look.Ink) : hover ? Look.Hover : Look.Paper;
                using (var brush = new SolidBrush(fill)) g.FillPath(brush, path);
                if (!Primary) using (var pen = new Pen(Focused ? Look.Ink : Look.Edge, 1f)) g.DrawPath(pen, path);
            }
            if (Primary && Focused && ShowFocusCues)
                using (var path = Look.Rounded(new RectangleF(3.5f, 3.5f, Width - 7f, Height - 7f), Height * 0.14f))
                using (var pen = new Pen(Look.Paper, 1f) { DashStyle = DashStyle.Dot }) g.DrawPath(pen, path);
            TextRenderer.DrawText(g, Text, Font, ClientRectangle, Primary ? Look.Paper : Enabled ? Look.Ink : Look.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
    }

    // A check box like the panel's: a small rounded square, filled with ink and a paper tick when on.
    sealed class Tick : CheckBox
    {
        public Tick()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            Cursor = Cursors.Hand;
            AutoSize = false;
            BackColor = Look.Paper;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Look.Paper);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float box = Font.Height * 0.9f, top = (Height - box) / 2f;
            var r = new RectangleF(1.5f, top, box, box);
            using (var path = Look.Rounded(r, box * 0.22f))
            {
                if (Checked) using (var brush = new SolidBrush(Look.Ink)) g.FillPath(brush, path);
                using (var pen = new Pen(Checked || Focused ? Look.Ink : Look.Edge, 1.2f)) g.DrawPath(pen, path);
            }
            if (Checked)
                using (var pen = new Pen(Look.Paper, Math.Max(1.5f, box * 0.13f)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                    g.DrawLines(pen, new[] { new PointF(r.Left + box * 0.26f, r.Top + box * 0.52f), new PointF(r.Left + box * 0.44f, r.Top + box * 0.7f), new PointF(r.Left + box * 0.76f, r.Top + box * 0.32f) });
            int left = (int)(box + Font.Height * 0.6f);
            TextRenderer.DrawText(g, Text, Font, new Rectangle(left, 0, Width - left, Height), Look.Ink, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPrefix);
        }
    }

    // A thin progress line: ink over a faint track.
    sealed class Bar : Control
    {
        int value;
        public int Value { get { return value; } set { this.value = Math.Max(0, Math.Min(100, value)); Invalidate(); } }

        public Bar() { SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Look.Paper);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float h = Height - 1f;
            using (var path = Look.Rounded(new RectangleF(0.5f, 0.5f, Width - 1f, h), h / 2f)) using (var brush = new SolidBrush(Look.Line)) g.FillPath(brush, path);
            float w = (Width - 1f) * value / 100f;
            if (w >= h) using (var path = Look.Rounded(new RectangleF(0.5f, 0.5f, w, h), h / 2f)) using (var brush = new SolidBrush(Look.Ink)) g.FillPath(brush, path);
        }
    }

    // The install folder: a text box with only a bottom line, as the panel's inputs have.
    sealed class PathBox : Control
    {
        public readonly TextBox Box = new TextBox { BorderStyle = BorderStyle.None };

        public PathBox()
        {
            SetStyle(ControlStyles.ResizeRedraw, true);
            BackColor = Look.Paper;
            Box.BackColor = Look.Paper;
            Box.ForeColor = Look.Ink;
            Box.GotFocus += (s, e) => Invalidate();
            Box.LostFocus += (s, e) => Invalidate();
            Controls.Add(Box);
        }

        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e);
            Box.SetBounds(0, Math.Max(0, (Height - Box.PreferredHeight) / 2 - 1), Width, Box.PreferredHeight);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            using (var pen = new Pen(Box.Focused ? Look.Ink : Look.Edge, 1f)) e.Graphics.DrawLine(pen, 0, Height - 1, Width, Height - 1);
        }
    }

    // A window of a few pages, one shown at a time, laid out at 96 DPI and scaled by Windows' display setting.
    class Wizard : Form
    {
        protected bool Busy;

        protected Wizard(string title)
        {
            SuspendLayout();
            Text = title;
            Icon = Look.AppIcon();
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96f, 96f);
            BackColor = Look.Paper;
            ForeColor = Look.Ink;
            Font = Look.Body;
            ClientSize = new Size(560, 372);
        }

        protected Panel Page()
        {
            var page = new Panel { Dock = DockStyle.Fill, BackColor = Look.Paper, Visible = false };
            Controls.Add(page);
            return page;
        }

        protected void ShowPage(Panel page, Control focus)
        {
            page.Visible = true;
            foreach (Control c in Controls) if (c is Panel && c != page) c.Visible = false;
            if (focus != null) focus.Select();
        }

        protected Pill AddButton(Panel page, string text, bool primary, int x, Action click)
        {
            var button = new Pill { Text = text, Primary = primary, Bounds = new Rectangle(x, 314, 96, 36) };
            button.Click += (s, e) => click();
            page.Controls.Add(button);
            return button;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (Busy && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; return; }
            base.OnFormClosing(e);
        }
    }

    sealed class SetupForm : Wizard
    {
        readonly Panel choose, working, done;
        readonly PathBox folder = new PathBox { Bounds = new Rectangle(32, 142, 404, 30) };
        readonly Tick desktop = new Tick { Text = "在桌面创建快捷方式", Bounds = new Rectangle(32, 226, 496, 26) };
        readonly Tick startup = new Tick { Text = "登录 Windows 后在后台待命，打开 ZCode 时自动出现", Bounds = new Rectangle(32, 256, 496, 26) };
        readonly Tick launch = new Tick { Text = "现在启动 biubiu AI", Checked = true, Bounds = new Rectangle(32, 262, 496, 26) };
        readonly Bar bar = new Bar { Bounds = new Rectangle(32, 156, 496, 7) };
        readonly Label status, location, warning;
        readonly Pill install, finish;
        string dir;

        public SetupForm(Options options) : base("安装 biubiu AI")
        {
            var installed = Installed.Find();
            choose = Page(); working = Page(); done = Page();

            var logo = new PictureBox { Image = Look.Logo(), SizeMode = PictureBoxSizeMode.Zoom, Bounds = new Rectangle(32, 28, 52, 52), BackColor = Look.Paper };
            choose.Controls.Add(logo);
            choose.Controls.Add(Look.Text(Product.Name, Look.Title, Look.Ink, 96, 24, 400, 42));
            choose.Controls.Add(Look.Text("版本 " + Release.Version + " · " + Product.Tagline, Look.Small, Look.Muted, 98, 64, 430, 22));
            choose.Controls.Add(Look.Text("安装位置", Look.Body, Look.Ink, 32, 116, 200, 22));
            folder.Font = Look.Body;
            folder.Box.Text = Install.Folder(options.Dir ?? (installed != null ? installed.Dir : Product.DefaultDir));
            choose.Controls.Add(folder);
            var browse = new Pill { Text = "更改…", Bounds = new Rectangle(448, 140, 80, 32) };
            browse.Click += (s, e) => { string picked = FolderPicker.Pick(this, folder.Box.Text); if (picked != null) folder.Box.Text = Install.Picked(picked); };
            choose.Controls.Add(browse);
            string note = "装在当前 Windows 用户名下，不需要管理员权限，约占 100 MB。需要的运行环境会一起装好。";
            if (installed != null && installed.Version != null) note = "已安装 " + installed.Version + "，将" + (installed.Version == Release.Version ? "重新安装" : "更新到 " + Release.Version) + "；设置和网站登录状态都会保留。";
            choose.Controls.Add(Look.Text(note, Look.Small, Look.Muted, 32, 178, 496, 40));
            desktop.Font = Look.Body; startup.Font = Look.Body;
            desktop.Checked = installed == null ? options.Desktop : Shortcut.PointsInto(Product.DesktopLink, installed.Dir);
            startup.Checked = installed == null ? options.Startup : Install.StartupPointsInto(installed.Dir);
            choose.Controls.Add(desktop);
            choose.Controls.Add(startup);
            AddButton(choose, "取消", false, 324, Close);
            install = AddButton(choose, "安装", true, 432, Begin);
            AcceptButton = install;

            working.Controls.Add(Look.Text("正在安装 biubiu AI", Look.Heading, Look.Ink, 32, 40, 496, 34));
            working.Controls.Add(Look.Text("请稍候，装好后可以直接启动。", Look.Body, Look.Muted, 32, 82, 496, 24));
            working.Controls.Add(bar);
            status = Look.Text("", Look.Small, Look.Muted, 32, 172, 496, 44);
            working.Controls.Add(status);

            done.Controls.Add(Look.Text("安装完成", Look.Heading, Look.Ink, 32, 40, 496, 34));
            done.Controls.Add(Look.Text("打开 ZCode 后，biubiu AI 会贴在 ZCode 窗口的侧边；也可以从开始菜单打开它。", Look.Body, Look.Ink, 32, 84, 496, 48));
            location = Look.Text("", Look.Small, Look.Muted, 32, 138, 496, 56);
            warning = Look.Text("", Look.Small, Look.Accent, 32, 198, 496, 58);
            done.Controls.Add(location);
            done.Controls.Add(warning);
            launch.Font = Look.Body;
            done.Controls.Add(launch);
            finish = AddButton(done, "完成", true, 432, Finish);

            ShowPage(choose, install);
            ResumeLayout(false);
        }

        void Begin()
        {
            string target;
            try { target = Install.Folder(folder.Box.Text); }
            catch (SetupError e) { Look.Warn(this, e.Message); return; }
            folder.Box.Text = target;
            dir = target;
            bool withDesktop = desktop.Checked, withStartup = startup.Checked;
            Busy = true;
            ShowPage(working, null);
            Task.Run(() => Install.Run(target, withDesktop, withStartup, (percent, text) => BeginInvoke((Action)(() => { bar.Value = percent; status.Text = text; }))))
                .ContinueWith(t => BeginInvoke((Action)(() => Finished(t))));
        }

        void Finished(Task<Install.Result> task)
        {
            Busy = false;
            if (task.IsFaulted)
            {
                var error = task.Exception.GetBaseException();
                SetupLog.Write("install failed: " + error);
                Look.Warn(this, error is SetupError ? error.Message : "安装没有完成：" + error.Message + "\n详情见 " + SetupLog.LogFile);
                ShowPage(choose, install);
                return;
            }
            location.Text = "安装位置：" + task.Result.Dir;
            warning.Text = task.Result.Warning ?? "";
            ShowPage(done, finish);
        }

        void Finish()
        {
            if (launch.Checked)
            {
                try { Install.Launch(dir); }
                catch (Exception e) { Look.Warn(this, "biubiu AI 没有启动：" + e.Message); }
            }
            Close();
        }
    }

    sealed class UninstallForm : Wizard
    {
        readonly Panel confirm, working, done;
        readonly Tick removeData = new Tick { Text = "同时删除 biubiu AI 的设置、日志和网站登录状态", Bounds = new Rectangle(32, 200, 496, 26) };
        readonly Bar bar = new Bar { Bounds = new Rectangle(32, 156, 496, 7) };
        readonly Label status;
        readonly Pill uninstall, finish;
        readonly string dir;

        public UninstallForm(string dir) : base("卸载 biubiu AI")
        {
            this.dir = dir;
            confirm = Page(); working = Page(); done = Page();

            confirm.Controls.Add(Look.Text("卸载 biubiu AI", Look.Heading, Look.Ink, 32, 40, 496, 34));
            confirm.Controls.Add(Look.Text("将删除「" + dir + "」里的 biubiu AI、开始菜单和桌面上的快捷方式，以及登录 Windows 后的后台待命。ZCode 和它的模型配置不受影响。", Look.Body, Look.Ink, 32, 84, 496, 96));
            removeData.Font = Look.Body;
            confirm.Controls.Add(removeData);
            AddButton(confirm, "取消", false, 324, Close);
            uninstall = AddButton(confirm, "卸载", true, 432, Begin);

            working.Controls.Add(Look.Text("正在卸载 biubiu AI", Look.Heading, Look.Ink, 32, 40, 496, 34));
            working.Controls.Add(bar);
            status = Look.Text("", Look.Small, Look.Muted, 32, 172, 496, 44);
            working.Controls.Add(status);

            done.Controls.Add(Look.Text("已卸载", Look.Heading, Look.Ink, 32, 40, 496, 34));
            done.Controls.Add(Look.Text("biubiu AI 已从这台电脑移除。", Look.Body, Look.Ink, 32, 84, 496, 60));
            finish = AddButton(done, "完成", true, 432, Close);

            ShowPage(confirm, uninstall);
            ResumeLayout(false);
        }

        void Begin()
        {
            bool withData = removeData.Checked;
            Busy = true;
            ShowPage(working, null);
            Task.Run(() => Uninstall.Run(dir, withData, (percent, text) => BeginInvoke((Action)(() => { bar.Value = percent; status.Text = text; }))))
                .ContinueWith(t => BeginInvoke((Action)(() =>
                {
                    Busy = false;
                    if (t.IsFaulted)
                    {
                        var error = t.Exception.GetBaseException();
                        SetupLog.Write("uninstall failed: " + error);
                        Look.Warn(this, error is SetupError ? error.Message : "卸载没有完成：" + error.Message + "\n详情见 " + SetupLog.LogFile);
                        ShowPage(confirm, uninstall);
                        return;
                    }
                    ShowPage(done, finish);
                })));
        }
    }
}
