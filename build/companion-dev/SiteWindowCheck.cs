// Development check for the companion's site window (SiteForm in app/host/BiubiuAI.cs), run by site-window-check.mjs.
// Window mode opens the real SiteForm against a stand-in site on 127.0.0.1 instead of ro.biubiu007.com, with a stand-in
// for Node: the renewals it answers come from a fixed list (two tokens, then signed out, then no answer), and links that
// would go to the default browser are only printed ("outside <url>"). Reads "quit" on stdin.
// Pipe mode (--pipe) checks how the host reads Node's answers (ServerProcess.ParseReply), then asks the real
// app/server.mjs over its stdin, signed out in a temporary data folder, so nothing reaches any site.
// Menu mode (--menu) shows the tray icon's menu (TrayMenu) in both themes over a backdrop of its own, measures it and
// saves both captures side by side.
// Update mode (--updates) checks how the update check reads JSON and GitHub's answer about a release (Json.Parse,
// Updates.Read), compares versions and checks a download against its SHA-256 (Updates.Mismatch), offline.
// It never signs in anywhere. Usage: SiteWindowCheck.exe <stand-in origin> <WebView2 user data folder> | --pipe | --menu <png> | --updates
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using BiubiuAI;

static class SiteWindowCheck
{
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--pipe") return Pipe();
        if (args.Length == 2 && args[0] == "--menu") return Menu(args[1]);
        if (args.Length == 1 && args[0] == "--updates") return UpdateChecks();
        if (args.Length != 2) { Console.Error.WriteLine("usage: SiteWindowCheck <origin> <user data folder> | --pipe | --menu <png> | --updates"); return 2; }
        Application.EnableVisualStyles();
        var replies = new Queue<HostReply>(new[] { new HostReply(true, true, "harness-token-1"), new HostReply(true, true, "harness-token-2"), new HostReply(true, false, null), HostReply.Failed });
        Func<Task<HostReply>> ask = async () =>
        {
            await Task.Delay(30);
            HostReply next = replies.Count > 0 ? replies.Dequeue() : HostReply.Failed;
            Console.WriteLine("asked " + (next.SignedIn ? "token" : next.Answered ? "signed-out" : "failed"));
            return next;
        };
        var form = new SiteForm(args[0], ask, url => Console.WriteLine("outside " + url), false, false, null);
        Rectangle work = Screen.PrimaryScreen.WorkingArea;
        form.Bounds = new Rectangle(work.Right - 660, work.Bottom - 500, 640, 480);
        form.Shown += async (s, e) =>
        {
            try
            {
                var environment = await CoreWebView2Environment.CreateAsync(null, args[1], new CoreWebView2EnvironmentOptions());
                await form.OpenAsync(environment);
                // The site window itself never listens; this only proves that a message from the page never arrives.
                foreach (Control control in form.Controls)
                {
                    var web = control as Microsoft.Web.WebView2.WinForms.WebView2;
                    if (web != null && web.CoreWebView2 != null) web.CoreWebView2.WebMessageReceived += (sender, message) => Console.WriteLine("host got a message");
                }
                Console.WriteLine("opened");
            }
            catch (Exception error) { Console.WriteLine("error " + error.GetType().Name + ": " + error.Message); Application.Exit(); }
        };
        form.FormClosed += (s, e) => Application.Exit();
        new Thread(() =>
        {
            string line;
            while ((line = Console.In.ReadLine()) != null && line.Trim() != "quit") { }
            try { form.BeginInvoke((Action)(() => form.Close())); } catch (InvalidOperationException) { }
        }) { IsBackground = true }.Start();
        Application.Run(form);
        return 0;
    }

    static string Show(HostReply r) { return r == null ? "none" : r.SignedIn ? "token " + r.Token : r.Answered ? "signed-out" : "failed"; }

    // Prints "parse <case> <result>" for each answer line, then "ask <step> <result>" for the real server.
    static int Pipe()
    {
        string token = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.sig-" + new string('x', 600);
        var lines = new[]
        {
            new[] { "token", "{\"event\":\"host-reply\",\"id\":3,\"signedIn\":true,\"token\":\"" + Convert.ToBase64String(Encoding.UTF8.GetBytes(token)) + "\"}" },
            new[] { "signed-out", "{\"event\":\"host-reply\",\"id\":4,\"signedIn\":false}" },
            new[] { "error", "{\"event\":\"host-reply\",\"id\":5,\"error\":\"failed\"}" },
            new[] { "no-token", "{\"event\":\"host-reply\",\"id\":6,\"signedIn\":true}" },
            new[] { "bad-token", "{\"event\":\"host-reply\",\"id\":7,\"signedIn\":true,\"token\":\"%%%\"}" },
            new[] { "ready-line", "{\"event\":\"ready\",\"port\":1234,\"version\":\"0.0.0\"}" },
            new[] { "junk", "not json" },
        };
        foreach (var pair in lines)
        {
            int id;
            HostReply reply = ServerProcess.ParseReply(pair[1], out id);
            string shown = Show(reply);
            if (reply != null && reply.SignedIn) shown = reply.Token == token ? "token (same)" : "token (different)";
            Console.WriteLine("parse " + pair[0] + " " + (reply == null ? "none" : id + " " + shown));
        }

        var server = new ServerProcess();
        var ready = new ManualResetEventSlim();
        server.Ready += port => ready.Set();
        server.Failed += message => { Console.WriteLine("ask server-failed " + message); ready.Set(); };
        Console.WriteLine("ask before-start " + Show(server.Ask("site-token").Result));
        server.Start();
        if (!ready.Wait(20000)) { Console.WriteLine("ask not-ready"); server.Dispose(); return 1; }
        Console.WriteLine("ask site-token " + Show(server.Ask("site-token").Result));
        Console.WriteLine("ask unknown " + Show(server.Ask("nope").Result));
        var both = Task.WhenAll(server.Ask("site-token"), server.Ask("site-token")).Result;
        Console.WriteLine("ask together " + Show(both[0]) + " " + Show(both[1]));
        server.Dispose();
        Console.WriteLine("ask after-stop " + Show(server.Ask("site-token").Result));
        return 0;
    }

    // Prints "menu <theme> <check> ok" or what it saw instead, for the light menu and then the dark one. Each opens with
    // the pointer's wash on "打开日志文件夹", the right side chosen, and the startup box on (light) or off (dark).
    static int Menu(string output)
    {
        Application.EnableVisualStyles();
        Rectangle work = Screen.PrimaryScreen.WorkingArea;
        Color backdrop = Color.FromArgb(0x3D, 0x7E, 0xC9);
        var shots = new List<Bitmap>();
        bool roundCorners = DrawsRoundCorners(work, backdrop);
        foreach (bool dark in new[] { false, true })
        {
            string theme = dark ? "dark" : "light";
            using (var menu = new TrayMenu())
            {
                // The companion's rows.
                var toggle = menu.Add("收起面板", () => { });
                var reload = menu.Add("重新加载面板", () => { });
                var tour = menu.Add("使用教程", () => { });
                menu.AddSeparator();
                var right = menu.Add("优先贴在 ZCode 右侧", () => { }, TrayMenu.Mark.Option);
                var left = menu.Add("优先贴在 ZCode 左侧", () => { }, TrayMenu.Mark.Option);
                menu.AddSeparator();
                var startup = menu.Add("登录 Windows 时在后台待命", () => { }, TrayMenu.Mark.Check);
                var logs = menu.Add("打开日志文件夹", () => { });
                var updates = menu.Add("检查更新", () => { });
                menu.AddSeparator();
                menu.Add("退出 biubiu AI", () => { });
                menu.AutoClose = false;
                menu.Opening += (s, e) => { menu.ApplyTheme(dark); toggle.ShortcutKeyDisplayString = "Ctrl+Alt+M"; right.Checked = true; startup.Checked = !dark; };

                int margin = menu.Px(24);
                var area = new Rectangle(work.Left + menu.Px(60), work.Top + menu.Px(60), menu.Width + 2 * margin, menu.Height + 2 * margin);
                var at = new Point(area.Left + margin, area.Top + margin);
                Size before = menu.Size;
                using (var back = new Backdrop(backdrop, area) { TopMost = true })
                {
                    back.Show();
                    Application.DoEvents();
                    menu.Show(at);
                    logs.Select();
                    for (int i = 0; i < 25; i++) { Application.DoEvents(); Thread.Sleep(30); }
                    var shot = new Bitmap(area.Width, area.Height);
                    using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(area.Location, Point.Empty, area.Size);
                    shots.Add(shot);
                    menu.Close();

                    // Pixels of the menu, from its own top-left corner.
                    Func<int, int, Color> pixel = (x, y) => shot.GetPixel(margin + x, margin + y);
                    Func<ToolStripItem, int> middle = item => item.Bounds.Top + item.Height / 2;
                    Color paper = Palette.Paper(dark), ink = Palette.Ink(dark);
                    int far = menu.Width - menu.Px(24), markX = menu.Px(TrayMenu.MarkCenter), edge = menu.Px(TrayMenu.Edge);

                    Report(theme, "placed", menu.Bounds.Location == at && menu.Size == before, menu.Bounds + " for " + at + ", " + before);
                    var rows = new List<ToolStripItem>();
                    foreach (ToolStripItem item in menu.Items) if (item.Available) rows.Add(item);
                    bool stacked = rows[0].Bounds.Top == edge && rows[rows.Count - 1].Bounds.Bottom == menu.Height - edge;
                    for (int i = 1; i < rows.Count; i++) stacked &= rows[i].Bounds.Top == rows[i - 1].Bounds.Bottom;
                    foreach (var row in new ToolStripItem[] { toggle, reload, tour, right, left, startup, logs, updates }) stacked &= row.Height == menu.Px(TrayMenu.RowHeight);
                    Report(theme, "rows", stacked, string.Join(" ", rows.ConvertAll(r => r.Bounds.Top + "+" + r.Height)) + " in " + menu.Height);
                    // Judged only where Windows draws rounded corners at all; elsewhere it says so instead of ok.
                    if (menu.Rounded && !roundCorners) Console.WriteLine("menu " + theme + " rounded square-system");
                    else Report(theme, "rounded", !menu.Rounded || (Near(pixel(0, 0), backdrop, 60) && Near(pixel(menu.Width / 2, menu.Px(3)), paper, 3)),
                        pixel(0, 0) + " at the corner, " + pixel(menu.Width / 2, menu.Px(3)) + " on the edge");
                    Report(theme, "paper", Near(pixel(far, middle(reload)), paper, 3), pixel(far, middle(reload)).ToString());
                    Report(theme, "no-column", Near(pixel(menu.Px(10), middle(reload)), paper, 3), pixel(menu.Px(10), middle(reload)).ToString());
                    Report(theme, "wash", Near(pixel(far, middle(logs)), Palette.Hover(dark), 3) && Near(pixel(far, middle(startup)), paper, 3), pixel(far, middle(logs)) + " under the pointer");
                    int accent = 0, reach = menu.Px(12);
                    for (int x = markX - reach; x <= markX + reach; x++)
                        for (int y = middle(rows[0]) - reach; y <= middle(rows[0]) + reach; y++)
                            if (Near(pixel(x, y), Logo.Accent, 50)) accent++;
                    Report(theme, "mark", accent >= 6, accent + " accent pixels on the title row");
                    Report(theme, "option", Near(pixel(markX, middle(right)), ink, 40) && Near(pixel(markX, middle(left)), paper, 3), pixel(markX, middle(right)) + " / " + pixel(markX, middle(left)));
                    // On: ink inside the box, clear of the tick; off: paper at its middle, clear of the outline.
                    Color box = dark ? pixel(markX, middle(startup)) : pixel(markX - menu.Px(5), middle(startup) - menu.Px(5));
                    Report(theme, "check-box", dark ? Near(box, paper, 3) : Near(box, ink, 40), box.ToString());
                }
            }
        }
        using (var both = new Bitmap(shots[0].Width + shots[1].Width, Math.Max(shots[0].Height, shots[1].Height)))
        {
            using (var g = Graphics.FromImage(both))
            {
                g.Clear(backdrop);
                g.DrawImage(shots[0], 0, 0);
                g.DrawImage(shots[1], shots[0].Width, 0);
            }
            both.Save(output, ImageFormat.Png);
        }
        foreach (var shot in shots) shot.Dispose();
        return 0;
    }

    // Prints "update <case> ok", or what it saw instead, for each case.
    static int UpdateChecks()
    {
        Action<string, bool, string> say = (name, ok, saw) => Console.WriteLine("update " + name + " " + (ok ? "ok" : saw));
        Func<string, string> fails = text =>
        {
            try { Json.Parse(text); return "parsed"; }
            catch (FormatException) { return null; }
            catch (Exception e) { return e.GetType().Name; }
        };

        // JSON: every kind of value, escapes (a quote, a backslash, a slash, a line end, Chinese, an emoji as a surrogate
        // pair) and numbers; then text that is not JSON.
        var parsed = Json.Parse(" {\"s\":\"a\\\"b\\\\c\\/d\\ne\\u4e2d\\ud83d\\ude00\",\"n\":[0,-12,3.5,1e3,2E-2],\"t\":true,\"f\":false,\"z\":null,\"o\":{\"x\":[]},\"e\":{}} ") as Dictionary<string, object>;
        var numbers = parsed == null ? null : parsed["n"] as List<object>;
        bool values = parsed != null && (string)parsed["s"] == "a\"b\\c/d\ne\u4e2d\ud83d\ude00" && numbers != null && numbers.Count == 5
            && (double)numbers[0] == 0 && (double)numbers[1] == -12 && (double)numbers[2] == 3.5 && (double)numbers[3] == 1000 && (double)numbers[4] == 0.02
            && (bool)parsed["t"] && !(bool)parsed["f"] && parsed["z"] == null && ((parsed["o"] as Dictionary<string, object>)["x"] as List<object>).Count == 0 && (parsed["e"] as Dictionary<string, object>).Count == 0;
        say("json-values", values, parsed == null ? "not an object" : string.Join(",", parsed.Keys));
        var broken = new List<string>();
        foreach (var text in new[] { "", "{", "[1,]", "{\"a\" 1}", "{\"a\":1,}", "\"abc", "tru", "1 2", "{\"a\":01x}", "\"\\x\"", "\"\\u12\"", "[" + new string('[', 80) + new string(']', 81) })
        {
            string result = fails(text);
            if (result != null) broken.Add(text.Length > 12 ? text.Substring(0, 12) + "..." : text + " " + result);
        }
        say("json-refuses", broken.Count == 0, string.Join(" | ", broken));

        // GitHub's answer about the latest release, in its shape: the installer of that version, from the repository's
        // own release downloads, with its size and the SHA-256 GitHub records.
        string sha = new string('a', 32) + new string('B', 32);
        Func<string, string, string, string> answer = (tag, entry, extra) =>
            "{\"url\":\"https://api.github.com/repos/drhhhao/Zcode-biubiuAI/releases/1\",\"html_url\":\"" + Updates.Repository + "/releases/tag/" + tag + "\",\"id\":1,"
            + "\"author\":{\"login\":\"drhhhao\",\"id\":240398156,\"site_admin\":false},\"tag_name\":\"" + tag + "\",\"target_commitish\":\"main\",\"name\":\"biubiu AI\","
            + "\"draft\":false,\"immutable\":false,\"prerelease\":false,\"created_at\":\"2026-10-26T09:00:00Z\",\"published_at\":\"2026-10-26T09:10:00Z\","
            + "\"assets\":[{\"name\":\"notes.txt\",\"size\":12,\"digest\":null,\"browser_download_url\":\"" + Updates.Repository + "/releases/download/" + tag + "/notes.txt\"}," + entry + "],"
            + "\"body\":\"**\\u66f4\\u65b0** \\r\\nSHA-256\\uff1a`" + sha + "`\"" + extra + "}";
        Func<string, string, string, string> asset = (name, url, digest) =>
            "{\"url\":\"https://api.github.com/x\",\"id\":2,\"name\":\"" + name + "\",\"label\":null,\"uploader\":{\"login\":\"drhhhao\"},\"content_type\":\"application/x-msdownload\","
            + "\"state\":\"uploaded\",\"size\":37994496,\"digest\":" + (digest == null ? "null" : "\"" + digest + "\"") + ",\"download_count\":3,\"browser_download_url\":\"" + url + "\"}";
        string download = Updates.Repository + "/releases/download/v0.9.0/biubiuAI-Setup-0.9.0.exe";
        var release = Updates.Read(answer("v0.9.0", asset("biubiuAI-Setup-0.9.0.exe", download, "sha256:" + sha), ""));
        say("read-release", release != null && release.Version == "0.9.0" && release.Page == Updates.Repository + "/releases/tag/v0.9.0" && release.Installer == download
            && release.Size == 37994496 && release.Sha256 == sha.ToLowerInvariant() && release.Checkable,
            release == null ? "none" : release.Version + " " + release.Installer + " " + release.Size + " " + release.Sha256);
        say("read-mirror", release != null && release.Mirror == "https://gitee.com/drhhhao_0/Zcode-biubiuAI/releases/download/v0.9.0/biubiuAI-Setup-0.9.0.exe",
            release == null ? "none" : release.Mirror ?? "no mirror");
        Func<Release, string> show = r => r == null ? "none" : r.Version + (r.Installer == null ? " without an installer" : " " + r.Installer) + (r.Sha256 == null ? " without a SHA-256" : "");
        var draft = Updates.Read(answer("v0.9.0", asset("biubiuAI-Setup-0.9.0.exe", download, "sha256:" + sha), ",\"draft\":true"));
        var pre = Updates.Read(answer("v0.9.0", asset("biubiuAI-Setup-0.9.0.exe", download, "sha256:" + sha), ",\"prerelease\":true"));
        say("read-skips-drafts-and-prereleases", draft == null && pre == null, show(draft) + " / " + show(pre));
        var named = Updates.Read(answer("latest", asset("biubiuAI-Setup-0.9.0.exe", download, "sha256:" + sha), ""));
        say("read-needs-a-version-tag", named == null, show(named));
        var elsewhere = Updates.Read(answer("v0.9.0", asset("biubiuAI-Setup-0.9.0.exe", "https://example.com/biubiuAI-Setup-0.9.0.exe", "sha256:" + sha), ""));
        var local = Updates.Read(answer("v0.9.0", asset("biubiuAI-Setup-0.9.0.exe", "http://127.0.0.1:8080/biubiuAI-Setup-0.9.0.exe", "sha256:" + sha), ""));
        say("read-takes-installers-from-the-repository-only", elsewhere != null && !elsewhere.Checkable && elsewhere.Installer == null && local != null && local.Installer == null, show(elsewhere) + " / " + show(local));
        var other = Updates.Read(answer("v0.9.0", asset("biubiuAI-Setup-0.8.9.exe", Updates.Repository + "/releases/download/v0.9.0/biubiuAI-Setup-0.8.9.exe", "sha256:" + sha), ""));
        say("read-takes-the-installer-of-that-version", other != null && other.Installer == null && !other.Checkable, show(other));
        var unsigned = Updates.Read(answer("v0.9.0", asset("biubiuAI-Setup-0.9.0.exe", download, null), ""));
        var odd = Updates.Read(answer("v0.9.0", asset("biubiuAI-Setup-0.9.0.exe", download, "md5:" + new string('a', 32)), ""));
        say("read-needs-a-sha256", unsigned != null && unsigned.Installer == download && !unsigned.Checkable && odd != null && !odd.Checkable, show(unsigned) + " / " + show(odd));
        var page = Updates.Read(answer("v0.9.0", asset("biubiuAI-Setup-0.9.0.exe", download, "sha256:" + sha), "").Replace(Updates.Repository + "/releases/tag/v0.9.0", "https://example.com/release"));
        say("read-keeps-the-page-on-the-repository", page != null && page.Page == Updates.Repository + "/releases/latest", page == null ? "none" : page.Page);
        string notJson = null;
        try { Updates.Read("<html>rate limited</html>"); notJson = "read"; } catch (FormatException) { }
        say("read-refuses-other-text", notJson == null && Updates.Read("[]") == null && Updates.Read("{}") == null, notJson ?? "an array or an empty object was read");

        // Versions: only a newer one counts; text that is no version never does.
        var compared = new List<string>();
        foreach (var pair in new[] { new[] { "0.8.10", "0.8.9", "True" }, new[] { "0.9.0", "0.8.9", "True" }, new[] { "1.0.0", "0.8.9", "True" }, new[] { "0.8.9", "0.8.9", "False" },
            new[] { "0.8.8", "0.8.9", "False" }, new[] { "0.8.9-beta", "0.8.8", "False" }, new[] { "v0.9.0", "0.8.9", "False" }, new[] { "", "0.8.9", "False" }, new[] { "9", "0.8.9", "False" } })
            if (Updates.IsNewer(pair[0], pair[1]).ToString() != pair[2]) compared.Add(pair[0] + " vs " + pair[1]);
        say("versions", compared.Count == 0, string.Join(", ", compared));

        // A download runs only when its size and SHA-256 are GitHub's.
        string file = Path.Combine(Path.GetTempPath(), "mh-update-check-" + Guid.NewGuid().ToString("N") + ".exe");
        try
        {
            File.WriteAllText(file, "hello", new UTF8Encoding(false));
            const string hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
            string same = Updates.Mismatch(file, new Release { Size = 5, Sha256 = hello });
            string size = Updates.Mismatch(file, new Release { Size = 6, Sha256 = hello });
            string hash = Updates.Mismatch(file, new Release { Size = 5, Sha256 = hello.Replace('2', '3') });
            say("download-checked", same == null && size == "size" && hash == "sha256", (same ?? "match") + " / " + (size ?? "match") + " / " + (hash ?? "match"));
        }
        finally { File.Delete(file); }

        // Only a copy the installer put in place looks for updates; a development build never does.
        say("only-installed-copies", !Updates.Enabled, Updates.InstallDir);
        return 0;
    }

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    // Whether this machine draws rounded window corners at all: a white window of our own asks for them (Windows 11's
    // DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND), as the menu does, in front of the backdrop, and its corner is looked
    // at. Windows Server, which GitHub's checks run on, takes the request and still draws the corners square.
    static bool DrawsRoundCorners(Rectangle work, Color backdrop)
    {
        var area = new Rectangle(work.Left + 60, work.Top + 60, 240, 160);
        using (var back = new Backdrop(backdrop, area) { TopMost = true })
        using (var probe = new Backdrop(Color.White, new Rectangle(area.Left + 40, area.Top + 40, 160, 80)) { TopMost = true })
        {
            back.Show();
            probe.Show();
            int round = 2;
            try { if (DwmSetWindowAttribute(probe.Handle, 33, ref round, sizeof(int)) != 0) return false; } catch { return false; }
            for (int i = 0; i < 15; i++) { Application.DoEvents(); Thread.Sleep(30); }
            using (var shot = new Bitmap(1, 1))
            {
                using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(probe.Left, probe.Top, 0, 0, new Size(1, 1));
                return Near(shot.GetPixel(0, 0), backdrop, 60);
            }
        }
    }

    static bool Near(Color a, Color b, int tolerance)
    {
        return Math.Abs(a.R - b.R) <= tolerance && Math.Abs(a.G - b.G) <= tolerance && Math.Abs(a.B - b.B) <= tolerance;
    }

    static void Report(string theme, string check, bool ok, string saw) { Console.WriteLine("menu " + theme + " " + check + " " + (ok ? "ok" : saw)); }
}

// A plain window of our own behind the menu, so that its captures hold nothing else from the screen.
sealed class Backdrop : Form
{
    public Backdrop(Color color, Rectangle bounds)
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = color;
        Bounds = bounds;
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    // A tool window that never takes the focus.
    protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= 0x80 | 0x08000000; return cp; } }
}
