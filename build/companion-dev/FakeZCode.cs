// Development stand-in for the ZCode main window, used only by smoke-host.ps1.
// A native top-level window of class Chrome_WidgetWin_1 titled "ZCode" (per-monitor DPI aware),
// driven by stdin commands so the companion can be tested without touching the real ZCode.
// Like an Electron frameless window it keeps the caption style, so Windows animates minimizing and
// restoring it, but has no visible non-client area.
// Commands: move X Y W H | min | max | restore | dark | light | front | backdrop white|black|off | quit.
// Each answers "ok <command>". "backdrop" puts a plain window of ZCode's size directly behind it (or hides it):
// what the screen shows in ZCode's place while it is minimized and while Windows animates it back.
using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

static class FakeZCode
{
    delegate IntPtr WndProcDelegate(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASSEX
    {
        public uint cbSize, style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra, cbWndExtra;
        public IntPtr hInstance, hIcon, hCursor, hbrBackground;
        public string lpszMenuName, lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

    const uint WM_DESTROY = 0x0002, WM_NCCALCSIZE = 0x0083, WM_APP = 0x8000;
    const uint WS_POPUP = 0x80000000, WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000, WS_SYSMENU = 0x00080000, WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000;
    const uint WS_EX_TOOLWINDOW = 0x00000080, WS_EX_NOACTIVATE = 0x08000000;
    const int SW_HIDE = 0, SW_SHOWMINNOACTIVE = 7, SW_SHOWNOACTIVATE = 4, SW_MAXIMIZE = 3, SW_RESTORE = 9;
    const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
    const int GCLP_HBRBACKGROUND = -10;
    const int Dark = 0x1e1e1e, Light = 0xf5f5f5, White = 0xffffff, Black = 0x000000;

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "RegisterClassExW")] static extern ushort RegisterClassEx(ref WNDCLASSEX c);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateWindowExW")] static extern IntPtr CreateWindowEx(uint exStyle, string className, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll", EntryPoint = "DefWindowProcW")] static extern IntPtr DefWindowProc(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", EntryPoint = "GetMessageW")] static extern int GetMessage(out MSG msg, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll", EntryPoint = "DispatchMessageW")] static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll", EntryPoint = "PostMessageW")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool InvalidateRect(IntPtr h, IntPtr rect, bool erase);
    [DllImport("user32.dll", EntryPoint = "SetClassLongPtrW")] static extern IntPtr SetClassLongPtr(IntPtr h, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] static extern bool SystemParametersInfo(uint action, uint param, out RECT value, uint winIni);
    [DllImport("user32.dll", EntryPoint = "LoadCursorW")] static extern IntPtr LoadCursor(IntPtr instance, IntPtr id);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(int color);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetModuleHandleW")] static extern IntPtr GetModuleHandle(string name);

    // The backdrop is a plain window, so its class gets DefWindowProc.
    static readonly WndProcDelegate Callback = Proc, BackdropCallback = DefWindowProc;
    static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    static readonly object OutputLock = new object();
    static IntPtr hwnd, backdrop;

    static void Reply(string text)
    {
        lock (OutputLock)
        {
            try { Console.Out.WriteLine(text); Console.Out.Flush(); }
            catch (System.IO.IOException) { }
        }
    }

    // Raises the window to the top of the non-topmost band without activating it.
    static void Front()
    {
        SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        SetWindowPos(hwnd, new IntPtr(-2), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    static void SetBackground(IntPtr window, int color)
    {
        IntPtr brush = CreateSolidBrush(color);
        IntPtr old = SetClassLongPtr(window, GCLP_HBRBACKGROUND, brush);
        if (old != IntPtr.Zero) DeleteObject(old);
        InvalidateRect(window, IntPtr.Zero, true);
    }

    // Shows the backdrop over ZCode's current rectangle, directly below it in z-order.
    static void PlaceBackdrop()
    {
        RECT r;
        if (backdrop == IntPtr.Zero || !GetWindowRect(hwnd, out r)) return;
        SetWindowPos(backdrop, hwnd, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    static void Execute(string line)
    {
        // PowerShell 5's redirected stdin writer prefixes the first line with a UTF-8 BOM.
        var parts = line.Replace("﻿", "").Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        string name = parts.Length == 0 ? "" : parts[0];
        switch (name)
        {
            case "move":
                int x, y, w, h;
                if (parts.Length != 5
                    || !int.TryParse(parts[1], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out x)
                    || !int.TryParse(parts[2], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out y)
                    || !int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out w)
                    || !int.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out h))
                {
                    Reply("error move needs X Y W H");
                    return;
                }
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                SetWindowPos(hwnd, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
                Front();
                if (backdrop != IntPtr.Zero && IsWindowVisible(backdrop)) PlaceBackdrop();
                break;
            case "min": ShowWindow(hwnd, SW_SHOWMINNOACTIVE); break;
            case "max": ShowWindow(hwnd, SW_MAXIMIZE); break;
            // A maximized window needs SW_RESTORE to go back to its normal size; otherwise restore without activating.
            case "restore": ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_SHOWNOACTIVATE); Front(); break;
            case "dark": SetBackground(hwnd, Dark); break;
            case "light": SetBackground(hwnd, Light); break;
            case "front": Front(); break;
            // Use while ZCode is in its normal state, which gives the backdrop its rectangle.
            case "backdrop":
                string color = parts.Length == 2 ? parts[1] : "";
                if (color == "off") { if (backdrop != IntPtr.Zero) ShowWindow(backdrop, SW_HIDE); break; }
                if (color != "white" && color != "black") { Reply("error backdrop needs white, black or off"); return; }
                if (backdrop == IntPtr.Zero)
                    backdrop = CreateWindowEx(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, "FakeZCodeBackdrop", "", WS_POPUP, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
                SetBackground(backdrop, color == "white" ? White : Black);
                PlaceBackdrop();
                break;
            case "quit": Reply("ok quit"); DestroyWindow(hwnd); return;
            default: Reply("error unknown command " + name); return;
        }
        Reply("ok " + name);
    }

    static IntPtr Proc(IntPtr h, uint m, IntPtr w, IntPtr l)
    {
        if (m == WM_APP)
        {
            string command;
            while (Commands.TryDequeue(out command)) Execute(command);
            return IntPtr.Zero;
        }
        if (m == WM_DESTROY) { PostQuitMessage(0); return IntPtr.Zero; }
        // The whole window is client area, as in an Electron frameless window. The first of these arrives
        // inside CreateWindowEx, before hwnd is set.
        if (m == WM_NCCALCSIZE) return IntPtr.Zero;
        return DefWindowProc(h, m, w, l);
    }

    static void ReadCommands()
    {
        string line;
        // Read UTF-8 with BOM detection: Console.In would decode with the console code page and turn a BOM into junk.
        var input = new System.IO.StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false), true);
        try { while ((line = input.ReadLine()) != null) { Commands.Enqueue(line); PostMessage(hwnd, WM_APP, IntPtr.Zero, IntPtr.Zero); } }
        catch (System.IO.IOException) { }
        Commands.Enqueue("quit");
        PostMessage(hwnd, WM_APP, IntPtr.Zero, IntPtr.Zero);
    }

    static int Main()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        IntPtr instance = GetModuleHandle(null);
        var wc = new WNDCLASSEX
        {
            cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX)),
            style = 0x0003,
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(Callback),
            hInstance = instance,
            hCursor = LoadCursor(IntPtr.Zero, new IntPtr(32512)),
            hbrBackground = CreateSolidBrush(Dark),
            lpszClassName = "Chrome_WidgetWin_1"
        };
        if (RegisterClassEx(ref wc) == 0) { Console.Error.WriteLine("RegisterClassEx failed: " + Marshal.GetLastWin32Error()); return 1; }
        wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(BackdropCallback);
        wc.hbrBackground = CreateSolidBrush(White);
        wc.lpszClassName = "FakeZCodeBackdrop";
        if (RegisterClassEx(ref wc) == 0) { Console.Error.WriteLine("RegisterClassEx failed: " + Marshal.GetLastWin32Error()); return 1; }

        RECT wa;
        if (!SystemParametersInfo(0x0030, 0, out wa, 0)) wa = new RECT { Left = 0, Top = 0, Right = 1920, Bottom = 1080 };
        int waWidth = wa.Right - wa.Left, waHeight = wa.Bottom - wa.Top;
        hwnd = CreateWindowEx(0, "Chrome_WidgetWin_1", "ZCode", WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX,
            wa.Left + 100, wa.Top + 100, Math.Min(1600, waWidth - 200), Math.Min(1000, waHeight - 200), IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) { Console.Error.WriteLine("CreateWindowEx failed: " + Marshal.GetLastWin32Error()); return 1; }
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        Front();
        Reply(string.Format(CultureInfo.InvariantCulture, "ready {0} {1} {2} {3} {4}", hwnd.ToInt64(), wa.Left, wa.Top, waWidth, waHeight));
        new Thread(ReadCommands) { IsBackground = true, Name = "stdin" }.Start();

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
        GC.KeepAlive(Callback);
        GC.KeepAlive(BackdropCallback);
        return 0;
    }
}
