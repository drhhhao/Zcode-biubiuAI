// biubiu AI desktop companion. Its internal names (namespace ModelHarbor, ModelHarbor.exe, MODEL_HARBOR_* variables,
// the ModelHarbor data folder and the startup entry) keep the project's English working name, so settings, the saved
// sign-in and the startup entry carry over; nothing the user sees uses it.
// A borderless WebView2 panel docked beside the ZCode main window: it sits outside ZCode's edge,
// follows every move and resize, hides while ZCode is maximized or minimized, and collapses to a
// small tab on ZCode's edge. It only reads ZCode's window position, state and a few pixels for the
// theme; it never injects into, writes to or changes ZCode.
// The panel talks to app/server.mjs, a Node process bound to 127.0.0.1 and owned by a job object.
// The host hands Node a DPAPI-protected key for the site sign-in it saves (see SessionKey), and opens the
// site signed in, in a window of its own (see SiteForm), with access tokens Node hands over its stdin pipe.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("biubiu AI")]
[assembly: System.Reflection.AssemblyProduct("biubiu AI")]
[assembly: System.Reflection.AssemblyVersion("0.8.9.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.8.9.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.8.9")]
// build/companion-dev/SiteWindowCheck drives the site window against a stand-in site.
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("SiteWindowCheck")]

namespace ModelHarbor
{
    static class Program
    {
        public const string Version = "0.8.9";
        public const string ShowEventName = @"Local\ModelHarbor.Companion.Show";
        public const string QuitEventName = @"Local\ModelHarbor.Companion.Quit";
        public const string CollapseEventName = @"Local\ModelHarbor.Companion.Collapse";
        public const string ExpandEventName = @"Local\ModelHarbor.Companion.Expand";
        public const string CheckUpdateEventName = @"Local\ModelHarbor.Companion.CheckUpdate";
        const string MutexName = @"Local\ModelHarbor.Companion.Instance";

        [STAThread]
        static int Main(string[] args)
        {
            var options = Options.Parse(args);
            if (options.InstallStartup) { Startup.Enable(); return 0; }
            if (options.UninstallStartup) { Startup.Disable(); return 0; }
            if (options.Quit) return QuitRunningInstance() ? 0 : 1;
            if (options.Collapse) return Signal(CollapseEventName) ? 0 : 1;
            if (options.Expand) return Signal(ExpandEventName) ? 0 : 1;
            // As the tray's 检查更新: the running companion looks now and, with a newer version, asks to update.
            if (options.CheckUpdate) { Native.AllowSetForegroundWindow(Native.ASFW_ANY); return Signal(CheckUpdateEventName) ? 0 : 1; }

            Native.EnableDpiAwareness();
            bool created;
            using (var mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    if (!options.Background) { Native.AllowSetForegroundWindow(Native.ASFW_ANY); Signal(ShowEventName); }
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += (s, e) => Log.Write("ui error: " + e.Exception);
                AppDomain.CurrentDomain.UnhandledException += (s, e) => Log.Write("fatal error: " + e.ExceptionObject);
                Log.Write("companion " + Version + " starting" + (options.Background ? " in background" : ""));
                using (var companion = new Companion(options)) Application.Run(companion);
                Log.Write("companion stopped");
                mutex.ReleaseMutex();
            }
            return 0;
        }

        // Asks a running instance to exit and waits until its single-instance mutex is gone.
        static bool QuitRunningInstance()
        {
            if (!Signal(QuitEventName)) return true;
            for (int i = 0; i < 150; i++)
            {
                try { using (Mutex.OpenExisting(MutexName)) { } }
                catch (WaitHandleCannotBeOpenedException) { return true; }
                catch (UnauthorizedAccessException) { }
                Thread.Sleep(100);
            }
            return false;
        }

        static bool Signal(string name)
        {
            try { using (var handle = EventWaitHandle.OpenExisting(name)) handle.Set(); return true; }
            catch (WaitHandleCannotBeOpenedException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }
    }

    sealed class Options
    {
        public bool Background, Quit, Collapse, Expand, InstallStartup, UninstallStartup, DevTools, CheckUpdate;

        public static Options Parse(string[] args)
        {
            var o = new Options();
            foreach (var raw in args)
            {
                switch ((raw ?? "").Trim().ToLowerInvariant())
                {
                    case "--background": o.Background = true; break;
                    case "--quit": o.Quit = true; break;
                    case "--install-startup": o.InstallStartup = true; break;
                    case "--uninstall-startup": o.UninstallStartup = true; break;
                    case "--devtools": o.DevTools = true; break;
                    case "--collapse": o.Collapse = true; break;
                    case "--expand": o.Expand = true; break;
                    case "--check-update": o.CheckUpdate = true; break;
                }
            }
            return o;
        }
    }

    static class Paths
    {
        public static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory;
        static string ResolveDataDir()
        {
            string fromEnv = Environment.GetEnvironmentVariable("MODEL_HARBOR_DATA_DIR");
            try { if (!string.IsNullOrEmpty(fromEnv) && Path.IsPathRooted(fromEnv)) return Path.GetFullPath(fromEnv); }
            catch (ArgumentException) { }
            catch (NotSupportedException) { }
            catch (PathTooLongException) { }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ModelHarbor");
        }

        // MODEL_HARBOR_DATA_DIR (an absolute path) isolates settings, log and WebView2 data, e.g. for tests.
        public static readonly string DataDir = ResolveDataDir();
        public static readonly string WebViewData = Path.Combine(DataDir, "WebView2");
        public static readonly string LogFile = Path.Combine(DataDir, "companion.log");
        public static readonly string SettingsFile = Path.Combine(DataDir, "companion.ini");
        public static readonly string SessionKeyFile = Path.Combine(DataDir, "site-session.key");
    }

    // The key Node encrypts the saved site sign-in (site-session.json) with. It is stored DPAPI-protected for the
    // current Windows user, so another account, or a copy of the data folder on another machine, cannot open the
    // sign-in. A key that cannot be read is replaced, which makes Node discard the old sign-in. Never logged.
    static class SessionKey
    {
        static readonly byte[] Entropy = Encoding.UTF8.GetBytes("ModelHarbor.SiteSession.v1");

        public static string Load()
        {
            try
            {
                byte[] key = null;
                if (File.Exists(Paths.SessionKeyFile))
                {
                    try { key = ProtectedData.Unprotect(File.ReadAllBytes(Paths.SessionKeyFile), Entropy, DataProtectionScope.CurrentUser); }
                    catch (CryptographicException) { key = null; }
                    if (key != null && key.Length != 32) key = null;
                }
                if (key == null)
                {
                    key = new byte[32];
                    using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(key);
                    Directory.CreateDirectory(Paths.DataDir);
                    string temporary = Paths.SessionKeyFile + ".tmp";
                    File.WriteAllBytes(temporary, ProtectedData.Protect(key, Entropy, DataProtectionScope.CurrentUser));
                    if (File.Exists(Paths.SessionKeyFile)) File.Delete(Paths.SessionKeyFile);
                    File.Move(temporary, Paths.SessionKeyFile);
                }
                return Convert.ToBase64String(key);
            }
            catch (Exception e)
            {
                Log.Write("site session key unavailable (" + e.GetType().Name + "); the site sign-in lasts until the companion exits");
                return null;
            }
        }
    }

    // Never receives tokens, API keys or request bodies.
    static class Log
    {
        static readonly object Sync = new object();

        public static void Write(string message)
        {
            try
            {
                lock (Sync)
                {
                    Directory.CreateDirectory(Paths.DataDir);
                    var info = new FileInfo(Paths.LogFile);
                    if (info.Exists && info.Length > 1000000)
                    {
                        string old = Paths.LogFile + ".old";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(Paths.LogFile, old);
                    }
                    File.AppendAllText(Paths.LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch (Exception) { }
        }
    }

    static class Startup
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string ValueName = "ModelHarbor Companion";
        // Task Manager's Startup page records its enabled/disabled switch here, beside the Run value.
        // The first byte is even when the entry is enabled (02, 06) and odd when it is disabled (03, 07).
        const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

        static string Command { get { return "\"" + Application.ExecutablePath + "\" --background"; } }

        // Enabled only when the Run value points at this executable and Task Manager has not disabled it.
        public static bool IsEnabled()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
            {
                var value = key == null ? null : key.GetValue(ValueName) as string;
                if (!string.Equals(value, Command, StringComparison.OrdinalIgnoreCase)) return false;
            }
            return !IsDisabledInTaskManager();
        }

        public static bool IsDisabledInTaskManager()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(ApprovedKey))
                {
                    var data = key == null ? null : key.GetValue(ValueName) as byte[];
                    return data != null && data.Length > 0 && (data[0] & 1) != 0;
                }
            }
            catch (Exception) { return false; }
        }

        // Turning it on from the tray also lifts a Task Manager "Disabled" mark, so the switch the user
        // just ticked is the one that takes effect at the next sign-in.
        public static void Enable()
        {
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey)) key.SetValue(ValueName, Command, RegistryValueKind.String);
            if (!IsDisabledInTaskManager()) return;
            using (var key = Registry.CurrentUser.OpenSubKey(ApprovedKey, true))
                if (key != null) key.SetValue(ValueName, new byte[] { 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, RegistryValueKind.Binary);
        }

        public static void Disable()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey, true)) if (key != null) key.DeleteValue(ValueName, false);
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(ApprovedKey, true)) if (key != null) key.DeleteValue(ValueName, false);
            }
            catch (Exception) { }
        }
    }

    sealed class Settings
    {
        public const double MinPanelDip = 340, MaxPanelDip = 900;
        public double PanelWidthDip = 420, TopOffsetDip = 44;
        public bool Expanded = true;
        // Which outer side of ZCode the panel docks to first; the other side is used when this one lacks room.
        public bool PreferLeft;
        public string ZCodeExe = "ZCode.exe";
        // The ZCode theme seen last ("dark" or "light"), so the next run starts in it instead of the light default.
        public string Theme;
        // The newer version the tray has already told of, so each is told once; and the version that ran last, so the
        // first run after an update can say it took.
        public string UpdateSeen, LastVersion;
        string savedZCodeExe = "ZCode.exe";

        // MODEL_HARBOR_ZCODE_EXE overrides the process image name to follow for this run only; it is never saved.
        public static Settings Load()
        {
            var s = LoadFile();
            string fromEnv = Environment.GetEnvironmentVariable("MODEL_HARBOR_ZCODE_EXE");
            if (IsExeName(fromEnv)) s.ZCodeExe = fromEnv.Trim();
            return s;
        }

        static bool IsExeName(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return false;
            string trimmed = value.Trim();
            return trimmed.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && trimmed.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
        }

        static Settings LoadFile()
        {
            var s = new Settings();
            try
            {
                if (!File.Exists(Paths.SettingsFile)) return s;
                foreach (var line in File.ReadAllLines(Paths.SettingsFile, Encoding.UTF8))
                {
                    int i = line.IndexOf('=');
                    if (i <= 0) continue;
                    string key = line.Substring(0, i).Trim(), value = line.Substring(i + 1).Trim();
                    double number;
                    switch (key)
                    {
                        case "panelWidth":
                            if (double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out number)) s.PanelWidthDip = Clamp(number, MinPanelDip, MaxPanelDip);
                            break;
                        case "topOffset":
                            if (double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out number)) s.TopOffsetDip = Clamp(number, 0, 200);
                            break;
                        case "expanded":
                            s.Expanded = value != "0" && !value.Equals("false", StringComparison.OrdinalIgnoreCase);
                            break;
                        case "dock":
                            s.PreferLeft = value.Equals("left", StringComparison.OrdinalIgnoreCase);
                            break;
                        case "zcodeExe":
                            if (IsExeName(value)) s.ZCodeExe = s.savedZCodeExe = value;
                            break;
                        case "theme":
                            if (value == "dark" || value == "light") s.Theme = value;
                            break;
                        case "updateSeen":
                            if (Updates.IsVersion(value)) s.UpdateSeen = value;
                            break;
                        case "version":
                            if (Updates.IsVersion(value)) s.LastVersion = value;
                            break;
                    }
                }
            }
            catch (Exception e) { Log.Write("settings could not be read: " + e.Message); }
            return s;
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Paths.DataDir);
                File.WriteAllText(Paths.SettingsFile, string.Format(CultureInfo.InvariantCulture, "panelWidth={0:0}\r\ntopOffset={1:0}\r\nexpanded={2}\r\ndock={3}\r\nzcodeExe={4}\r\n{5}{6}{7}", PanelWidthDip, TopOffsetDip, Expanded ? 1 : 0, PreferLeft ? "left" : "right", savedZCodeExe,
                    Theme == null ? "" : "theme=" + Theme + "\r\n", UpdateSeen == null ? "" : "updateSeen=" + UpdateSeen + "\r\n", LastVersion == null ? "" : "version=" + LastVersion + "\r\n"), new UTF8Encoding(false));
            }
            catch (Exception e) { Log.Write("settings could not be saved: " + e.Message); }
        }

        public static double Clamp(double value, double min, double max) { return Math.Max(min, Math.Min(max, value)); }
    }

    // Colors mirror the light and dark variables in panel.html: one ink on one paper, swapped in the dark theme, with
    // every gray made by laying the ink over the paper at the strength the page uses.
    static class Palette
    {
        static readonly Color Cream = Color.FromArgb(0xf9, 0xf8, 0xf6), Black = Color.FromArgb(0x1c, 0x1c, 0x1c);

        public static Color Paper(bool dark) { return dark ? Black : Cream; }
        public static Color Ink(bool dark) { return dark ? Cream : Black; }
        public static Color Line(bool dark) { return Tint(dark, 0.1); }
        public static Color HoverLine(bool dark) { return Tint(dark, 0.4); }
        public static Color Edge(bool dark) { return Tint(dark, dark ? 0.45 : 0.5); }
        public static Color Wash(bool dark) { return Tint(dark, dark ? 0.03 : 0.025); }
        public static Color Hover(bool dark) { return Tint(dark, dark ? 0.07 : 0.05); }
        public static Color Muted(bool dark) { return Tint(dark, dark ? 0.6 : 0.66); }

        static Color Tint(bool dark, double strength)
        {
            Color paper = Paper(dark), ink = Ink(dark);
            return Color.FromArgb(Mix(paper.R, ink.R, strength), Mix(paper.G, ink.G, strength), Mix(paper.B, ink.B, strength));
        }

        static int Mix(int from, int to, double strength) { return (int)Math.Round(from + (to - from) * strength); }
    }

    // The biubiu AI mark: a finger gun drawn as one continuous line, firing two four-pointed AI sparkles ("biu biu").
    // A copy of app/lib/logo.mjs, which app/lib/core.test.mjs compares with this; the exe's own icon is drawn from the
    // same paths at build time (app/icon.mjs). Drawn here for the tray icon and the collapsed tab.
    static class Logo
    {
        public const string Hand = "M 289.6 779.3 C 273.2 728.6 256.1 680.8 245.4 630.2 C 234.1 577 234.9 535.1 241.4 500.4 L 218.5 392.6 C 212 362 228.5 334.9 253.1 329.6 C 277.7 324.4 303.8 342.5 310.3 373.1 L 326.4 448.9 L 548.6 401.7 C 576.5 395.8 603.9 413.6 609.9 441.5 C 615.8 469.4 598 496.9 570.1 502.8 L 461 526 C 497.5 521 517.3 555.7 504.1 585 C 495.5 603.5 479.3 612.5 462.1 616.1 C 495.4 616 511.8 647.3 499.3 673.6 C 489.7 693.7 466.8 704.1 441.3 708.1 C 422.7 712.1 414 723.7 415.9 752.5";
        public const float HandWidth = 54.4f;
        public static readonly string[] Sparkles =
        {
            "M 742.1 330.4 C 750.9 376.9 778.6 404.5 825.1 413.4 C 778.6 422.3 750.9 449.9 742.1 496.4 C 733.2 449.9 705.6 422.3 659.1 413.4 C 705.6 404.5 733.2 376.9 742.1 330.4 Z",
            "M 766.8 226.5 C 770.9 248.1 783.7 260.9 805.3 265 C 783.7 269.1 770.9 282 766.8 303.5 C 762.7 282 749.8 269.1 728.3 265 C 749.8 260.9 762.7 248.1 766.8 226.5 Z"
        };
        public const float SparkleRound = 18f;
        public static readonly RectangleF MarkBox = new RectangleF(189.9f, 217.5f, 644.2f, 589f);
        public static readonly Color Accent = Color.FromArgb(0xEA, 0x58, 0x0C), Ink = Color.FromArgb(0x1B, 0x1B, 0x1C);
        public static readonly Color TilePaper = Color.FromArgb(0xF6, 0xF4, 0xF0), TileEdge = Color.FromArgb(0xE4, 0xE1, 0xDB);
        // Lines thinner than this many pixels are drawn this thick, so the mark keeps its outline when small.
        const float MinLine = 1.25f;

        // The paths use only absolute M, L, C and Z, as logo.mjs writes them.
        public static GraphicsPath Parse(string d)
        {
            var path = new GraphicsPath();
            string[] tokens = d.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            int i = 0;
            Func<float> next = () => float.Parse(tokens[i++], NumberStyles.Float, CultureInfo.InvariantCulture);
            PointF pen = PointF.Empty;
            while (i < tokens.Length)
            {
                string op = tokens[i++];
                if (op == "M") { path.StartFigure(); pen = new PointF(next(), next()); }
                else if (op == "L") { var to = new PointF(next(), next()); path.AddLine(pen, to); pen = to; }
                else if (op == "C") { var c1 = new PointF(next(), next()); var c2 = new PointF(next(), next()); var to = new PointF(next(), next()); path.AddBezier(pen, c1, c2, to); pen = to; }
                else if (op == "Z") path.CloseFigure();
                else throw new FormatException("unexpected path command " + op);
            }
            return path;
        }

        // Draws the mark into box, centred and keeping its proportions: the hand in `hand`, the sparkles in `sparkle`.
        public static void Draw(Graphics g, RectangleF box, Color hand, Color sparkle)
        {
            float scale = Math.Min(box.Width / MarkBox.Width, box.Height / MarkBox.Height);
            var state = g.Save();
            try
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.TranslateTransform(box.X + (box.Width - MarkBox.Width * scale) / 2 - MarkBox.X * scale, box.Y + (box.Height - MarkBox.Height * scale) / 2 - MarkBox.Y * scale);
                g.ScaleTransform(scale, scale);
                using (var path = Parse(Hand))
                using (var pen = new Pen(hand, Math.Max(HandWidth, MinLine / scale)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                    g.DrawPath(pen, path);
                using (var brush = new SolidBrush(sparkle))
                using (var pen = new Pen(sparkle, SparkleRound) { LineJoin = LineJoin.Round })
                    foreach (string d in Sparkles)
                        using (var path = Parse(d)) { g.FillPath(brush, path); g.DrawPath(pen, path); }
            }
            finally { g.Restore(state); }
        }

        // The tray icon at the size the taskbar shows it: the paper tile fills the icon, so the mark stays legible.
        public static Icon CreateTrayIcon(int size, out IntPtr handle)
        {
            using (var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bitmap))
                {
                    g.Clear(Color.Transparent);
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    using (var tile = Shapes.Rounded(new RectangleF(0.5f, 0.5f, size - 1f, size - 1f), size * 0.22f))
                    {
                        using (var brush = new SolidBrush(TilePaper)) g.FillPath(brush, tile);
                        using (var pen = new Pen(TileEdge, 1f)) g.DrawPath(pen, tile);
                    }
                    float pad = size * 0.11f;
                    Draw(g, new RectangleF(pad, pad, size - 2 * pad, size - 2 * pad), Ink, Accent);
                }
                handle = bitmap.GetHicon();
            }
            return Icon.FromHandle(handle);
        }

        // The app icon for windows in the taskbar: biubiu.ico, which app/build.mjs writes beside the exe with every size,
        // or else the exe's own embedded icon.
        public static Icon AppIcon()
        {
            try
            {
                string file = Path.Combine(Paths.AppDir, "biubiu.ico");
                return File.Exists(file) ? new Icon(file) : Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch (Exception e) { Log.Write("app icon unavailable: " + e.GetType().Name); return null; }
        }
    }

    static class Locate
    {
        // MODEL_HARBOR_NODE first; then the runtime the installer puts beside bin (node\node.exe), so an installed
        // companion needs no Node.js of its own; then a Node.js on PATH or in its usual folders, as in a development tree.
        public static string Node()
        {
            string fromEnv = Environment.GetEnvironmentVariable("MODEL_HARBOR_NODE");
            if (!string.IsNullOrEmpty(fromEnv) && File.Exists(fromEnv)) return fromEnv;
            string bundled = Path.GetFullPath(Path.Combine(Paths.AppDir, "..", "node", "node.exe"));
            if (File.Exists(bundled)) return bundled;
            foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                try
                {
                    string trimmed = dir.Trim().Trim('"');
                    if (trimmed.Length == 0) continue;
                    string candidate = Path.Combine(trimmed, "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch (ArgumentException) { }
            }
            foreach (var candidate in new[] {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe") })
                if (File.Exists(candidate)) return candidate;
            return null;
        }

        public static string ServerScript()
        {
            string fromEnv = Environment.GetEnvironmentVariable("MODEL_HARBOR_APP_SERVER");
            if (!string.IsNullOrEmpty(fromEnv) && File.Exists(fromEnv)) return Path.GetFullPath(fromEnv);
            string beside = Path.GetFullPath(Path.Combine(Paths.AppDir, "..", "server.mjs"));
            return File.Exists(beside) ? beside : null;
        }
    }

    // What Node answered the host over its stdin pipe (ServerProcess.Ask): whether the site is signed in, and the access
    // token for the site window when it is. Answered is false when Node failed, or did not answer in time.
    sealed class HostReply
    {
        public static readonly HostReply Failed = new HostReply(false, false, null);
        public readonly bool Answered, SignedIn;
        public readonly string Token;
        public HostReply(bool answered, bool signedIn, string token) { Answered = answered; SignedIn = signedIn; Token = token; }
    }

    // Runs app/server.mjs. The job object kills Node if this process dies; on a normal exit
    // stdin is closed first so an import that is writing the config can finish.
    sealed class ServerProcess : IDisposable
    {
        sealed class Launch { public Process Process; public int Generation; public int Ready; public System.Threading.Timer Timeout; }

        static readonly Regex ReadyLine = new Regex("\"event\"\\s*:\\s*\"ready\".*?\"port\"\\s*:\\s*(\\d+)", RegexOptions.CultureInvariant);
        static readonly Regex ReplyLine = new Regex("^\\{\"event\":\"host-reply\",\"id\":(\\d{1,9})[,}]", RegexOptions.CultureInvariant);
        static readonly Regex ReplyToken = new Regex("\"token\":\"([A-Za-z0-9+/=]{1,16384})\"", RegexOptions.CultureInvariant);
        // Node's memory, the same however the companion is started: V8's young generation is capped at 2 MB a half, so
        // reading the public model catalog peaks near 30 MB instead of 70; and libuv gets two pool threads for the few
        // files and names the server needs, since Windows commits each one's 8 MB stack up front (a shell's
        // UV_THREADPOOL_SIZE=16 made 128 MB).
        const string NodeFlags = "--max-semi-space-size=2";
        const string PoolThreads = "2";
        readonly Dictionary<int, TaskCompletionSource<HostReply>> asks = new Dictionary<int, TaskCompletionSource<HostReply>>();
        int lastAsk;
        public event Action<int> Ready;
        public event Action<string> Failed;
        public string Token { get; private set; }
        readonly object sync = new object();
        readonly List<DateTime> starts = new List<DateTime>();
        readonly IntPtr job;
        readonly string sessionKey = SessionKey.Load();
        Launch current;
        bool stopping;
        int generation;

        public ServerProcess()
        {
            var bytes = new byte[32];
            using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(bytes);
            var sb = new StringBuilder(64);
            foreach (var b in bytes) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
            Token = sb.ToString();
            job = Native.CreateKillOnCloseJob();
            if (job == IntPtr.Zero) Log.Write("job object unavailable; Node is stopped only on a normal exit");
        }

        public void Restart()
        {
            lock (sync) starts.Clear();
            Start();
        }

        public void Start()
        {
            string node = Locate.Node(), script = Locate.ServerScript();
            if (node == null) { Fail("没有找到 biubiu AI 需要的 Node.js 运行时。请重新运行 biubiu AI 安装程序；在开发目录里运行时，请安装 Node.js 22 或更新版本，或用 MODEL_HARBOR_NODE 指定 node.exe。"); return; }
            if (script == null) { Fail("没有找到 biubiu AI 的本地服务 server.mjs。请重新运行 biubiu AI 安装程序；在开发目录里运行时，请保持程序位于 app\\bin 目录。"); return; }
            lock (sync)
            {
                if (stopping) return;
                starts.RemoveAll(t => (DateTime.UtcNow - t).TotalSeconds > 60);
                starts.Add(DateTime.UtcNow);
            }
            var psi = new ProcessStartInfo(node, NodeFlags + " \"" + script + "\"")
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(script),
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            psi.EnvironmentVariables["MODEL_HARBOR_APP_TOKEN"] = Token;
            psi.EnvironmentVariables["MODEL_HARBOR_HOST_PID"] = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            psi.EnvironmentVariables.Remove("NODE_OPTIONS");
            psi.EnvironmentVariables["UV_THREADPOOL_SIZE"] = PoolThreads;
            psi.EnvironmentVariables.Remove("MODEL_HARBOR_APP_PORT");
            psi.EnvironmentVariables.Remove("MODEL_HARBOR_SESSION_KEY");
            if (sessionKey != null)
            {
                psi.EnvironmentVariables["MODEL_HARBOR_SESSION_KEY"] = sessionKey;
                psi.EnvironmentVariables["MODEL_HARBOR_SESSION_DIR"] = Paths.DataDir;
            }

            var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            try { process.Start(); }
            catch (Exception e) { process.Dispose(); Fail("无法启动 Node.js：" + e.Message); return; }
            if (job != IntPtr.Zero && !Native.AssignProcessToJobObject(job, process.Handle)) Log.Write("could not assign the server to the job object: " + Marshal.GetLastWin32Error());

            var launch = new Launch { Process = process };
            lock (sync) { launch.Generation = ++generation; current = launch; }
            process.ErrorDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log.Write("server: " + e.Data); };
            process.Exited += (s, e) => OnExited(launch);
            process.BeginErrorReadLine();
            launch.Timeout = new System.Threading.Timer(_ =>
            {
                if (Interlocked.CompareExchange(ref launch.Ready, 0, 0) != 0) return;
                Log.Write("server did not report ready within 20 s");
                try { if (!launch.Process.HasExited) launch.Process.Kill(); } catch (Exception) { }
            }, null, 20000, Timeout.Infinite);
            new Thread(() => ReadStdout(launch)) { IsBackground = true, Name = "model-harbor-server-stdout" }.Start();
            Log.Write("server started (pid " + process.Id + ")");
        }

        void ReadStdout(Launch launch)
        {
            try
            {
                string line;
                while ((line = launch.Process.StandardOutput.ReadLine()) != null)
                {
                    if (launch.Ready != 0) { Answer(line); continue; }
                    var match = ReadyLine.Match(line);
                    int port;
                    if (!match.Success || !int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out port) || port <= 0 || port > 65535) continue;
                    if (Interlocked.Exchange(ref launch.Ready, 1) != 0) continue;
                    launch.Timeout.Dispose();
                    bool isCurrent;
                    lock (sync) isCurrent = !stopping && current == launch;
                    if (isCurrent) { Log.Write("server ready on 127.0.0.1:" + port); var handler = Ready; if (handler != null) handler(port); }
                }
            }
            catch (Exception e) { Log.Write("server output stopped: " + e.GetType().Name); }
        }

        void OnExited(Launch launch)
        {
            int code = -1;
            try { code = launch.Process.ExitCode; } catch (Exception) { }
            launch.Timeout.Dispose();
            int recent;
            lock (sync)
            {
                if (stopping || current != launch) return;
                starts.RemoveAll(t => (DateTime.UtcNow - t).TotalSeconds > 60);
                recent = starts.Count;
            }
            SettleAll();
            Log.Write("server exited with code " + code);
            if (recent >= 4) { Fail("biubiu AI 的本地服务反复退出，已停止重试。详情见日志：" + Paths.LogFile); return; }
            ThreadPool.QueueUserWorkItem(_ => { Thread.Sleep(1500); Start(); });
        }

        void Fail(string message)
        {
            Log.Write("server failure: " + message);
            var handler = Failed;
            if (handler != null) handler(message);
        }

        // Asks Node for what only the host may have, one JSON line on Node's stdin; Node answers on its stdout, which only
        // this process reads, so the answer never reaches the panel, a port, a command line or the log. The one question
        // is "site-token": an access token for the site window (Site.handoff in site.mjs). Answers Failed when Node is not
        // ready, does not answer within 15 seconds, or exits first.
        public Task<HostReply> Ask(string op)
        {
            var answer = new TaskCompletionSource<HostReply>();
            Launch launch;
            int id;
            lock (sync)
            {
                launch = !stopping && current != null && current.Ready != 0 ? current : null;
                id = ++lastAsk;
                if (launch != null) asks[id] = answer;
            }
            if (launch == null) { answer.SetResult(HostReply.Failed); return answer.Task; }
            var timer = new System.Threading.Timer(_ => Settle(id, HostReply.Failed), null, 15000, Timeout.Infinite);
            answer.Task.ContinueWith(_ => timer.Dispose(), TaskContinuationOptions.ExecuteSynchronously);
            try
            {
                lock (launch)
                {
                    launch.Process.StandardInput.WriteLine("{\"id\":" + id.ToString(CultureInfo.InvariantCulture) + ",\"op\":\"" + op + "\"}");
                    launch.Process.StandardInput.Flush();
                }
            }
            catch (Exception) { Settle(id, HostReply.Failed); }
            return answer.Task;
        }

        void Answer(string line)
        {
            int id;
            var reply = ParseReply(line, out id);
            if (reply != null) Settle(id, reply);
        }

        // One answer line from Node: { event: "host-reply", id, signedIn, token (base64) } or { ..., error }; null for any
        // other line.
        internal static HostReply ParseReply(string line, out int id)
        {
            id = 0;
            var match = ReplyLine.Match(line ?? "");
            if (!match.Success || !int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out id)) return null;
            if (line.Contains("\"error\":")) return HostReply.Failed;
            if (!line.Contains("\"signedIn\":true")) return new HostReply(true, false, null);
            var token = ReplyToken.Match(line);
            string value = null;
            if (token.Success) try { value = Encoding.UTF8.GetString(Convert.FromBase64String(token.Groups[1].Value)); } catch (FormatException) { }
            return string.IsNullOrEmpty(value) ? HostReply.Failed : new HostReply(true, true, value);
        }

        void Settle(int id, HostReply reply)
        {
            TaskCompletionSource<HostReply> answer;
            lock (sync)
            {
                if (!asks.TryGetValue(id, out answer)) return;
                asks.Remove(id);
            }
            answer.TrySetResult(reply);
        }

        void SettleAll()
        {
            List<int> ids;
            lock (sync) ids = new List<int>(asks.Keys);
            foreach (int id in ids) Settle(id, HostReply.Failed);
        }

        public void Dispose()
        {
            Launch launch;
            lock (sync) { if (stopping) return; stopping = true; launch = current; }
            if (launch != null)
            {
                try
                {
                    if (!launch.Process.HasExited)
                    {
                        launch.Process.StandardInput.Close();
                        if (!launch.Process.WaitForExit(6000)) { Log.Write("server did not stop in time; ending it"); launch.Process.Kill(); }
                    }
                }
                catch (Exception e) { Log.Write("server stop: " + e.GetType().Name); }
                launch.Process.Dispose();
            }
            SettleAll();
            if (job != IntPtr.Zero) Native.CloseHandle(job);
        }
    }

    // Sends the host's view (theme, whether ZCode is visible) to /api/host, newest value wins.
    sealed class HostState
    {
        sealed class Client : WebClient
        {
            protected override WebRequest GetWebRequest(Uri address)
            {
                var request = base.GetWebRequest(address);
                request.Timeout = 5000;
                return request;
            }
        }

        readonly object sync = new object();
        int port;
        string token, pending;
        bool posting, closed;

        public void SetEndpoint(int port, string token) { lock (sync) { this.port = port; this.token = token; } }
        public void Close() { lock (sync) closed = true; }

        public void Post(string theme, bool zcode)
        {
            string json = "{" + (theme == null ? "" : "\"theme\":\"" + theme + "\",") + "\"zcode\":" + (zcode ? "true" : "false") + "}";
            lock (sync)
            {
                if (closed || port == 0) return;
                pending = json;
                if (posting) return;
                posting = true;
            }
            ThreadPool.QueueUserWorkItem(_ => Drain());
        }

        void Drain()
        {
            while (true)
            {
                string json, key;
                int target;
                lock (sync)
                {
                    json = pending; pending = null; target = port; key = token;
                    if (json == null || closed) { posting = false; return; }
                }
                try
                {
                    using (var client = new Client())
                    {
                        client.Proxy = null;
                        client.Encoding = Encoding.UTF8;
                        client.Headers[HttpRequestHeader.ContentType] = "application/json";
                        client.Headers["X-Harbor-App"] = key;
                        client.UploadString("http://127.0.0.1:" + target.ToString(CultureInfo.InvariantCulture) + "/api/host", "POST", json);
                    }
                }
                catch (WebException e) { Log.Write("host state was not delivered: " + e.Status); }
            }
        }
    }

    static class ThemeSampler
    {
        // Median luminance of three strips of ZCode, or -1 when none is visible. A strip that touches
        // exclude (the companion's own window when it lies on top of ZCode) is skipped.
        public static double Sample(IntPtr zcode, Rectangle frame, double scale, Rectangle exclude)
        {
            int stripHeight = Math.Max(3, (int)(10 * scale));
            int sideWidth = (int)Math.Min(120 * scale, frame.Width * 0.15);
            var strips = new[]
            {
                new Rectangle(frame.Left + (int)(frame.Width * 0.30), frame.Top + (int)(8 * scale), (int)Math.Min(240 * scale, frame.Width * 0.25), stripHeight),
                new Rectangle(frame.Left + (int)(12 * scale), frame.Top + frame.Height / 2, sideWidth, stripHeight),
                new Rectangle(frame.Right - (int)(12 * scale) - sideWidth, frame.Top + frame.Height / 2, sideWidth, stripHeight)
            };
            var values = new List<double>();
            foreach (var strip in strips)
            {
                var r = strip;
                if (r.Width < 4 || r.Height < 2 || (!exclude.IsEmpty && r.IntersectsWith(exclude))) continue;
                var center = new Native.POINT(r.Left + r.Width / 2, r.Top + r.Height / 2);
                if (Native.GetAncestor(Native.WindowFromPoint(center), Native.GA_ROOT) != zcode) continue;
                using (var bitmap = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb))
                {
                    using (var g = Graphics.FromImage(bitmap)) g.CopyFromScreen(r.Left, r.Top, 0, 0, r.Size, CopyPixelOperation.SourceCopy);
                    for (int y = 0; y < bitmap.Height; y += 2)
                        for (int x = 0; x < bitmap.Width; x += 3)
                        {
                            var c = bitmap.GetPixel(x, y);
                            values.Add(0.299 * c.R + 0.587 * c.G + 0.114 * c.B);
                        }
                }
            }
            if (values.Count == 0) return -1;
            values.Sort();
            return values[values.Count / 2];
        }
    }

    // Keeps the companion on the virtual desktop that shows ZCode. Only moves this process's windows.
    sealed class VirtualDesktop
    {
        [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IVirtualDesktopManager
        {
            [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out int onCurrentDesktop);
            [PreserveSig] int GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktopId);
            [PreserveSig] int MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
        }

        [ComImport, Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")]
        class VirtualDesktopManagerClass { }

        IVirtualDesktopManager manager;
        bool disabled;

        public void Follow(IntPtr ours, IntPtr target)
        {
            if (disabled) return;
            try
            {
                if (manager == null) manager = (IVirtualDesktopManager)new VirtualDesktopManagerClass();
                int targetOn, oursOn;
                if (manager.IsWindowOnCurrentVirtualDesktop(target, out targetOn) != 0 || targetOn == 0) return;
                if (manager.IsWindowOnCurrentVirtualDesktop(ours, out oursOn) != 0 || oursOn != 0) return;
                Guid id;
                if (manager.GetWindowDesktopId(target, out id) == 0) manager.MoveWindowToDesktop(ours, ref id);
            }
            catch (Exception e) { disabled = true; Log.Write("virtual desktop following disabled: " + e.GetType().Name); }
        }
    }

    // Finds the ZCode main window and reports when it moves, resizes, minimizes, hides or changes
    // foreground. Events arrive on the UI thread (out-of-context hooks use the installing thread).
    sealed class ZCodeTracker : IDisposable
    {
        public event EventHandler Changed;
        public IntPtr Window { get; private set; }
        public bool Moving { get; private set; }
        readonly string exeName;
        readonly Native.WinEventProc callback;
        readonly List<IntPtr> hooks = new List<IntPtr>();
        readonly Dictionary<uint, bool> processes = new Dictionary<uint, bool>();
        readonly StringBuilder className = new StringBuilder(256);
        readonly uint ownPid = (uint)Process.GetCurrentProcess().Id;

        public ZCodeTracker(string exeName)
        {
            this.exeName = exeName;
            callback = OnEvent;
            Hook(Native.EVENT_SYSTEM_FOREGROUND, Native.EVENT_SYSTEM_MINIMIZEEND);
            Hook(Native.EVENT_OBJECT_DESTROY, Native.EVENT_OBJECT_HIDE);
            Hook(Native.EVENT_OBJECT_LOCATIONCHANGE, Native.EVENT_OBJECT_LOCATIONCHANGE);
            Hook(Native.EVENT_OBJECT_CLOAKED, Native.EVENT_OBJECT_UNCLOAKED);
        }

        void Hook(uint min, uint max)
        {
            IntPtr hook = Native.SetWinEventHook(min, max, IntPtr.Zero, callback, 0, 0, Native.WINEVENT_OUTOFCONTEXT | Native.WINEVENT_SKIPOWNPROCESS);
            if (hook == IntPtr.Zero) Log.Write("window event hook failed for 0x" + min.ToString("x", CultureInfo.InvariantCulture)); else hooks.Add(hook);
        }

        void OnEvent(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
        {
            if (hwnd == IntPtr.Zero || idObject != Native.OBJID_WINDOW || idChild != 0) return;
            switch (evt)
            {
                case Native.EVENT_SYSTEM_FOREGROUND:
                    if (hwnd != Window && IsZCodeMain(hwnd)) { Window = hwnd; Moving = false; }
                    Raise();
                    break;
                case Native.EVENT_SYSTEM_MOVESIZESTART:
                    if (hwnd == Window) { Moving = true; Raise(); }
                    break;
                case Native.EVENT_SYSTEM_MOVESIZEEND:
                    if (hwnd == Window) { Moving = false; Raise(); }
                    break;
                case Native.EVENT_OBJECT_SHOW:
                    if (hwnd == Window || (Window == IntPtr.Zero && IsZCodeMain(hwnd))) { Window = hwnd; Raise(); }
                    break;
                case Native.EVENT_OBJECT_DESTROY:
                    if (hwnd == Window) { Window = IntPtr.Zero; Moving = false; Raise(); }
                    break;
                case Native.EVENT_SYSTEM_MINIMIZESTART:
                case Native.EVENT_SYSTEM_MINIMIZEEND:
                case Native.EVENT_OBJECT_HIDE:
                case Native.EVENT_OBJECT_LOCATIONCHANGE:
                case Native.EVENT_OBJECT_CLOAKED:
                case Native.EVENT_OBJECT_UNCLOAKED:
                    if (hwnd == Window) Raise();
                    break;
            }
        }

        void Raise() { var handler = Changed; if (handler != null) handler(this, EventArgs.Empty); }

        // Revalidates the tracked window; prefers a ZCode window that is in the foreground.
        public void Refresh()
        {
            IntPtr foreground = Native.GetForegroundWindow();
            if (foreground != Window && IsZCodeMain(foreground)) { Window = foreground; return; }
            if (Window != IntPtr.Zero && Native.IsWindowVisible(Window) && IsZCodeMain(Window)) return;
            processes.Clear();
            IntPtr found = IntPtr.Zero;
            Native.EnumWindows((h, l) =>
            {
                if (Native.IsWindowVisible(h) && IsZCodeMain(h)) { found = h; return false; }
                return true;
            }, IntPtr.Zero);
            if (found != Window) Moving = false;
            Window = found;
        }

        bool IsZCodeMain(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) return false;
            if (Native.GetWindow(hwnd, Native.GW_OWNER) != IntPtr.Zero) return false;
            if (((long)Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE) & Native.WS_EX_TOOLWINDOW) != 0) return false;
            className.Clear();
            if (Native.GetClassName(hwnd, className, className.Capacity) == 0 || className.ToString() != "Chrome_WidgetWin_1") return false;
            if (Native.GetWindowTextLength(hwnd) == 0) return false;
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0 || pid == ownPid) return false;
            bool match;
            if (!processes.TryGetValue(pid, out match))
            {
                if (processes.Count > 256) processes.Clear();
                match = Native.ProcessImageNameIs(pid, exeName);
                processes[pid] = match;
            }
            return match;
        }

        public void Dispose()
        {
            foreach (var hook in hooks) Native.UnhookWinEvent(hook);
            hooks.Clear();
        }
    }

    sealed class Grip : Control
    {
        public event Action<int> Drag;
        public event EventHandler DragEnd;
        bool dragging;

        public Grip()
        {
            Cursor = Cursors.SizeWE;
            TabStop = false;
            SetStyle(ControlStyles.Selectable, false);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) { dragging = true; Capture = true; }
            base.OnMouseDown(e);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (dragging) { var handler = Drag; if (handler != null) handler(Control.MousePosition.X); }
            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            Finish();
            base.OnMouseUp(e);
        }

        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            Finish();
            base.OnMouseCaptureChanged(e);
        }

        void Finish()
        {
            if (!dragging) return;
            dragging = false;
            Capture = false;
            var handler = DragEnd;
            if (handler != null) handler(this, EventArgs.Empty);
        }
    }

    // The strip along the panel edge that faces ZCode. Clicking it collapses the panel into the edge tab.
    sealed class CollapseBar : Control
    {
        public event EventHandler Clicked;
        readonly ToolTip tip = new ToolTip();
        bool dark, hover, arrowRight;

        public CollapseBar()
        {
            Cursor = Cursors.Hand;
            TabStop = false;
            SetStyle(ControlStyles.Selectable, false);
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            tip.SetToolTip(this, "收起 biubiu AI（Ctrl+Alt+M）");
        }

        public void SetDark(bool value) { if (dark == value) return; dark = value; Invalidate(); }
        public void SetArrow(bool pointsRight) { if (arrowRight == pointsRight) return; arrowRight = pointsRight; Invalidate(); }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button == MouseButtons.Left && ClientRectangle.Contains(e.Location)) { var handler = Clicked; if (handler != null) handler(this, EventArgs.Empty); }
        }

        // At rest only the arrow shows, so the bar reads as part of the page, with no seam between them. Hovered, a soft
        // rounded band shows that the whole strip collapses the panel; it keeps clear of the window's rounded corners.
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Palette.Paper(dark));
            g.SmoothingMode = SmoothingMode.AntiAlias;
            if (hover)
            {
                float inset = Math.Max(2f, Width * 0.18f), top = Width * 1.2f;
                var band = new RectangleF(inset, top, Width - 2 * inset, Height - 2 * top);
                if (band.Width > 0 && band.Height > 0)
                    using (var path = Shapes.Rounded(band, band.Width / 2f))
                    using (var brush = new SolidBrush(Palette.Hover(dark))) g.FillPath(brush, path);
            }
            float cx = Width / 2f, cy = Height / 2f, half = Math.Max(3.5f, Width * 0.3f);
            float dx = (arrowRight ? 1f : -1f) * half * 0.55f;
            var points = new[] { new PointF(cx - dx, cy - half), new PointF(cx + dx, cy), new PointF(cx - dx, cy + half) };
            using (var pen = new Pen(hover ? Palette.Ink(dark) : Palette.Edge(dark), Math.Max(1f, Width / 10f)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                g.DrawLines(pen, points);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) tip.Dispose();
            base.Dispose(disposing);
        }
    }

    sealed class PanelForm : Form
    {
        public event EventHandler HideRequested;
        public event EventHandler CollapseRequested;
        public event EventHandler HotKeyPressed;
        public event Action<int> GripDrag;
        public event EventHandler GripDragEnd;
        // The page's link under the site balance, and its signing out of the site.
        public event EventHandler SiteRequested;
        public event EventHandler SiteSignedOut;
        // The footer's link to a newer version.
        public event EventHandler UpdateRequested;
        public bool AllowClose;
        // The panel's WebView2 environment, which the site window shares (with a profile of its own).
        public CoreWebView2Environment WebEnvironment { get; private set; }
        readonly WebView2 web = new WebView2();
        readonly Grip grip = new Grip();
        readonly CollapseBar bar = new CollapseBar();
        bool gripLeft, barLeft = true;
        int gripWidth = 6, barWidth = 12;
        bool ready, dark, themeKnown, allowNextDocument, memoryTargetUnavailable;
        int port;
        string updateJson;

        public PanelForm()
        {
            Text = "biubiu AI";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Palette.Paper(false);
            Bounds = new Rectangle(-32000, -32000, 420, 600);
            grip.BackColor = BackColor;
            grip.Drag += x => { var handler = GripDrag; if (handler != null) handler(x); };
            grip.DragEnd += (s, e) => { var handler = GripDragEnd; if (handler != null) handler(this, EventArgs.Empty); };
            bar.Clicked += (s, e) => { var handler = CollapseRequested; if (handler != null) handler(this, EventArgs.Empty); };
            web.DefaultBackgroundColor = BackColor;
            Controls.Add(web);
            Controls.Add(grip);
            Controls.Add(bar);
            Arrange();
        }

        // Puts the resize grip and the collapse bar on the requested edges; the web view takes the rest.
        // When both sit on the same edge the grip is outermost.
        public void SetEdges(bool gripOnLeft, bool barOnLeft, bool arrowRight, double scale)
        {
            int g = Math.Max(4, (int)Math.Round(6 * scale)), b = Math.Max(8, (int)Math.Round(12 * scale));
            bar.SetArrow(arrowRight);
            if (gripLeft == gripOnLeft && barLeft == barOnLeft && gripWidth == g && barWidth == b) return;
            gripLeft = gripOnLeft; barLeft = barOnLeft; gripWidth = g; barWidth = b;
            Arrange();
        }

        void Arrange()
        {
            int w = ClientSize.Width, h = ClientSize.Height, left = 0, right = w;
            if (gripLeft) { grip.SetBounds(0, 0, gripWidth, h); left += gripWidth; } else { grip.SetBounds(w - gripWidth, 0, gripWidth, h); right -= gripWidth; }
            if (barLeft) { bar.SetBounds(left, 0, barWidth, h); left += barWidth; } else { bar.SetBounds(right - barWidth, 0, barWidth, h); right -= barWidth; }
            web.SetBounds(left, 0, Math.Max(0, right - left), h);
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            Arrange();
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= Native.WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        // Rounded corners, a hairline border and a soft shadow, as Windows 11 draws them for ZCode's own window, so the two
        // read as siblings. Windows 10 has no rounded corners and keeps the panel square.
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Native.TrySetCorner(Handle, Native.DWMWCP_ROUND);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY) { var handler = HotKeyPressed; if (handler != null) handler(this, EventArgs.Empty); return; }
            base.WndProc(ref m);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!AllowClose && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                var handler = HideRequested;
                if (handler != null) handler(this, EventArgs.Empty);
                return;
            }
            base.OnFormClosing(e);
        }

        public async Task InitializeAsync(string dataDir, string loaderDir, bool devTools)
        {
            Directory.CreateDirectory(dataDir);
            try { CoreWebView2Environment.SetLoaderDllFolderPath(loaderDir); }
            catch (InvalidOperationException) { }
            IntPtr created = web.Handle;
            var environment = await CoreWebView2Environment.CreateAsync(null, dataDir, new CoreWebView2EnvironmentOptions());
            await web.EnsureCoreWebView2Async(environment);
            WebEnvironment = environment;
            var core = web.CoreWebView2;
            var settings = core.Settings;
            settings.AreDevToolsEnabled = devTools;
            settings.AreDefaultContextMenusEnabled = devTools;
            settings.AreBrowserAcceleratorKeysEnabled = devTools;
            settings.AreHostObjectsAllowed = false;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            settings.IsWebMessageEnabled = true;
            core.NavigationStarting += (s, e) => { if (!Allowed(e.Uri)) { e.Cancel = true; Log.Write("blocked a navigation away from the local panel"); } };
            core.FrameNavigationStarting += (s, e) => e.Cancel = true;
            core.NewWindowRequested += (s, e) => e.Handled = true;
            core.PermissionRequested += (s, e) => e.State = CoreWebView2PermissionState.Deny;
            core.DownloadStarting += (s, e) => e.Cancel = true;
            core.NavigationCompleted += (s, e) => PostTheme();
            core.WebMessageReceived += OnWebMessage;
            core.ProcessFailed += (s, e) =>
            {
                Log.Write("webview process failed: " + e.ProcessFailedKind);
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                    try { core.Reload(); } catch (Exception) { }
            };
            ready = true;
            GC.KeepAlive(created);
        }

        bool Allowed(string uri)
        {
            if (allowNextDocument && (uri.StartsWith("data:", StringComparison.Ordinal) || uri == "about:blank")) { allowNextDocument = false; return true; }
            return IsPanelOrigin(uri);
        }

        bool IsPanelOrigin(string uri)
        {
            Uri parsed;
            return port > 0 && Uri.TryCreate(uri, UriKind.Absolute, out parsed) && parsed.Scheme == Uri.UriSchemeHttp && parsed.Host == "127.0.0.1" && parsed.Port == port;
        }

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsPanelOrigin(e.Source)) return;
            string message = null;
            try { message = e.TryGetWebMessageAsString(); } catch (ArgumentException) { }
            if (message == "hide") { var handler = HideRequested; if (handler != null) handler(this, EventArgs.Empty); }
            else if (message == "ready") { PostPanel(); SendUpdate(); }
            else if (message == "open-site") { var handler = SiteRequested; if (handler != null) handler(this, EventArgs.Empty); }
            else if (message == "site-signed-out") { var handler = SiteSignedOut; if (handler != null) handler(this, EventArgs.Empty); }
            else if (message == "update") { var handler = UpdateRequested; if (handler != null) handler(this, EventArgs.Empty); }
        }

        // A newer version for the footer: found ("available"), "downloading" with its percentage, or "installing"; no
        // version hides it. Kept for the page's next "ready", since a reloaded page starts without it.
        public void PostUpdate(string version, string state, int percent)
        {
            updateJson = "{\"type\":\"update\",\"version\":" + (version == null ? "null" : Json.Quote(version)) + ",\"state\":" + Json.Quote(state) + ",\"percent\":" + percent.ToString(CultureInfo.InvariantCulture) + "}";
            SendUpdate();
        }

        void SendUpdate()
        {
            if (!ready || updateJson == null) return;
            try { web.CoreWebView2.PostWebMessageAsJson(updateJson); }
            catch (Exception error) { Log.Write("update message failed: " + error.GetType().Name); }
        }

        // A site window that could not open says so on the site page.
        public void PostSiteError(string text)
        {
            if (!ready) return;
            try { web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"site-window\",\"error\":" + Json.Quote(text) + "}"); }
            catch (Exception error) { Log.Write("site window message failed: " + error.GetType().Name); }
        }

        public void Navigate(int port, string token)
        {
            this.port = port;
            if (!ready) return;
            web.CoreWebView2.Navigate("http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "/?k=" + token);
        }

        public void ShowMessage(string text)
        {
            if (!ready) return;
            string bg = ColorTranslator.ToHtml(Palette.Paper(dark)), ink = ColorTranslator.ToHtml(Palette.Ink(dark));
            allowNextDocument = true;
            web.CoreWebView2.NavigateToString("<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><body style=\"margin:0;padding:40px 28px;background:" + bg + ";color:" + ink + ";font:14px/1.65 'Segoe UI','Microsoft YaHei UI',sans-serif\"><h1 style=\"margin:0 0 16px;font:400 40px/1.1 'Sitka Heading',Georgia,'Noto Serif SC',SimSun,serif;letter-spacing:-.02em\">biubiu AI</h1><p style=\"margin:0;max-width:30em\">" + WebUtility.HtmlEncode(text) + "</p></body></html>");
        }

        public void ApplyTheme(bool isDark)
        {
            dark = isDark;
            themeKnown = true;
            BackColor = Palette.Paper(dark);
            grip.BackColor = BackColor;
            bar.SetDark(dark);
            web.DefaultBackgroundColor = BackColor;
            Native.TrySetBorderColor(Handle, Palette.Line(dark));
            PostTheme();
        }

        void PostTheme()
        {
            if (!ready || !themeKnown) return;
            try { web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"theme\",\"theme\":\"" + (dark ? "dark" : "light") + "\"}"); }
            catch (Exception e) { Log.Write("theme message failed: " + e.GetType().Name); }
        }

        // WinForms does not pass the form's hiding on to the web view, so the page never sees visibilitychange.
        // Telling it directly lets the page mask revealed keys whenever the panel collapses or hides with ZCode, and
        // read the site balance only while the panel is shown. The page may load in a hidden panel, or in one shown
        // before it listened, so it says "ready" once it listens and gets the panel's state then.
        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            PostPanel();
        }

        void PostPanel()
        {
            if (!ready) return;
            SetMemoryTarget();
            try { web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"panel\",\"visible\":" + (Visible ? "true" : "false") + "}"); }
            catch (Exception error) { Log.Write("panel message failed: " + error.GetType().Name); }
        }

        // Hidden, collapsed to its tab or with ZCode, the panel lets WebView2 trim the memory of the page and of its
        // browser and GPU processes: about 115 MB once the panel has been shown, a few MB some 30 seconds after it hides.
        // Scripts keep running, so the page still hears that the panel hid; shown again, WebView2 takes back what it
        // needs. A runtime without the setting keeps its memory as before.
        void SetMemoryTarget()
        {
            if (memoryTargetUnavailable) return;
            try { web.CoreWebView2.MemoryUsageTargetLevel = Visible ? CoreWebView2MemoryUsageTargetLevel.Normal : CoreWebView2MemoryUsageTargetLevel.Low; }
            catch (Exception error) { memoryTargetUnavailable = true; Log.Write("webview memory target unavailable: " + error.GetType().Name); }
        }

        public void FocusWeb()
        {
            try { web.Focus(); } catch (Exception) { }
        }

        public void Reload()
        {
            if (ready) try { web.CoreWebView2.Reload(); } catch (Exception) { }
        }
    }

    // The collapsed state: a small tab on ZCode's right edge that never takes focus.
    sealed class TabForm : Form
    {
        public event EventHandler Clicked;
        readonly ToolTip tip = new ToolTip();
        bool dark, hover, rounded;
        double scale = 1;

        public TabForm()
        {
            Text = "biubiu AI";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            Cursor = Cursors.Hand;
            Bounds = new Rectangle(-32000, -32000, 28, 92);
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            tip.SetToolTip(this, "展开 biubiu AI（Ctrl+Alt+M）");
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
                return cp;
            }
        }

        // Rounded like the panel; Windows 11 draws the corners and the border, in Frame's color. Where it cannot, the tab
        // stays square and paints its own frame.
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            rounded = Native.TrySetCorner(Handle, Native.DWMWCP_ROUND);
            Native.TrySetBorderColor(Handle, Frame);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_MOUSEACTIVATE) { m.Result = (IntPtr)Native.MA_NOACTIVATE; return; }
            base.WndProc(ref m);
        }

        public void ApplyTheme(bool isDark)
        {
            if (dark == isDark) return;
            dark = isDark;
            Restyle();
        }

        // At rest the tab is outlined like the page's small buttons; on hover ink and paper swap places. The system
        // border, where Windows draws one, takes the same color as the painted frame.
        Color Frame { get { return hover ? Palette.Ink(dark) : Palette.Edge(dark); } }

        void Restyle()
        {
            Native.TrySetBorderColor(Handle, Frame);
            Invalidate();
        }

        public void SetScale(double value)
        {
            if (Math.Abs(scale - value) < 0.01) return;
            scale = value;
            Invalidate();
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Restyle(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Restyle(); base.OnMouseLeave(e); }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button == MouseButtons.Left && ClientRectangle.Contains(e.Location)) { var handler = Clicked; if (handler != null) handler(this, EventArgs.Empty); }
        }

        // The mark in the tab's own colours: the hand in ink (paper while hovered, when they swap), the sparkles orange.
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(hover ? Palette.Ink(dark) : Palette.Paper(dark));
            if (!rounded) using (var pen = new Pen(Frame, 1f)) g.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
            float size = Width * 0.72f;
            Logo.Draw(g, new RectangleF((Width - size) / 2f, (Height - size) / 2f, size, size), hover ? Palette.Paper(dark) : Palette.Ink(dark), Logo.Accent);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) tip.Dispose();
            base.Dispose(disposing);
        }
    }

    // The tray icon's menu, drawn like the panel instead of in WinForms' default look: paper and ink in the panel's theme,
    // the mark and the version on top, hairlines between groups, a rounded wash under the pointer, and the panel's own
    // round option marks and check boxes. Windows 11 rounds its corners and draws the border and shadow, as it does for
    // the panel; where it cannot, the menu frames itself with a square hairline.
    //
    // The rows are laid out here, not by WinForms, whose menu layout puts text and images at fixed offsets from the top
    // of a row and keeps its own padding: every row has a fixed height, marks are centred on one column, the text starts
    // after it and the hotkey (or, on the title row, the version) ends the row.
    sealed class TrayMenu : ContextMenuStrip
    {
        // What a row shows in the mark column: nothing, one choice of a group, an on/off check box, or the mark.
        public enum Mark { None, Option, Check, Logo }

        // Geometry in device-independent pixels.
        public const float MarkCenter = 22, TextLeft = 40, RightPad = 16, AsideGap = 28, RowHeight = 34, TitleHeight = 46,
            RuleHeight = 11, Edge = 6, MinWidth = 224;
        public const TextFormatFlags TextFlags = TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding | TextFormatFlags.VerticalCenter;

        // Rows with a mark carry this empty image, so that WinForms asks the renderer to draw their image.
        readonly Bitmap slot = new Bitmap(1, 1, PixelFormat.Format32bppArgb);
        // GDI quietly draws a missing family in Microsoft Sans Serif, so each font names what it can fall back on.
        readonly Font body = new Font(Installed("Microsoft YaHei UI", "Segoe UI"), 9.75f);
        readonly Font heading = new Font(Installed("Sitka Heading", "Georgia", "Segoe UI"), 11.25f);
        readonly ToolStripMenuItem title;
        bool dark, rounded;
        float unit = 1f;

        public TrayMenu()
        {
            Renderer = new TrayMenuRenderer(this);
            ShowImageMargin = true;
            ShowCheckMargin = false;
            // Windows 11 draws a shadow that follows the rounded corners; the classic drop shadow is square.
            DropShadowEnabled = false;
            Font = body;
            // The title row is not a command: disabled, it is never highlighted and a click leaves the menu open.
            title = new TitleItem { Text = "biubiu AI", ShortcutKeyDisplayString = "v" + Program.Version, Tag = Mark.Logo, Image = slot, Enabled = false, Font = heading };
            Items.Add(title);
            AddSeparator();
        }

        public bool Dark { get { return dark; } }
        public bool Rounded { get { return rounded; } }
        // One device-independent pixel at the screen's DPI.
        public float Unit { get { return unit; } }

        public ToolStripMenuItem Add(string text, Action click, Mark mark = Mark.None)
        {
            var item = new ToolStripMenuItem(text, mark == Mark.None ? null : slot, (s, e) => click()) { Tag = mark };
            Items.Add(item);
            Arrange();
            return item;
        }

        public void AddSeparator()
        {
            Items.Add(new ToolStripSeparator());
            Arrange();
        }

        public void ApplyTheme(bool isDark)
        {
            dark = isDark;
            if (IsHandleCreated) Native.TrySetBorderColor(Handle, Palette.Line(dark));
            Invalidate();
        }

        // The hotkey or, on the title row, the version, written muted at the right end of the row.
        public static string Aside(ToolStripMenuItem row) { return string.IsNullOrEmpty(row.ShortcutKeyDisplayString) ? null : row.ShortcutKeyDisplayString; }

        public int Px(float dip) { return (int)Math.Round(dip * unit); }

        // Measures the rows and sizes the menu. Sizes follow the screen's DPI, which the fonts (in points) are drawn at
        // too; a menu's own DeviceDpi stays 96 until it shows.
        void Arrange()
        {
            using (var g = Graphics.FromHwnd(IntPtr.Zero)) unit = Math.Max(1f, g.DpiX / 96f);
            int width = Px(MinWidth), height = 2 * Px(Edge);
            foreach (ToolStripItem item in Items)
            {
                var row = item as ToolStripMenuItem;
                if (row == null) continue;
                int need = Px(TextLeft) + TextRenderer.MeasureText(row.Text, row.Font, Size.Empty, TextFlags).Width + Px(RightPad);
                string aside = Aside(row);
                if (aside != null) need += Px(AsideGap) + TextRenderer.MeasureText(aside, body, Size.Empty, TextFlags).Width;
                width = Math.Max(width, need);
            }
            SuspendLayout();
            AutoSize = false;
            foreach (ToolStripItem item in Items)
            {
                item.AutoSize = false;
                item.Size = new Size(width, Px(item is ToolStripSeparator ? RuleHeight : item == title ? TitleHeight : RowHeight));
                if (item.Available) height += item.Height;
            }
            Size = new Size(width, height);
            ResumeLayout(true);
        }

        // The tray has already placed the menu by its size when it opens. Texts filled in for this opening, or a change
        // of DPI, can still change that size: the corner nearest the pointer stays where the tray put it.
        protected override void OnOpening(System.ComponentModel.CancelEventArgs e)
        {
            base.OnOpening(e);
            if (e.Cancel) return;
            var placed = Bounds;
            Arrange();
            if (Size == placed.Size) return;
            var pointer = Cursor.Position;
            bool right = Math.Abs(pointer.X - placed.Right) < Math.Abs(pointer.X - placed.Left);
            bool bottom = Math.Abs(pointer.Y - placed.Bottom) < Math.Abs(pointer.Y - placed.Top);
            Location = new Point(right ? placed.Right - Width : placed.Left, bottom ? placed.Bottom - Height : placed.Top);
        }

        // WinForms keeps 2 px of its own above the first row and indents separators; the rows are stacked again, full
        // width, below an even margin.
        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e);
            int y = Px(Edge);
            foreach (ToolStripItem item in Items)
            {
                if (!item.Available) continue;
                SetItemLocation(item, new Point(0, y));
                y += item.Height;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            rounded = Native.TrySetCorner(Handle, Native.DWMWCP_ROUND);
            Native.TrySetBorderColor(Handle, Palette.Line(dark));
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (!disposing) return;
            slot.Dispose();
            body.Dispose();
            heading.Dispose();
        }

        static string Installed(params string[] families)
        {
            foreach (var name in families)
            {
                try { using (new FontFamily(name)) return name; }
                catch (ArgumentException) { }
            }
            return "Segoe UI";
        }

        // Keyboard navigation skips the title row.
        sealed class TitleItem : ToolStripMenuItem { public override bool CanSelect { get { return false; } } }
    }

    sealed class TrayMenuRenderer : ToolStripRenderer
    {
        readonly TrayMenu menu;

        public TrayMenuRenderer(TrayMenu menu) { this.menu = menu; }

        static TrayMenu.Mark MarkOf(ToolStripItem item) { return item.Tag is TrayMenu.Mark ? (TrayMenu.Mark)item.Tag : TrayMenu.Mark.None; }

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) { e.Graphics.Clear(Palette.Paper(menu.Dark)); }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            if (menu.Rounded) return;
            using (var pen = new Pen(Palette.Edge(menu.Dark))) e.Graphics.DrawRectangle(pen, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
        }

        // No gray column behind the marks.
        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }

        // The pointer, or the keyboard, rests on an item: a rounded wash, as on the panel's rows.
        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            if (!e.Item.Selected || !e.Item.Enabled) return;
            var g = e.Graphics;
            float u = menu.Unit, inset = 6 * u;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Shapes.Rounded(new RectangleF(inset, 0.5f * u, e.Item.Width - 2 * inset, e.Item.Height - u), 6 * u))
            using (var brush = new SolidBrush(Palette.Hover(menu.Dark))) g.FillPath(brush, path);
        }

        // Commands in ink; the hotkey (and the version on the title row) muted, as the panel writes its hints.
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            var row = e.Item as ToolStripMenuItem;
            if (row == null) { base.OnRenderItemText(e); return; }
            bool title = MarkOf(row) == TrayMenu.Mark.Logo, aside = e.Text != row.Text;
            int left = menu.Px(TrayMenu.TextLeft), right = row.Width - menu.Px(TrayMenu.RightPad);
            var bounds = new Rectangle(left, 0, Math.Max(0, right - left), row.Height);
            Color color = aside || (!row.Enabled && !title) ? Palette.Muted(menu.Dark) : Palette.Ink(menu.Dark);
            TextRenderer.DrawText(e.Graphics, e.Text, aside ? menu.Font : row.Font, bounds, color,
                TrayMenu.TextFlags | (aside ? TextFormatFlags.Right : TextFormatFlags.Left | TextFormatFlags.EndEllipsis));
        }

        // Checked items show their state in the mark column instead (OnRenderItemImage).
        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e) { }

        protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e)
        {
            var mark = MarkOf(e.Item);
            if (mark == TrayMenu.Mark.None) return;
            var g = e.Graphics;
            float u = menu.Unit;
            bool dark = menu.Dark, on = e.Item is ToolStripMenuItem && ((ToolStripMenuItem)e.Item).Checked;
            // Centred on the mark column and the row, wherever WinForms would have put the image.
            float x = menu.Px(TrayMenu.MarkCenter), y = e.Item.Height / 2f;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            if (mark == TrayMenu.Mark.Logo)
            {
                float size = 24 * u;
                Logo.Draw(g, new RectangleF(x - size / 2f, y - size / 2f, size, size), Palette.Ink(dark), Logo.Accent);
                return;
            }
            float d = 14 * u;
            var box = new RectangleF(x - d / 2f, y - d / 2f, d, d);
            if (mark == TrayMenu.Mark.Option)
            {
                // One of a group: a ring, with an ink dot in the chosen one.
                using (var pen = new Pen(on ? Palette.Ink(dark) : Palette.Edge(dark), u)) g.DrawEllipse(pen, box);
                float dot = 6 * u;
                if (on) using (var brush = new SolidBrush(Palette.Ink(dark))) g.FillEllipse(brush, box.X + (d - dot) / 2f, box.Y + (d - dot) / 2f, dot, dot);
                return;
            }
            // On or off: the panel's check box, an outlined rounded square that fills with ink and shows a paper tick.
            using (var path = Shapes.Rounded(box, 3.5f * u))
            {
                if (on) using (var brush = new SolidBrush(Palette.Ink(dark))) g.FillPath(brush, path);
                else using (var pen = new Pen(Palette.Edge(dark), u)) g.DrawPath(pen, path);
            }
            if (on)
                using (var pen = new Pen(Palette.Paper(dark), 1.5f * u) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                    g.DrawLines(pen, new[] { new PointF(box.X + 3.6f * u, box.Y + 7.3f * u), new PointF(box.X + 6.1f * u, box.Y + 9.7f * u), new PointF(box.X + 10.6f * u, box.Y + 4.7f * u) });
        }

        // Groups part with a hairline, as the panel's sections do.
        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            int y = e.Item.Height / 2, inset = menu.Px(12);
            using (var pen = new Pen(Palette.Line(menu.Dark), 1f)) e.Graphics.DrawLine(pen, inset, y, e.Item.Width - inset, y);
        }
    }

    static class Shapes
    {
        // A rectangle with round corners of the given radius, for GDI+ to fill.
        public static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var path = new GraphicsPath();
            float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            path.AddArc(r.Left, r.Top, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    static class Json
    {
        // A JSON string literal that is also safe inside a script.
        public static string Quote(string value)
        {
            var sb = new StringBuilder(value.Length + 2).Append('"');
            foreach (char c in value)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < 0x20 || c == '<' || c == '>' || c == '&' || c == '\'' || c == '\u2028' || c == '\u2029') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        // JSON text as dictionaries (objects), lists (arrays), strings, doubles, booleans and nulls; anything else is a
        // FormatException. Enough for GitHub's answer about a release, without loading a serializer into the companion.
        public static object Parse(string text)
        {
            int i = 0;
            object value = Value(text, ref i, 0);
            Space(text, ref i);
            if (i != text.Length) throw new FormatException("text after the value");
            return value;
        }

        static void Space(string s, ref int i) { while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++; }

        static object Value(string s, ref int i, int depth)
        {
            if (depth > 64) throw new FormatException("nested too deeply");
            Space(s, ref i);
            if (i >= s.Length) throw new FormatException("the text ends early");
            char c = s[i];
            if (c == '{')
            {
                var map = new Dictionary<string, object>(StringComparer.Ordinal);
                i++; Space(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return map; }
                while (true)
                {
                    Space(s, ref i);
                    if (i >= s.Length || s[i] != '"') throw new FormatException("a name was expected");
                    string name = Text(s, ref i);
                    Space(s, ref i);
                    if (i >= s.Length || s[i] != ':') throw new FormatException("':' was expected");
                    i++;
                    map[name] = Value(s, ref i, depth + 1);
                    Space(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == '}') { i++; return map; }
                    throw new FormatException("',' or '}' was expected");
                }
            }
            if (c == '[')
            {
                var list = new List<object>();
                i++; Space(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(Value(s, ref i, depth + 1));
                    Space(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == ']') { i++; return list; }
                    throw new FormatException("',' or ']' was expected");
                }
            }
            if (c == '"') return Text(s, ref i);
            if (Word(s, ref i, "true")) return true;
            if (Word(s, ref i, "false")) return false;
            if (Word(s, ref i, "null")) return null;
            int start = i;
            while (i < s.Length && ((s[i] >= '0' && s[i] <= '9') || s[i] == '-' || s[i] == '+' || s[i] == '.' || s[i] == 'e' || s[i] == 'E')) i++;
            double number;
            if (i == start || !double.TryParse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out number))
                throw new FormatException("unexpected character");
            return number;
        }

        static bool Word(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) return false;
            i += word.Length;
            return true;
        }

        static string Text(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++;
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                char escaped = s[i++];
                switch (escaped)
                {
                    case '"': case '\\': case '/': sb.Append(escaped); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        int code;
                        if (i + 4 > s.Length || !int.TryParse(s.Substring(i, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code))
                            throw new FormatException("a broken escape");
                        sb.Append((char)code);
                        i += 4;
                        break;
                    default: throw new FormatException("a broken escape");
                }
            }
            throw new FormatException("a string does not end");
        }
    }

    // A release on GitHub as the update check reads it: its version and page, and its installer's address, size and
    // SHA-256 (no installer, or no SHA-256, when GitHub names none).
    sealed class Release
    {
        public string Version, Page, Installer, Sha256;
        public long Size;
        public bool Checkable { get { return Installer != null && Sha256 != null; } }
    }

    // Updates come from the repository's GitHub Releases. Only a copy the installer put in place (uninstall.list beside
    // bin\) looks for them: a couple of minutes after it starts, then twice a day, and whenever the user asks. It reads
    // the latest release (GitHub leaves out drafts and prereleases), tagged v<version>, and its asset
    // biubiuAI-Setup-<version>.exe. Updating is the user's call. The installer is downloaded into the temp folder,
    // through the system proxy, and runs only when its size and SHA-256 match what GitHub records for the asset; it runs
    // silently into this installation (--update: the desktop shortcut and the start at sign-in stay as they are), quits
    // the companion and starts the new version. MODEL_HARBOR_UPDATE_URL names a stand-in for the latest release, for tests,
    // or "off" to never look.
    static class Updates
    {
        public const string Repository = "https://github.com/drhhhao/Zcode-biubiuAI";
        const string LatestRelease = "https://api.github.com/repos/drhhhao/Zcode-biubiuAI/releases/latest";
        static readonly string Override = (Environment.GetEnvironmentVariable("MODEL_HARBOR_UPDATE_URL") ?? "").Trim();

        static bool Off { get { return Override.Equals("off", StringComparison.OrdinalIgnoreCase); } }
        public static bool StandIn { get { return Override.Length > 0 && !Off; } }
        public static string InstallDir { get { return Path.GetFullPath(Path.Combine(Paths.AppDir, "..")); } }
        public static bool Enabled { get { return !Off && File.Exists(Path.Combine(InstallDir, "uninstall.list")); } }
        public static string Folder { get { return Path.Combine(Path.GetTempPath(), "biubiu-ai-update"); } }
        public static string InstallerName(string version) { return "biubiuAI-Setup-" + version + ".exe"; }

        public static bool IsVersion(string text)
        {
            System.Version parsed;
            return TryVersion(text, out parsed);
        }

        static bool TryVersion(string text, out System.Version version)
        {
            version = null;
            return text != null && Regex.IsMatch(text, @"^\d{1,6}(\.\d{1,6}){1,3}$") && System.Version.TryParse(text, out version);
        }

        public static bool IsNewer(string candidate, string current)
        {
            System.Version a, b;
            return TryVersion(candidate, out a) && TryVersion(current, out b) && a > b;
        }

        // GitHub's answer for the latest release; null unless it names a version (tag v<version>). The installer is the
        // asset named for that version, taken only from the repository's own release downloads (or the stand-in's).
        public static Release Read(string json)
        {
            var root = Json.Parse(json) as Dictionary<string, object>;
            if (root == null) return null;
            string tag = Field(root, "tag_name") as string;
            if (tag == null || (Field(root, "draft") as bool?) == true || (Field(root, "prerelease") as bool?) == true) return null;
            string version = tag.StartsWith("v", StringComparison.OrdinalIgnoreCase) ? tag.Substring(1) : tag;
            if (!IsVersion(version)) return null;
            string page = Field(root, "html_url") as string;
            var release = new Release { Version = version, Page = page != null && page.StartsWith(Repository + "/releases/", StringComparison.Ordinal) ? page : Repository + "/releases/latest" };
            var assets = Field(root, "assets") as List<object>;
            if (assets == null) return release;
            foreach (var item in assets)
            {
                var asset = item as Dictionary<string, object>;
                if (asset == null || !string.Equals(Field(asset, "name") as string, InstallerName(version), StringComparison.OrdinalIgnoreCase)) continue;
                string url = Field(asset, "browser_download_url") as string;
                bool fromRepository = url != null && url.StartsWith(Repository + "/releases/download/", StringComparison.Ordinal);
                bool fromStandIn = StandIn && url != null && url.StartsWith("http://127.0.0.1:", StringComparison.Ordinal);
                if (!fromRepository && !fromStandIn) continue;
                release.Installer = url;
                double? size = Field(asset, "size") as double?;
                release.Size = size.HasValue && size.Value > 0 && size.Value < 1e10 ? (long)size.Value : 0;
                string digest = Field(asset, "digest") as string;
                if (digest != null && Regex.IsMatch(digest, "^sha256:[0-9a-fA-F]{64}$")) release.Sha256 = digest.Substring(7).ToLowerInvariant();
                break;
            }
            return release;
        }

        static object Field(Dictionary<string, object> map, string name)
        {
            object value;
            return map.TryGetValue(name, out value) ? value : null;
        }

        // Blocking calls, made off the UI thread: only they keep the timeouts (an asynchronous WebRequest has none).
        public static Release Latest()
        {
            var request = Request(StandIn ? Override : LatestRelease);
            request.Accept = "application/vnd.github+json";
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                return Read(reader.ReadToEnd());
        }

        // Into an empty download folder; progress gets whole percentages.
        public static string Download(Release release, Action<int> progress)
        {
            Clean();
            Directory.CreateDirectory(Folder);
            string file = Path.Combine(Folder, InstallerName(release.Version));
            using (var response = Request(release.Installer).GetResponse())
            using (var input = response.GetResponseStream())
            using (var output = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                long total = release.Size > 0 ? release.Size : response.ContentLength, done = 0;
                var buffer = new byte[81920];
                int read, shown = -1;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    done += read;
                    if (release.Size > 0 && done > release.Size) throw new InvalidDataException("the download is larger than GitHub says");
                    output.Write(buffer, 0, read);
                    int percent = total > 0 ? (int)Math.Min(100, 100 * done / total) : 0;
                    if (percent != shown) { shown = percent; progress(percent); }
                }
            }
            return file;
        }

        // Through the system proxy, as the user's browser goes; GitHub wants a User-Agent.
        static HttpWebRequest Request(string url)
        {
            // GitHub takes TLS 1.2 and later. Built for .NET 4.8, the companion lets Windows choose; an older default
            // would offer only TLS 1.0, so TLS 1.2 is added to it.
            var protocols = ServicePointManager.SecurityProtocol;
            if (protocols != SecurityProtocolType.SystemDefault && (protocols & SecurityProtocolType.Tls12) == 0)
                ServicePointManager.SecurityProtocol = protocols | SecurityProtocolType.Tls12;
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.UserAgent = "biubiu-ai/" + Program.Version + " (+" + Repository + ")";
            request.Timeout = 30000;
            request.ReadWriteTimeout = 60000;
            request.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            if (request.Proxy != null) request.Proxy.Credentials = CredentialCache.DefaultCredentials;
            return request;
        }

        // Null when the file is the installer GitHub describes; otherwise "size" or "sha256".
        public static string Mismatch(string file, Release release)
        {
            if (release.Size > 0 && new FileInfo(file).Length != release.Size) return "size";
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(file))
            {
                var hash = sha.ComputeHash(stream);
                var hex = new StringBuilder(64);
                foreach (byte b in hash) hex.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return hex.ToString() == release.Sha256 ? null : "sha256";
            }
        }

        // Silently into this installation; the installer quits the companion and starts the new version when it is done.
        public static Process Run(string file)
        {
            string dir = InstallDir;
            string arguments = "--silent --update --launch --dir \"" + (dir.EndsWith("\\", StringComparison.Ordinal) ? dir + "\\" : dir) + "\"";
            return Process.Start(new ProcessStartInfo(file, arguments) { UseShellExecute = false, WorkingDirectory = Folder });
        }

        // What an earlier download left; a file still in use stays until the next time.
        public static void Clean()
        {
            try
            {
                foreach (var file in Directory.GetFiles(Folder))
                    try { File.Delete(file); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        // For the user: why a check or a download did not work.
        public static string Describe(Exception e)
        {
            var web = e as WebException;
            if (web != null && web.Status == WebExceptionStatus.ProtocolError && web.Response is HttpWebResponse)
            {
                int status = (int)((HttpWebResponse)web.Response).StatusCode;
                return "GitHub 返回 HTTP " + status.ToString(CultureInfo.InvariantCulture) + (status == 403 || status == 429 ? "（访问太频繁时会这样）" : "");
            }
            if (web != null && web.Status == WebExceptionStatus.Timeout) return "连接 GitHub 超时";
            if (web != null) return "连不上 GitHub";
            if (e is InvalidDataException) return "下载的文件比 GitHub 记录的大";
            if (e is FormatException) return "看不懂 GitHub 的回复";
            if (e is IOException || e is UnauthorizedAccessException) return "无法写入临时文件夹";
            return "出了点问题（" + e.GetType().Name + "）";
        }

        // For the log: the kind of failure, never an address.
        public static string LogText(Exception e)
        {
            var web = e as WebException;
            if (web != null && web.Status == WebExceptionStatus.ProtocolError && web.Response is HttpWebResponse)
                return "HTTP " + ((int)((HttpWebResponse)web.Response).StatusCode).ToString(CultureInfo.InvariantCulture);
            return web != null ? web.Status.ToString() : e.GetType().Name;
        }
    }

    // The site in a window of its own, signed in as the panel's account; the link under the site balance opens it.
    // The site's pages keep their sign-in in their own storage and renew it at /api/auth/refresh. The window starts them
    // with a placeholder sign-in, no access token and a random marker for the refresh token, so their first request
    // renews. The host answers every renewal that carries the marker itself, with an access token Node hands over
    // (Site.handoff), and lets any other request through untouched. The refresh token never leaves Node, so the window
    // and the panel never renew past each other. The window is InPrivate, so nothing of the sign-in is written to disk;
    // it shows only the site, opens other addresses in the default browser, and the site cannot message the host.
    sealed class SiteForm : Form
    {
        public const string SiteOrigin = "https://ro.biubiu007.com";
        readonly WebView2 web = new WebView2();
        readonly string origin, refreshPath = "/api/auth/refresh", marker;
        readonly Func<Task<HostReply>> ask;
        readonly Action<string> openOutside;
        readonly bool devTools, dark;
        CoreWebView2Environment environment;
        string bootstrap;
        DateTime lastOutside = DateTime.MinValue;

        public SiteForm(string origin, Func<Task<HostReply>> ask, Action<string> openOutside, bool devTools, bool dark, Icon icon)
        {
            this.origin = origin; this.ask = ask; this.openOutside = openOutside; this.devTools = devTools; this.dark = dark;
            var bytes = new byte[24];
            using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(bytes);
            marker = "model-harbor-" + BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
            Text = Title(null);
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            if (icon != null) Icon = icon;
            BackColor = Color.White;
            web.DefaultBackgroundColor = Color.White;
            web.Dock = DockStyle.Fill;
            Controls.Add(web);
        }

        public static void OpenInBrowser(string url) { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }

        static string Title(string page) { return string.IsNullOrWhiteSpace(page) ? "biubiu AI" : page.Trim(); }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Native.TrySetDarkTitle(Handle, dark);
        }

        // Centered on the work area it is given, at most 1280 by 860 (scaled).
        public void PlaceIn(Rectangle work, double scale)
        {
            int w = Math.Max(Math.Min(work.Width, (int)(480 * scale)), Math.Min(work.Width - (int)(48 * scale), (int)(1280 * scale)));
            int h = Math.Max(Math.Min(work.Height, (int)(400 * scale)), Math.Min(work.Height - (int)(48 * scale), (int)(860 * scale)));
            MinimumSize = new Size(Math.Min(w, (int)(400 * scale)), Math.Min(h, (int)(320 * scale)));
            Bounds = new Rectangle(work.Left + (work.Width - w) / 2, work.Top + (work.Height - h) / 2, w, h);
        }

        public void Present()
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        public async Task OpenAsync(CoreWebView2Environment shared)
        {
            var options = shared.CreateCoreWebView2ControllerOptions();
            options.ProfileName = "site";
            options.IsInPrivateModeEnabled = true;
            await web.EnsureCoreWebView2Async(shared, options);
            if (IsDisposed || web.CoreWebView2 == null) return;
            environment = shared;
            var core = web.CoreWebView2;
            var settings = core.Settings;
            settings.AreDevToolsEnabled = devTools;
            settings.AreHostObjectsAllowed = false;
            settings.IsWebMessageEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            core.NavigationStarting += OnNavigationStarting;
            core.NewWindowRequested += OnNewWindowRequested;
            core.PermissionRequested += (s, e) => e.State = CoreWebView2PermissionState.Deny;
            core.DocumentTitleChanged += (s, e) => Text = Title(core.DocumentTitle);
            core.ProcessFailed += (s, e) =>
            {
                Log.Write("site window process failed: " + e.ProcessFailedKind);
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                    try { core.Reload(); } catch (Exception) { }
            };
            core.AddWebResourceRequestedFilter(origin + refreshPath, CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnWebResourceRequested;
            bootstrap = await core.AddScriptToExecuteOnDocumentCreatedAsync(BootstrapScript());
            if (IsDisposed) return;
            core.NavigationCompleted += OnNavigationCompleted;
            // Signed in, the site's login page moves on to the account's own home page.
            core.Navigate(origin + "/login");
        }

        // Runs in the site's first document only (OnNavigationCompleted removes it), so a later reload keeps whatever
        // sign-in the site has by then, signed out included.
        string BootstrapScript()
        {
            return "(() => { if (location.origin !== " + Json.Quote(origin) + ") return; try {"
                + " localStorage.setItem('auth_session', JSON.stringify({ sessionId: 'model-harbor', version: 1, accessToken: null, refreshToken: " + Json.Quote(marker) + " }));"
                + " localStorage.removeItem('access_token'); localStorage.removeItem('refresh_token');"
                + " } catch (e) { } })();";
        }

        void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (bootstrap == null || !e.IsSuccess || !IsSite(web.CoreWebView2.Source)) return;
            try { web.CoreWebView2.RemoveScriptToExecuteOnDocumentCreated(bootstrap); } catch (Exception) { }
            bootstrap = null;
        }

        bool IsSite(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return false;
            if (uri.StartsWith("blob:", StringComparison.Ordinal)) uri = uri.Substring(5);
            Uri parsed;
            return Uri.TryCreate(uri, UriKind.Absolute, out parsed) && string.Equals(parsed.GetLeftPart(UriPartial.Authority), origin, StringComparison.OrdinalIgnoreCase);
        }

        void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (IsSite(e.Uri) || e.Uri == "about:blank") return;
            e.Cancel = true;
            Outside(e.Uri);
        }

        void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            if (IsSite(e.Uri)) web.CoreWebView2.Navigate(e.Uri); else Outside(e.Uri);
        }

        // Another address goes to the default browser: http and https only, and at most one a second, so a page cannot
        // flood the desktop with browser tabs. The address is not logged.
        void Outside(string uri)
        {
            Uri parsed;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out parsed) || (parsed.Scheme != Uri.UriSchemeHttps && parsed.Scheme != Uri.UriSchemeHttp)) return;
            if ((DateTime.UtcNow - lastOutside).TotalMilliseconds < 1000) return;
            lastOutside = DateTime.UtcNow;
            try { openOutside(parsed.AbsoluteUri); }
            catch (Exception error) { Log.Write("site window: the default browser did not open (" + error.GetType().Name + ")"); return; }
            Log.Write("site window: a link outside the site went to the default browser");
        }

        // The site's renewal with the marker is answered here, with an access token from Node; any other request keeps
        // its body and goes on to the site.
        async void OnWebResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            var request = e.Request;
            Uri target;
            if (request.Method != "POST" || !Uri.TryCreate(request.Uri, UriKind.Absolute, out target) || !IsSite(request.Uri) || target.AbsolutePath != refreshPath) return;
            byte[] body = ReadAll(request.Content);
            if (body == null) return;
            bool fromSite = !request.Headers.Contains("Origin") || string.Equals(request.Headers.GetHeader("Origin"), origin, StringComparison.OrdinalIgnoreCase);
            if (!fromSite || !CarriesMarker(body)) { request.Content = new MemoryStream(body); return; }
            var deferral = e.GetDeferral();
            try
            {
                HostReply reply;
                try { reply = await ask(); } catch (Exception) { reply = HostReply.Failed; }
                if (IsDisposed || environment == null) return;
                e.Response = Answer(reply);
                Log.Write(reply.SignedIn ? "site window: sign-in handed over" : reply.Answered ? "site window: the panel is signed out of the site" : "site window: the sign-in could not be renewed");
            }
            catch (Exception error) { Log.Write("site window: renewal failed (" + error.GetType().Name + ")"); }
            finally { deferral.Complete(); }
        }

        static byte[] ReadAll(Stream content)
        {
            if (content == null) return null;
            using (var copy = new MemoryStream())
            {
                content.CopyTo(copy);
                return copy.ToArray();
            }
        }

        bool CarriesMarker(byte[] body)
        {
            if (body.Length > 4096) return false;
            var match = Regex.Match(Encoding.UTF8.GetString(body), "\"refreshToken\"\\s*:\\s*\"([^\"\\\\]*)\"");
            return match.Success && string.Equals(match.Groups[1].Value, marker, StringComparison.Ordinal);
        }

        // Signed in: the token, with the marker again as the next refresh token. Signed out: 401, which the site takes as
        // the end of its sign-in and shows its login page. No answer: 503, which the site retries.
        CoreWebView2WebResourceResponse Answer(HostReply reply)
        {
            int status; string reason, json;
            if (reply.SignedIn && !string.IsNullOrEmpty(reply.Token)) { status = 200; reason = "OK"; json = "{\"accessToken\":" + Json.Quote(reply.Token) + ",\"refreshToken\":" + Json.Quote(marker) + "}"; }
            else if (reply.Answered) { status = 401; reason = "Unauthorized"; json = "{\"code\":401,\"message\":" + Json.Quote("biubiu AI 面板已退出这个账户，请重新登录。") + ",\"data\":null}"; }
            else { status = 503; reason = "Service Unavailable"; json = "{\"code\":503,\"message\":" + Json.Quote("biubiu AI 面板暂时无法续期登录，请稍后重试。") + ",\"data\":null}"; }
            return environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(json)), status, reason, "Content-Type: application/json; charset=utf-8\r\nCache-Control: no-store");
        }
    }

    sealed class Companion : ApplicationContext
    {
        const int HotKeyId = 0x4D48;
        readonly Options options;
        readonly Settings settings;
        readonly PanelForm panel = new PanelForm();
        readonly TabForm tab = new TabForm();
        readonly NotifyIcon tray = new NotifyIcon();
        readonly TrayMenu menu = new TrayMenu();
        readonly ToolStripMenuItem toggleItem, reloadItem, startupItem, dockRightItem, dockLeftItem, updateItem;
        readonly Icon trayIcon, appIcon;
        readonly IntPtr trayIconHandle;
        readonly ZCodeTracker tracker;
        readonly ServerProcess server = new ServerProcess();
        readonly HostState host = new HostState();
        readonly VirtualDesktop desktops = new VirtualDesktop();
        readonly System.Windows.Forms.Timer moveTimer = new System.Windows.Forms.Timer { Interval = 16 };
        readonly System.Windows.Forms.Timer settleTimer = new System.Windows.Forms.Timer { Interval = 100 };
        readonly System.Windows.Forms.Timer pollTimer = new System.Windows.Forms.Timer { Interval = 1000 };
        // Re-reads ZCode's theme after a reading that disagrees with the current one; ticks a little after
        // ThemeConfirmMs so the tick's own reading is old enough to count.
        readonly System.Windows.Forms.Timer themeTimer = new System.Windows.Forms.Timer { Interval = ThemeConfirmMs + 100 };
        // The first look for a newer version a couple of minutes after start-up (seconds, with a stand-in release), then
        // twice a day.
        readonly System.Windows.Forms.Timer updateTimer = new System.Windows.Forms.Timer { Interval = Updates.StandIn ? 3000 : 120000 };
        const int UpdateEveryMs = 12 * 60 * 60 * 1000;
        readonly EventWaitHandle showEvent, quitEvent, collapseEvent, expandEvent, checkUpdateEvent;
        readonly ManualResetEvent stopSignals = new ManualResetEvent(false);
        readonly Thread signalThread;
        const int ThemeConfirmMs = 500;
        bool expanded, layoutQueued, cleanedUp, shown, webReady, hotKeyRegistered;
        string theme, pendingTheme, failure, hiddenReason = "closed";
        int serverPort, pendingSince;
        Rectangle currentFrame;
        double currentScale = 1;
        Placement placement;
        SiteForm siteWindow;
        // A newer release once a check has found one; what the update is doing ("checking", "downloading", "installing",
        // or null); whether the question is open; whether the balloon on screen is the one that offers the update.
        Release update;
        string updating;
        int updatePercent;
        bool askingUpdate, balloonOffersUpdate;

        // Where the panel or tab sits: on which side of ZCode, outside its edge or along its inner edge,
        // and the screen x of the edge that stays put while the grip resizes the panel.
        struct Placement { public Rectangle Bounds; public bool Right, Inside; public int Anchor; }

        public Companion(Options options)
        {
            this.options = options;
            settings = Settings.Load();
            expanded = !options.Background && settings.Expanded;
            tracker = new ZCodeTracker(settings.ZCodeExe);

            IntPtr handle = panel.Handle;
            handle = tab.Handle;
            // Start in the theme ZCode had last time; SampleTheme keeps or corrects it once ZCode shows.
            theme = settings.Theme;
            if (theme != null) { panel.ApplyTheme(theme == "dark"); tab.ApplyTheme(theme == "dark"); }
            panel.HideRequested += (s, e) => Collapse();
            panel.CollapseRequested += (s, e) => Collapse();
            panel.HotKeyPressed += (s, e) => OnHotKey();
            panel.SiteRequested += (s, e) => OpenSite();
            panel.SiteSignedOut += (s, e) => { if (siteWindow != null) siteWindow.Close(); };
            panel.UpdateRequested += (s, e) => OnUpdateItem();
            panel.GripDrag += OnGripDrag;
            panel.GripDragEnd += (s, e) =>
            {
                if (expanded && !currentFrame.IsEmpty) settings.PanelWidthDip = Settings.Clamp(placement.Bounds.Width / currentScale, Settings.MinPanelDip, Settings.MaxPanelDip);
                settings.Save();
            };
            tab.Clicked += (s, e) => Expand(true);

            trayIcon = Logo.CreateTrayIcon(Math.Max(16, SystemInformation.SmallIconSize.Width), out trayIconHandle);
            appIcon = Logo.AppIcon();
            toggleItem = menu.Add("展开面板", () => Toggle());
            reloadItem = menu.Add("重新加载面板", () => Reload());
            menu.AddSeparator();
            dockRightItem = menu.Add("优先贴在 ZCode 右侧", () => SetDock(false), TrayMenu.Mark.Option);
            dockLeftItem = menu.Add("优先贴在 ZCode 左侧", () => SetDock(true), TrayMenu.Mark.Option);
            menu.AddSeparator();
            startupItem = menu.Add("登录 Windows 时在后台待命", () => ToggleStartup(), TrayMenu.Mark.Check);
            menu.Add("打开日志文件夹", () => OpenLogFolder());
            updateItem = menu.Add("检查更新", () => OnUpdateItem());
            menu.AddSeparator();
            menu.Add("退出 biubiu AI", () => ExitThread());
            menu.Opening += (s, e) =>
            {
                // In the panel's theme, which follows ZCode.
                menu.ApplyTheme(theme == "dark");
                toggleItem.Text = expanded ? "收起面板" : "展开面板";
                toggleItem.ShortcutKeyDisplayString = hotKeyRegistered ? "Ctrl+Alt+M" : null;
                reloadItem.Enabled = webReady;
                dockRightItem.Checked = !settings.PreferLeft;
                dockLeftItem.Checked = settings.PreferLeft;
                try { startupItem.Checked = Startup.IsEnabled(); } catch (Exception) { startupItem.Checked = false; }
                // Only a copy the installer put in place updates itself.
                updateItem.Available = Updates.Enabled;
                updateItem.Text = updating == "checking" ? "正在检查更新…" : updating == "downloading" ? "正在下载更新 " + updatePercent + "%" : updating == "installing" ? "正在安装更新…"
                    : update != null ? "更新到 " + update.Version + "…" : "检查更新";
                updateItem.Enabled = updating == null;
            };
            tray.Icon = trayIcon;
            tray.Text = "biubiu AI " + Program.Version;
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (s, e) => Toggle();
            tray.BalloonTipClicked += (s, e) => { if (balloonOffersUpdate) ConfirmUpdate(); };
            tray.Visible = true;
            SayUpdated();

            tracker.Changed += OnTrackerChanged;
            moveTimer.Tick += (s, e) => { if (!tracker.Moving) moveTimer.Stop(); DoLayout(); };
            settleTimer.Tick += (s, e) => { settleTimer.Stop(); DoLayout(); SampleTheme(); };
            pollTimer.Tick += (s, e) => { tracker.Refresh(); DoLayout(); SampleTheme(); };
            themeTimer.Tick += (s, e) => { themeTimer.Stop(); SampleTheme(); };
            updateTimer.Tick += (s, e) => { updateTimer.Interval = UpdateEveryMs; CheckForUpdate(false); };
            if (Updates.Enabled) updateTimer.Start();

            hotKeyRegistered = Native.RegisterHotKey(panel.Handle, HotKeyId, Native.MOD_CONTROL | Native.MOD_ALT | Native.MOD_NOREPEAT, 0x4D);
            if (!hotKeyRegistered) Log.Write("Ctrl+Alt+M is taken by another program; the hotkey is unavailable");

            showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowEventName);
            quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.QuitEventName);
            collapseEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.CollapseEventName);
            expandEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ExpandEventName);
            checkUpdateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.CheckUpdateEventName);
            signalThread = new Thread(WatchSignals) { IsBackground = true, Name = "model-harbor-signals" };
            signalThread.Start();

            server.Ready += port => Post(() => OnServerReady(port));
            server.Failed += message => Post(() => OnFailure(message));
            InitializeWeb();
            server.Start();
            tracker.Refresh();
            pollTimer.Start();
            DoLayout();
            GC.KeepAlive(handle);
        }

        void WatchSignals()
        {
            var handles = new WaitHandle[] { stopSignals, showEvent, quitEvent, collapseEvent, expandEvent, checkUpdateEvent };
            while (true)
            {
                int index = WaitHandle.WaitAny(handles);
                if (index == 0) return;
                if (index == 1) Post(() => Expand(true));
                else if (index == 3) Post(Collapse);
                else if (index == 4) Post(() => Expand(false));
                else if (index == 5) Post(() => CheckForUpdate(true));
                else { Post(() => ExitThread()); return; }
            }
        }

        void Post(Action action)
        {
            if (cleanedUp) return;
            try { panel.BeginInvoke((Action)(() => { if (!cleanedUp) action(); })); }
            catch (InvalidOperationException) { }
        }

        async void InitializeWeb()
        {
            try
            {
                await panel.InitializeAsync(Paths.WebViewData, Paths.AppDir, options.DevTools);
                if (cleanedUp) return;
                webReady = true;
                if (theme != null) panel.ApplyTheme(theme == "dark");
                if (failure != null) panel.ShowMessage(failure);
                else if (serverPort > 0) panel.Navigate(serverPort, server.Token);
            }
            catch (WebView2RuntimeNotFoundException) { OnFailure("没有找到 Microsoft Edge WebView2 Runtime。请安装后重新打开 biubiu AI。"); }
            catch (Exception e) { Log.Write("webview initialization failed: " + e); Notify("biubiu AI 面板初始化失败，详情见日志。"); }
        }

        void OnServerReady(int port)
        {
            serverPort = port;
            failure = null;
            host.SetEndpoint(port, server.Token);
            host.Post(theme, shown);
            if (webReady) panel.Navigate(port, server.Token);
        }

        void OnFailure(string message)
        {
            failure = message;
            Notify(message);
            if (webReady) panel.ShowMessage(message);
        }

        void Notify(string message)
        {
            balloonOffersUpdate = false;
            try { tray.ShowBalloonTip(5000, "biubiu AI", message, ToolTipIcon.Info); } catch (Exception) { }
        }

        void OnTrackerChanged(object sender, EventArgs e)
        {
            if (tracker.Moving && !moveTimer.Enabled) moveTimer.Start();
            settleTimer.Stop();
            settleTimer.Start();
            if (layoutQueued) return;
            layoutQueued = true;
            Post(DoLayout);
        }

        static int Px(double dip, double scale) { return (int)Math.Round(dip * scale); }

        void DoLayout()
        {
            layoutQueued = false;
            if (cleanedUp) return;
            IntPtr z = tracker.Window;
            if (z == IntPtr.Zero || !Native.IsWindow(z)) { tracker.Refresh(); z = tracker.Window; }
            Rectangle frame = Rectangle.Empty, work = Rectangle.Empty;
            double scale = 1;
            string reason = null;
            if (z == IntPtr.Zero || !Native.IsWindow(z) || !Native.IsWindowVisible(z) || Native.IsCloaked(z)) reason = "closed";
            else if (Native.IsIconic(z)) reason = "minimized";
            else if (!Native.TryGetFrame(z, out frame)) reason = "closed";
            else
            {
                scale = Native.ScaleFor(z);
                work = Native.WorkAreaFor(z);
                if (Native.IsZoomed(z) || CoversWorkArea(frame, work)) reason = "maximized";
                else if (frame.Width < Px(320, scale) || frame.Height < Px(240, scale)) reason = "small";
            }
            if (reason != hiddenReason)
            {
                hiddenReason = reason;
                Log.Write("zcode window " + (reason ?? "normal"));
            }
            if (reason != null)
            {
                HideForm(panel);
                HideForm(tab);
                currentFrame = Rectangle.Empty;
                CancelThemeChange();
                SetShown(false);
                return;
            }
            currentFrame = frame;
            currentScale = scale;

            Form target = expanded ? (Form)panel : tab;
            HideForm(expanded ? (Form)tab : panel);
            placement = expanded ? PanelPlacement(frame, work, scale) : TabPlacement(frame, work, scale);
            // The grip and the collapse arrow point away from ZCode's content: outward when docked
            // outside, inward when lying on ZCode. The collapse bar always faces ZCode's content.
            bool towardLeft = placement.Inside ? placement.Right : !placement.Right;
            if (expanded) panel.SetEdges(towardLeft, placement.Right, towardLeft, scale);
            else tab.SetScale(scale);
            Native.Place(target.Handle, placement.Bounds);
            if (!target.Visible) target.Show();
            Native.EnsureAbove(target.Handle, z);
            desktops.Follow(target.Handle, z);
            bool first = !shown;
            SetShown(true);
            if (first) SampleTheme();
        }

        // Maximized, full screen, or sized to fill the whole work area: the companion stays hidden.
        static bool CoversWorkArea(Rectangle frame, Rectangle work)
        {
            if (work.IsEmpty) return false;
            const int slack = 2;
            return frame.Left <= work.Left + slack && frame.Top <= work.Top + slack && frame.Right >= work.Right - slack && frame.Bottom >= work.Bottom - slack;
        }

        bool[] SideOrder() { return settings.PreferLeft ? new[] { false, true } : new[] { true, false }; }

        static int Room(Rectangle frame, Rectangle work, bool right)
        {
            if (work.IsEmpty) return int.MaxValue / 4;
            return right ? work.Right - frame.Right : frame.Left - work.Left;
        }

        // Outside ZCode's preferred edge when the screen has room for at least the minimum width there,
        // else outside the other edge, else along ZCode's own inner edge on the preferred side.
        Placement PanelPlacement(Rectangle frame, Rectangle work, double scale)
        {
            int want = Px(settings.PanelWidthDip, scale), min = Px(Settings.MinPanelDip, scale);
            int top = work.IsEmpty ? frame.Top : Math.Max(frame.Top, work.Top);
            int bottom = work.IsEmpty ? frame.Bottom : Math.Min(frame.Bottom, work.Bottom);
            if (bottom - top < Px(240, scale)) { top = frame.Top; bottom = frame.Bottom; }
            foreach (bool right in SideOrder())
            {
                int room = Room(frame, work, right);
                if (room < min) continue;
                int width = Math.Min(want, room);
                return right
                    ? new Placement { Bounds = Rectangle.FromLTRB(frame.Right, top, frame.Right + width, bottom), Right = true, Anchor = frame.Right }
                    : new Placement { Bounds = Rectangle.FromLTRB(frame.Left - width, top, frame.Left, bottom), Right = false, Anchor = frame.Left };
            }
            int margin = Px(8, scale);
            int innerTop = frame.Top + Px(settings.TopOffsetDip, scale);
            int innerBottom = Math.Max(innerTop + Px(200, scale), frame.Bottom - margin);
            int inner = Math.Min(want, Math.Max(Px(280, scale), (int)(frame.Width * 0.6)));
            if (!settings.PreferLeft)
            {
                int edge = frame.Right - margin;
                return new Placement { Bounds = Rectangle.FromLTRB(edge - inner, innerTop, edge, innerBottom), Right = true, Inside = true, Anchor = edge };
            }
            int start = frame.Left + margin;
            return new Placement { Bounds = Rectangle.FromLTRB(start, innerTop, start + inner, innerBottom), Right = false, Inside = true, Anchor = start };
        }

        // The collapsed tab goes on the side the panel would take, outside ZCode when it fits there.
        Placement TabPlacement(Rectangle frame, Rectangle work, double scale)
        {
            int w = Px(28, scale), h = Px(92, scale);
            int top = Math.Max(frame.Top, Math.Min(frame.Top + Px(settings.TopOffsetDip + 56, scale), frame.Bottom - h));
            bool right = PanelPlacement(frame, work, scale).Right;
            if (Room(frame, work, right) >= w)
                return right
                    ? new Placement { Bounds = new Rectangle(frame.Right, top, w, h), Right = true, Anchor = frame.Right }
                    : new Placement { Bounds = new Rectangle(frame.Left - w, top, w, h), Right = false, Anchor = frame.Left };
            int inset = Px(6, scale);
            return right
                ? new Placement { Bounds = new Rectangle(frame.Right - w - inset, top, w, h), Right = true, Inside = true, Anchor = frame.Right - inset }
                : new Placement { Bounds = new Rectangle(frame.Left + inset, top, w, h), Right = false, Inside = true, Anchor = frame.Left + inset };
        }

        static void HideForm(Form form) { if (form.Visible) form.Hide(); }

        void SetShown(bool value)
        {
            if (shown == value) return;
            shown = value;
            host.Post(theme, shown);
        }

        // For a moment after ZCode comes back from the taskbar, while Windows animates it, the screen still shows
        // what lay behind it in ZCode's place. So once a theme is known, from this run or saved by the last one, a
        // reading that disagrees switches it only if readings still disagree ThemeConfirmMs later, with none
        // agreeing or failing in between. Hiding with ZCode drops a pending switch.
        void SampleTheme()
        {
            double luminance = -1;
            if (!currentFrame.IsEmpty && tracker.Window != IntPtr.Zero)
            {
                Rectangle exclude = placement.Inside ? Rectangle.Inflate(placement.Bounds, Px(4, currentScale), Px(4, currentScale)) : Rectangle.Empty;
                try { luminance = ThemeSampler.Sample(tracker.Window, currentFrame, currentScale, exclude); }
                catch (Exception) { }
            }
            bool dark = theme == null ? luminance < 150 : theme == "dark" ? luminance < 160 : luminance < 140;
            string name = luminance < 0 ? null : dark ? "dark" : "light";
            if (name == null || name == theme) { CancelThemeChange(); return; }
            if (theme != null)
            {
                if (pendingTheme == null) { pendingTheme = name; pendingSince = Environment.TickCount; themeTimer.Start(); return; }
                if (unchecked(Environment.TickCount - pendingSince) < ThemeConfirmMs) return;
            }
            CancelThemeChange();
            theme = name;
            Log.Write("zcode theme " + name + " (luminance " + luminance.ToString("0", CultureInfo.InvariantCulture) + ")");
            settings.Theme = name;
            settings.Save();
            panel.ApplyTheme(dark);
            tab.ApplyTheme(dark);
            host.Post(theme, shown);
        }

        void CancelThemeChange()
        {
            pendingTheme = null;
            themeTimer.Stop();
        }

        void OnGripDrag(int screenX)
        {
            if (currentFrame.IsEmpty || !expanded) return;
            // The grip sits on the edge opposite the anchor, so the width is the distance between them.
            int width = placement.Right == placement.Inside ? placement.Anchor - screenX : screenX - placement.Anchor;
            settings.PanelWidthDip = Settings.Clamp(width / currentScale, Settings.MinPanelDip, Settings.MaxPanelDip);
            DoLayout();
        }

        void OnHotKey()
        {
            if (!expanded) Expand(true);
            else if (shown && Native.GetForegroundWindow() != panel.Handle) FocusPanel();
            else Collapse();
        }

        void Toggle() { if (expanded) Collapse(); else Expand(true); }

        void SetDock(bool left)
        {
            settings.PreferLeft = left;
            settings.Save();
            DoLayout();
        }

        string HiddenNotice()
        {
            switch (hiddenReason)
            {
                case "maximized": return "ZCode 正在最大化显示，biubiu AI 先隐藏。把 ZCode 还原成窗口后，面板会贴在它的侧边。";
                case "minimized": return "ZCode 已最小化。还原 ZCode 后，biubiu AI 会贴在它的侧边。";
                case "small": return "ZCode 窗口太小，biubiu AI 先隐藏。把 ZCode 窗口调大一些就会出现。";
                default: return "打开 ZCode 后，biubiu AI 会贴在 ZCode 窗口侧边。";
            }
        }

        void Expand(bool focus)
        {
            expanded = true;
            settings.Expanded = true;
            settings.Save();
            DoLayout();
            if (!shown) { Notify(HiddenNotice()); return; }
            if (focus) FocusPanel();
        }

        void FocusPanel()
        {
            Native.SetForegroundWindow(panel.Handle);
            panel.FocusWeb();
        }

        void Collapse()
        {
            bool hadFocus = Native.GetForegroundWindow() == panel.Handle;
            expanded = false;
            settings.Expanded = false;
            settings.Save();
            DoLayout();
            if (hadFocus && shown && tracker.Window != IntPtr.Zero) Native.SetForegroundWindow(tracker.Window);
        }

        void Reload()
        {
            if (failure != null) { failure = null; server.Restart(); return; }
            if (serverPort > 0) panel.Navigate(serverPort, server.Token); else panel.Reload();
        }

        // The link under the site balance: the site in a window of its own, signed in as the panel's account, centered on
        // ZCode's screen. A second click brings the open window forward; signing out of the site in the panel closes it.
        async void OpenSite()
        {
            if (siteWindow != null) { siteWindow.Present(); return; }
            var environment = panel.WebEnvironment;
            if (environment == null) { panel.PostSiteError("面板还在加载，请稍后再打开网站。"); return; }
            var form = new SiteForm(SiteForm.SiteOrigin, () => server.Ask("site-token"), SiteForm.OpenInBrowser, options.DevTools, theme == "dark", appIcon);
            siteWindow = form;
            form.FormClosed += (s, e) => { if (siteWindow == form) siteWindow = null; Log.Write("site window closed"); };
            IntPtr z = tracker.Window;
            bool onZCode = z != IntPtr.Zero && Native.IsWindow(z);
            Rectangle work = onZCode ? Native.WorkAreaFor(z) : Rectangle.Empty;
            if (work.IsEmpty) work = Screen.FromHandle(panel.Handle).WorkingArea;
            form.PlaceIn(work, onZCode ? Native.ScaleFor(z) : currentScale);
            form.Show();
            form.Activate();
            Log.Write("site window opened");
            try { await form.OpenAsync(environment); }
            catch (Exception e)
            {
                Log.Write("site window failed: " + e.GetType().Name);
                if (!form.IsDisposed) form.Close();
                panel.PostSiteError("网站窗口没有打开，详情见日志。");
            }
        }

        // Once, the first time a newer version runs: the update took.
        void SayUpdated()
        {
            if (settings.LastVersion == Program.Version) return;
            if (settings.LastVersion != null && Updates.IsNewer(Program.Version, settings.LastVersion)) Notify("biubiu AI 已更新到 " + Program.Version + "。");
            settings.LastVersion = Program.Version;
            settings.Save();
        }

        // The tray's 检查更新 / 更新到 x.y.z, the panel's footer link, and a click on the balloon that offers the update.
        void OnUpdateItem() { if (update != null) ConfirmUpdate(); else CheckForUpdate(true); }

        // Looks for a newer release. When the user asked, it says what it found and offers the update at once; on its own
        // it tells only of a version it has not told of before, in one balloon, and the tray menu and the panel's footer
        // keep offering it.
        async void CheckForUpdate(bool asked)
        {
            if (!Updates.Enabled) { if (asked) Notify("这份 biubiu AI 不是用安装程序安装的，不会检查更新。"); return; }
            if (updating != null || askingUpdate) return;
            updating = "checking";
            ShowUpdate();
            Release latest = null;
            string problem = null;
            try
            {
                if (!asked) Updates.Clean();
                latest = await Task.Run(() => Updates.Latest());
            }
            catch (Exception e) { problem = Updates.Describe(e); Log.Write("update check failed: " + Updates.LogText(e)); }
            if (cleanedUp) return;
            updating = null;
            if (problem == null)
            {
                update = latest != null && Updates.IsNewer(latest.Version, Program.Version) ? latest : null;
                Log.Write("update check: " + (latest == null ? "no release" : "latest " + latest.Version + (update == null ? "" : latest.Checkable ? ", installer checkable" : ", no checkable installer")));
            }
            ShowUpdate();
            if (asked)
            {
                if (problem != null) Notify("检查更新没有完成：" + problem + "。请稍后再试。");
                else if (update == null) Notify("biubiu AI " + Program.Version + " 已是最新版本。");
                else { Remember(update); ConfirmUpdate(); }
            }
            else if (update != null && update.Version != settings.UpdateSeen)
            {
                Remember(update);
                Log.Write("update " + update.Version + " told in a balloon");
                try
                {
                    tray.ShowBalloonTip(15000, "biubiu AI 有新版本 " + update.Version, "点这里更新（当前 " + Program.Version + "）。以后也可以在托盘菜单或面板底部更新。", ToolTipIcon.Info);
                    balloonOffersUpdate = true;
                }
                catch (Exception) { }
            }
        }

        void Remember(Release release)
        {
            if (settings.UpdateSeen == release.Version) return;
            settings.UpdateSeen = release.Version;
            settings.Save();
        }

        // The tray's tooltip and the panel's footer follow the update.
        void ShowUpdate()
        {
            string tip = updating == "downloading" ? "biubiu AI：正在下载更新 " + updatePercent + "%"
                : updating == "installing" ? "biubiu AI：正在安装更新"
                : "biubiu AI " + Program.Version + (update != null ? "（有新版本 " + update.Version + "）" : "");
            try { tray.Text = tip; } catch (ArgumentException) { }
            panel.PostUpdate(update == null ? null : update.Version, updating == "downloading" || updating == "installing" ? updating : "available", updatePercent);
        }

        // The user's call: what will happen, then yes or no. An installer GitHub records no SHA-256 for cannot be checked,
        // so its release page is offered instead.
        void ConfirmUpdate()
        {
            var release = update;
            if (release == null || updating != null || askingUpdate) return;
            balloonOffersUpdate = false;
            string text = release.Checkable
                ? "发现新版本 biubiu AI " + release.Version + "（当前 " + Program.Version + "）。现在更新吗？\n\n将从 GitHub 下载安装程序" + (release.Size > 0 ? "（约 " + Math.Max(1, (release.Size + 524288) / 1048576) + " MB）" : "") + "，核对文件哈希无误后自动安装。安装时面板会关闭片刻，装好后自动重新打开；设置和网站登录都会保留。"
                : "发现新版本 biubiu AI " + release.Version + "（当前 " + Program.Version + "）。\n\nGitHub 上没有这个版本可供核对的安装程序，不能一键更新。现在打开下载页面吗？";
            DialogResult answer;
            askingUpdate = true;
            try { answer = MessageBox.Show(text, "biubiu AI 更新", MessageBoxButtons.YesNo, MessageBoxIcon.Information); }
            finally { askingUpdate = false; }
            if (cleanedUp) return;
            if (answer != DialogResult.Yes) { Log.Write("update " + release.Version + " not taken now"); return; }
            if (!release.Checkable)
            {
                try { SiteForm.OpenInBrowser(release.Page); }
                catch (Exception e) { Log.Write("could not open the release page: " + e.GetType().Name); }
                return;
            }
            RunUpdate(release);
        }

        // Downloads the installer, checks its size and SHA-256 against GitHub's record, and runs it. The installer quits
        // the companion and starts the new version; if it stops before that, the companion says so and stays.
        async void RunUpdate(Release release)
        {
            updating = "downloading";
            updatePercent = 0;
            ShowUpdate();
            Notify("正在下载 biubiu AI " + release.Version + "，下载完会自动安装。");
            Log.Write("update " + release.Version + " downloading");
            string file = null, problem = null;
            try
            {
                file = await Task.Run(() => Updates.Download(release, percent => Post(() =>
                {
                    if (updating != "downloading" || percent == updatePercent) return;
                    updatePercent = percent;
                    ShowUpdate();
                })));
                string mismatch = await Task.Run(() => Updates.Mismatch(file, release));
                if (mismatch != null)
                {
                    Log.Write("update " + release.Version + " refused: the download does not match GitHub's " + mismatch);
                    problem = mismatch == "size" ? "下载的安装程序不完整" : "下载的安装程序与 GitHub 记录的文件哈希不一致";
                }
            }
            catch (Exception e) { problem = Updates.Describe(e); Log.Write("update download failed: " + Updates.LogText(e)); }
            if (cleanedUp) return;
            if (problem != null)
            {
                Updates.Clean();
                updating = null;
                ShowUpdate();
                Notify("更新没有完成：" + problem + "，所以什么也没有安装。可以稍后再试。");
                return;
            }
            Log.Write("update " + release.Version + " downloaded and verified; starting the installer");
            updating = "installing";
            ShowUpdate();
            try
            {
                var installer = Updates.Run(file);
                installer.EnableRaisingEvents = true;
                installer.Exited += (s, e) =>
                {
                    int code = -1;
                    try { code = installer.ExitCode; } catch (InvalidOperationException) { }
                    Post(() => OnInstallerStopped(code));
                };
            }
            catch (Exception e)
            {
                Log.Write("update installer did not start: " + e.GetType().Name);
                updating = null;
                ShowUpdate();
                Notify("更新没有完成：安装程序没能启动。可以稍后再试。");
            }
        }

        // The installer ended and the companion is still here: it stopped before replacing anything it could not undo.
        void OnInstallerStopped(int code)
        {
            if (updating != "installing") return;
            Log.Write("update installer exited with " + code.ToString(CultureInfo.InvariantCulture) + " and the companion still runs");
            updating = null;
            ShowUpdate();
            if (code != 0) Notify("更新没有完成：安装程序出错了，详情见 %TEMP%\\biubiu-ai-setup.log。可以稍后再试。");
        }

        void ToggleStartup()
        {
            try { if (Startup.IsEnabled()) Startup.Disable(); else Startup.Enable(); }
            catch (Exception e) { Log.Write("startup setting failed: " + e.Message); Notify("无法修改开机启动设置：" + e.Message); }
        }

        void OpenLogFolder()
        {
            try { Directory.CreateDirectory(Paths.DataDir); Process.Start("explorer.exe", "\"" + Paths.DataDir + "\""); }
            catch (Exception e) { Log.Write("could not open the log folder: " + e.Message); }
        }

        void Cleanup()
        {
            if (cleanedUp) return;
            cleanedUp = true;
            stopSignals.Set();
            moveTimer.Stop(); settleTimer.Stop(); pollTimer.Stop(); themeTimer.Stop(); updateTimer.Stop();
            moveTimer.Dispose(); settleTimer.Dispose(); pollTimer.Dispose(); themeTimer.Dispose(); updateTimer.Dispose();
            if (hotKeyRegistered) Native.UnregisterHotKey(panel.Handle, HotKeyId);
            if (siteWindow != null) siteWindow.Close();
            tracker.Dispose();
            host.Close();
            server.Dispose();
            tray.Visible = false;
            tray.Dispose();
            menu.Dispose();
            trayIcon.Dispose();
            Native.DestroyIcon(trayIconHandle);
            if (appIcon != null) appIcon.Dispose();
            panel.AllowClose = true;
            panel.Close();
            panel.Dispose();
            tab.Close();
            tab.Dispose();
            if (signalThread.Join(1000)) { showEvent.Dispose(); quitEvent.Dispose(); collapseEvent.Dispose(); expandEvent.Dispose(); checkUpdateEvent.Dispose(); }
        }

        protected override void ExitThreadCore()
        {
            Cleanup();
            base.ExitThreadCore();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) Cleanup();
            base.Dispose(disposing);
        }
    }

    static class Native
    {
        public delegate void WinEventProc(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
        [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        public const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_SYSTEM_MOVESIZESTART = 0x000A, EVENT_SYSTEM_MOVESIZEEND = 0x000B;
        public const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016, EVENT_SYSTEM_MINIMIZEEND = 0x0017;
        public const uint EVENT_OBJECT_DESTROY = 0x8001, EVENT_OBJECT_SHOW = 0x8002, EVENT_OBJECT_HIDE = 0x8003, EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
        public const uint EVENT_OBJECT_CLOAKED = 0x8017, EVENT_OBJECT_UNCLOAKED = 0x8018;
        public const uint WINEVENT_OUTOFCONTEXT = 0x0000, WINEVENT_SKIPOWNPROCESS = 0x0002;
        public const int OBJID_WINDOW = 0;
        public const uint GW_HWNDPREV = 3, GW_OWNER = 4, GA_ROOT = 2;
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOPMOST = 0x00000008, WS_EX_TOOLWINDOW = 0x00000080, WS_EX_NOACTIVATE = 0x08000000;
        public const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_NOOWNERZORDER = 0x0200;
        public const int WM_MOUSEACTIVATE = 0x0021, WM_HOTKEY = 0x0312, MA_NOACTIVATE = 3;
        public const uint MOD_ALT = 0x0001, MOD_CONTROL = 0x0002, MOD_NOREPEAT = 0x4000, ASFW_ANY = 0xFFFFFFFF;
        public const int DWMWCP_ROUND = 2;
        const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20, DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14, DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWA_BORDER_COLOR = 34;
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        const int JobObjectExtendedLimitInformation = 9;

        [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc callback, uint idProcess, uint idThread, uint flags);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AllowSetForegroundWindow(uint processId);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsZoomed(IntPtr hwnd);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
        [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint key);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool UnregisterHotKey(IntPtr hwnd, int id);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool DestroyIcon(IntPtr icon);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        public static void EnableDpiAwareness()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
            try { SetProcessDpiAwareness(2); } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
        }

        public static IntPtr CreateKillOnCloseJob()
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return IntPtr.Zero;
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) return job;
            CloseHandle(job);
            return IntPtr.Zero;
        }

        // Read-only: asks for the image path of another process with the least access right.
        public static bool ProcessImageNameIs(uint processId, string exeName)
        {
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
            if (process == IntPtr.Zero) return false;
            try
            {
                var name = new StringBuilder(1024);
                uint size = (uint)name.Capacity;
                return QueryFullProcessImageName(process, 0, name, ref size) && string.Equals(Path.GetFileName(name.ToString()), exeName, StringComparison.OrdinalIgnoreCase);
            }
            finally { CloseHandle(process); }
        }

        public static bool IsCloaked(IntPtr hwnd)
        {
            int cloaked;
            try { return DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0; }
            catch (DllNotFoundException) { return false; }
        }

        // The visible frame in physical pixels, without the invisible resize borders.
        public static bool TryGetFrame(IntPtr hwnd, out Rectangle frame)
        {
            RECT r;
            bool ok;
            try { ok = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0; }
            catch (DllNotFoundException) { ok = false; r = new RECT(); }
            if (!ok && !GetWindowRect(hwnd, out r)) { frame = Rectangle.Empty; return false; }
            frame = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
            return frame.Width > 0 && frame.Height > 0 && frame.Left > -30000 && frame.Top > -30000;
        }

        public static double ScaleFor(IntPtr hwnd)
        {
            try { uint dpi = GetDpiForWindow(hwnd); if (dpi >= 48) return dpi / 96.0; }
            catch (EntryPointNotFoundException) { }
            return 1;
        }

        // The work area (monitor minus taskbar) of the monitor that shows most of the window, in physical pixels.
        public static Rectangle WorkAreaFor(IntPtr hwnd)
        {
            const uint MONITOR_DEFAULTTONEAREST = 2;
            IntPtr monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            var info = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
            if (monitor != IntPtr.Zero && GetMonitorInfo(monitor, ref info)) return Rectangle.FromLTRB(info.rcWork.Left, info.rcWork.Top, info.rcWork.Right, info.rcWork.Bottom);
            return Rectangle.Empty;
        }

        public static void Place(IntPtr hwnd, Rectangle bounds)
        {
            RECT r;
            if (GetWindowRect(hwnd, out r) && r.Left == bounds.Left && r.Top == bounds.Top && r.Right == bounds.Right && r.Bottom == bounds.Bottom) return;
            SetWindowPos(hwnd, IntPtr.Zero, bounds.X, bounds.Y, bounds.Width, bounds.Height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        }

        // Puts our window directly above ZCode without activating it, so other apps keep their place.
        public static void EnsureAbove(IntPtr ours, IntPtr zcode)
        {
            int steps = 0;
            for (IntPtr h = GetWindow(zcode, GW_HWNDPREV); h != IntPtr.Zero && steps < 2048; h = GetWindow(h, GW_HWNDPREV), steps++)
                if (h == ours) return;
            IntPtr previous = GetWindow(zcode, GW_HWNDPREV);
            if (previous == ours) return;
            bool topmost = previous != IntPtr.Zero && ((long)GetWindowLongPtr(previous, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
            SetWindowPos(ours, previous == IntPtr.Zero || topmost ? IntPtr.Zero : previous, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        }

        // False where Windows has no corner preference (before Windows 11).
        public static bool TrySetCorner(IntPtr hwnd, int preference)
        {
            try { return DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int)) == 0; }
            catch (DllNotFoundException) { return false; }
            catch (EntryPointNotFoundException) { return false; }
        }

        public static void TrySetDarkTitle(IntPtr hwnd, bool dark)
        {
            int value = dark ? 1 : 0;
            try { DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref value, sizeof(int)); }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }

        public static void TrySetBorderColor(IntPtr hwnd, Color color)
        {
            int value = color.R | (color.G << 8) | (color.B << 16);
            try { DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ref value, sizeof(int)); }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }
    }
}
