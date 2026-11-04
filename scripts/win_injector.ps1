<#
  Injetor e Capturador Bidirecional de mouse/teclado + Clipboard do CLIENTE KVM no Windows 11/10.

  Comandos via stdin (Servidor -> Cliente):
    e <ratio>         -> Servidor assumiu controle do Cliente: posiciona cursor a 40px da borda
    cr <ratio>        -> Cliente estava controlando o Servidor e o cursor voltou para o Cliente
    c <edge>          -> atualiza a borda de transição/retorno (left, right, top, bottom)
    cb <base64>       -> atualiza o Clipboard do Windows com o texto copiado no Linux
    m <dx> <dy>       -> movimento relativo injetado no Windows
    b <botao> <0|1>   -> botão injetado no Windows
    w <dy> <dx>       -> rolagem injetada no Windows
    k <codigo> <0|1>  -> tecla injetada no Windows
    l                 -> controle saiu: solta todas as teclas/botões

  Saída via stdout (Cliente -> Servidor):
    ready <largura>x<altura>
    r <ratio>         -> cursor do Servidor atingiu a borda de retorno no Cliente
    p <x> <y>         -> posição atual do cursor no Cliente
    cb <base64>       -> texto copiado no Windows (para atualizar o Clipboard do Linux)
    cs_e <ratio>      -> mouse físico do Cliente atingiu a borda para controlar o Servidor Linux!
    cs_l              -> ScrollLock pressionado no Cliente (encerra controle do Servidor)
    cs_m <dx> <dy>    -> movimento do mouse físico do Cliente enviado ao Servidor
    cs_b <btn> <0|1>  -> botão do mouse físico do Cliente enviado ao Servidor
    cs_w <dy> <dx>    -> rolagem do mouse físico do Cliente enviada ao Servidor
    cs_k <code> <0|1> -> tecla física do Cliente (em código evdev) enviada ao Servidor
#>
param([string]$ReturnEdge = 'left')

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class KvmInjector
{
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public INPUTUNION u; }

    private delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")] private static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    [DllImport("user32.dll")] private static extern bool EmptyClipboard();
    [DllImport("user32.dll")] private static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] private static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll")] private static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowExW(
        uint dwExStyle, string lpClassName, string lpWindowName, uint dwStyle,
        int x, int y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr hMem);

    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x1000;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_SCANCODE = 0x0008;
    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;

    // evdev -> (scancode, virtualKey) para teclas estendidas (E0)
    private static readonly Dictionary<int, int[]> ExtendedKeys = new Dictionary<int, int[]>
    {
        { 96,  new int[] { 0x1C, 0x0D } },
        { 97,  new int[] { 0x1D, 0xA3 } },
        { 98,  new int[] { 0x35, 0x6F } },
        { 99,  new int[] { 0x37, 0x2C } },
        { 100, new int[] { 0x38, 0xA5 } },
        { 102, new int[] { 0x47, 0x24 } },
        { 103, new int[] { 0x48, 0x26 } },
        { 104, new int[] { 0x49, 0x21 } },
        { 105, new int[] { 0x4B, 0x25 } },
        { 106, new int[] { 0x4D, 0x27 } },
        { 107, new int[] { 0x4F, 0x23 } },
        { 108, new int[] { 0x50, 0x28 } },
        { 109, new int[] { 0x51, 0x22 } },
        { 110, new int[] { 0x52, 0x2D } },
        { 111, new int[] { 0x53, 0x2E } },
        { 125, new int[] { 0x5B, 0x5B } },
        { 126, new int[] { 0x5C, 0x5C } },
        { 127, new int[] { 0x5D, 0x5D } },
    };

    private static readonly Dictionary<int, int> MediaVirtualKeys = new Dictionary<int, int>
    {
        { 113, 0xAD }, { 114, 0xAE }, { 115, 0xAF }, { 119, 0x13 },
        { 163, 0xB0 }, { 164, 0xB3 }, { 165, 0xB1 }, { 166, 0xB2 },
    };

    private static readonly HashSet<int> PressedKeys = new HashSet<int>();
    private static readonly HashSet<int> PressedButtons = new HashSet<int>();
    private static readonly int InputSize = Marshal.SizeOf(typeof(INPUT));
    private static readonly object outLock = new object();
    private static StreamWriter output;

    private static volatile bool active;           // True quando Servidor Linux controla este Windows
    private static volatile bool capturingServer;  // True quando mouse/teclado físico deste Windows controla o Linux
    private static string returnEdge = "left";
    private static int vx, vy, vw, vh;
    private static int curX, curY;
    private static int lastPhysX, lastPhysY;
    private static bool hasLastPhys;
    private static long cooldownUntilTick;
    private static long lastPosTick;
    private static string lastClipboard = "";
    private static uint lastClipSeq = 0;
    private static IntPtr clipHwnd = IntPtr.Zero;
    private static readonly object clipLock = new object();
    private static Timer clipTimer;

    private static IntPtr mouseHook = IntPtr.Zero;
    private static IntPtr kbdHook = IntPtr.Zero;
    private static readonly LowLevelProc mouseProcDelegate = MouseHookCallback;
    private static readonly LowLevelProc kbdProcDelegate = KeyboardHookCallback;

    private static void WriteOut(string line)
    {
        lock (outLock)
        {
            if (output != null)
            {
                output.WriteLine(line);
            }
        }
    }

    private static void Send(INPUT input)
    {
        SendInput(1, new INPUT[] { input }, InputSize);
    }

    private static IntPtr EnsureClipWindow()
    {
        if (clipHwnd == IntPtr.Zero)
        {
            clipHwnd = CreateWindowExW(0, "Static", "MultSystemKVMClip", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        }
        return clipHwnd;
    }

    private static string ReadClipboardText()
    {
        if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            if (OpenClipboard(EnsureClipWindow()))
            {
                try
                {
                    IntPtr handle = GetClipboardData(CF_UNICODETEXT);
                    if (handle == IntPtr.Zero) return null;
                    IntPtr ptr = GlobalLock(handle);
                    if (ptr == IntPtr.Zero) return null;
                    try { return Marshal.PtrToStringUni(ptr); }
                    finally { GlobalUnlock(handle); }
                }
                finally { CloseClipboard(); }
            }
            Thread.Sleep(10);
        }
        return null;
    }

    private static void WriteClipboardText(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        lock (clipLock)
        {
            lastClipboard = text;
            for (int attempt = 0; attempt < 5; attempt++)
            {
                if (OpenClipboard(EnsureClipWindow()))
                {
                    try
                    {
                        EmptyClipboard();
                        byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
                        IntPtr hGlobal = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes.Length);
                        if (hGlobal == IntPtr.Zero) return;
                        IntPtr target = GlobalLock(hGlobal);
                        if (target == IntPtr.Zero) return;
                        try { Marshal.Copy(bytes, 0, target, bytes.Length); }
                        finally { GlobalUnlock(hGlobal); }
                        SetClipboardData(CF_UNICODETEXT, hGlobal);
                        lastClipSeq = GetClipboardSequenceNumber();
                        return;
                    }
                    finally { CloseClipboard(); }
                }
                Thread.Sleep(10);
            }
        }
    }

    private static void CheckAndSendClipboard()
    {
        lock (clipLock)
        {
            try
            {
                uint seq = GetClipboardSequenceNumber();
                if (seq == lastClipSeq) return;
                lastClipSeq = seq;

                string txt = ReadClipboardText();
                if (!string.IsNullOrEmpty(txt) && txt != lastClipboard)
                {
                    lastClipboard = txt;
                    string b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(txt));
                    WriteOut("cb " + b64);
                }
            }
            catch { }
        }
    }

    private static int ScanToEvdev(int scan, bool ext, int vk)
    {
        if (ext)
        {
            switch (scan)
            {
                case 0x1C: return 96;
                case 0x1D: return 97;
                case 0x35: return 98;
                case 0x37: return 99;
                case 0x38: return 100;
                case 0x47: return 102;
                case 0x48: return 103;
                case 0x49: return 104;
                case 0x4B: return 105;
                case 0x4D: return 106;
                case 0x4F: return 107;
                case 0x50: return 108;
                case 0x51: return 109;
                case 0x52: return 110;
                case 0x53: return 111;
                case 0x5B: return 125;
                case 0x5C: return 126;
                case 0x5D: return 127;
            }
        }
        if (scan >= 1 && scan <= 88) return scan;
        if (scan == 0x73) return 89;
        if (scan == 0x7E) return 121;
        if (vk == 0xA2) return 29;
        if (vk == 0xA3) return 97;
        if (vk == 0xA0) return 42;
        if (vk == 0xA1) return 54;
        if (vk == 0xA4) return 56;
        if (vk == 0xA5) return 100;
        return 0;
    }

    private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            MSLLHOOKSTRUCT ms = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            // Ignora eventos injetados pelo próprio SendInput ou quando o Servidor Linux está no controle
            if ((ms.flags & 0x03) == 0 && !active)
            {
                int msg = wParam.ToInt32();
                if (!capturingServer)
                {
                    if (msg == 0x0200) // WM_MOUSEMOVE local no Windows
                    {
                        int dx = hasLastPhys ? (ms.pt.X - lastPhysX) : 0;
                        int dy = hasLastPhys ? (ms.pt.Y - lastPhysY) : 0;
                        lastPhysX = ms.pt.X;
                        lastPhysY = ms.pt.Y;
                        hasLastPhys = true;

                        if (Environment.TickCount - cooldownUntilTick >= 0)
                        {
                            RefreshBounds();
                            bool hit = false;
                            double ratio = 0.5;
                            if (returnEdge == "left" && ms.pt.X <= vx + 1 && dx < 0)
                            {
                                hit = true;
                                ratio = vh > 1 ? (double)(Math.Max(vy, Math.Min(vy + vh - 1, ms.pt.Y)) - vy) / (vh - 1) : 0.5;
                            }
                            else if (returnEdge == "right" && ms.pt.X >= vx + vw - 2 && dx > 0)
                            {
                                hit = true;
                                ratio = vh > 1 ? (double)(Math.Max(vy, Math.Min(vy + vh - 1, ms.pt.Y)) - vy) / (vh - 1) : 0.5;
                            }
                            else if (returnEdge == "top" && ms.pt.Y <= vy + 1 && dy < 0)
                            {
                                hit = true;
                                ratio = vw > 1 ? (double)(Math.Max(vx, Math.Min(vx + vw - 1, ms.pt.X)) - vx) / (vw - 1) : 0.5;
                            }
                            else if (returnEdge == "bottom" && ms.pt.Y >= vy + vh - 2 && dy > 0)
                            {
                                hit = true;
                                ratio = vw > 1 ? (double)(Math.Max(vx, Math.Min(vx + vw - 1, ms.pt.X)) - vx) / (vw - 1) : 0.5;
                            }

                            if (hit)
                            {
                                capturingServer = true;
                                cooldownUntilTick = Environment.TickCount + 300;
                                CheckAndSendClipboard();
                                WriteOut("cs_e " + ratio.ToString("0.0000", CultureInfo.InvariantCulture));
                                return (IntPtr)1;
                            }
                        }
                    }
                }
                else
                {
                    // Modo Cliente -> Servidor ativo: intercepta o mouse físico do Windows e envia ao Linux
                    if (msg == 0x0200) // WM_MOUSEMOVE
                    {
                        POINT cur;
                        GetCursorPos(out cur);
                        int dx = ms.pt.X - cur.X;
                        int dy = ms.pt.Y - cur.Y;
                        if (dx != 0 || dy != 0)
                        {
                            WriteOut("cs_m " + dx + " " + dy);
                        }
                        return (IntPtr)1;
                    }
                    else if (msg == 0x0201) { WriteOut("cs_b 1 1"); return (IntPtr)1; }
                    else if (msg == 0x0202) { WriteOut("cs_b 1 0"); return (IntPtr)1; }
                    else if (msg == 0x0204) { WriteOut("cs_b 2 1"); return (IntPtr)1; }
                    else if (msg == 0x0205) { WriteOut("cs_b 2 0"); return (IntPtr)1; }
                    else if (msg == 0x0207) { WriteOut("cs_b 3 1"); return (IntPtr)1; }
                    else if (msg == 0x0208) { WriteOut("cs_b 3 0"); return (IntPtr)1; }
                    else if (msg == 0x020B)
                    {
                        int xb = ((ms.mouseData >> 16) & 0xFFFF) == 1 ? 4 : 5;
                        WriteOut("cs_b " + xb + " 1");
                        return (IntPtr)1;
                    }
                    else if (msg == 0x020C)
                    {
                        int xb = ((ms.mouseData >> 16) & 0xFFFF) == 1 ? 4 : 5;
                        WriteOut("cs_b " + xb + " 0");
                        return (IntPtr)1;
                    }
                    else if (msg == 0x020A) // WM_MOUSEWHEEL
                    {
                        short delta = (short)((ms.mouseData >> 16) & 0xFFFF);
                        int steps = delta / 120;
                        if (steps == 0) steps = Math.Sign(delta);
                        if (steps != 0) WriteOut("cs_w " + steps + " 0");
                        return (IntPtr)1;
                    }
                    else if (msg == 0x020E) // WM_MOUSEHWHEEL
                    {
                        short delta = (short)((ms.mouseData >> 16) & 0xFFFF);
                        int steps = delta / 120;
                        if (steps == 0) steps = Math.Sign(delta);
                        if (steps != 0) WriteOut("cs_w 0 " + steps);
                        return (IntPtr)1;
                    }
                }
            }
        }
        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
    }

    private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && capturingServer && !active)
        {
            KBDLLHOOKSTRUCT kb = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            if ((kb.flags & 0x12) == 0)
            {
                int msg = wParam.ToInt32();
                bool down = (msg == 0x0100 || msg == 0x0104);
                if (kb.vkCode == 0x91) // ScrollLock libera o controle imediatamente
                {
                    if (down)
                    {
                        capturingServer = false;
                        cooldownUntilTick = Environment.TickCount + 300;
                        WriteOut("cs_l");
                    }
                    return (IntPtr)1;
                }

                bool ext = (kb.flags & 0x01) != 0;
                int evCode = ScanToEvdev((int)kb.scanCode, ext, (int)kb.vkCode);
                if (evCode > 0)
                {
                    WriteOut("cs_k " + evCode + " " + (down ? "1" : "0"));
                }
                return (IntPtr)1;
            }
        }
        return CallNextHookEx(kbdHook, nCode, wParam, lParam);
    }

    private static void StartHooksThread()
    {
        Thread t = new Thread(() =>
        {
            IntPtr hMod = GetModuleHandle(null);
            mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProcDelegate, hMod, 0);
            kbdHook = SetWindowsHookEx(WH_KEYBOARD_LL, kbdProcDelegate, hMod, 0);
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    private static void Mouse(int dx, int dy, uint data, uint flags)
    {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dx = dx;
        i.u.mi.dy = dy;
        i.u.mi.mouseData = data;
        i.u.mi.dwFlags = flags;
        Send(i);
    }

    private static void MoveCursorAbsolute(int x, int y)
    {
        // Usa exclusivamente SendInput (que marca a flag LLMHF_INJECTED = 1),
        // evitando que o SetCursorPos dispare o hook físico WH_MOUSE_LL por engano!
        int normX = vw > 1 ? (int)Math.Round(((double)(x - vx) * 65535.0) / (vw - 1)) : 0;
        int normY = vh > 1 ? (int)Math.Round(((double)(y - vy) * 65535.0) / (vh - 1)) : 0;
        Mouse(normX, normY, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
    }

    private static void RefreshBounds()
    {
        vx = GetSystemMetrics(76);
        vy = GetSystemMetrics(77);
        vw = GetSystemMetrics(78);
        vh = GetSystemMetrics(79);
        if (vw <= 0) vw = GetSystemMetrics(0);
        if (vh <= 0) vh = GetSystemMetrics(1);
    }

    private static void PlaceAtReturnEdge(double ratio)
    {
        RefreshBounds();
        double r = Math.Max(0.0, Math.Min(1.0, ratio));
        int offset = 40;

        if (returnEdge == "left")
        {
            curX = vx + offset;
            curY = vy + (int)Math.Round(r * (vh - 1));
        }
        else if (returnEdge == "right")
        {
            curX = vx + vw - 1 - offset;
            curY = vy + (int)Math.Round(r * (vh - 1));
        }
        else if (returnEdge == "top")
        {
            curX = vx + (int)Math.Round(r * (vw - 1));
            curY = vy + offset;
        }
        else
        {
            curX = vx + (int)Math.Round(r * (vw - 1));
            curY = vy + vh - 1 - offset;
        }

        curX = Math.Max(vx, Math.Min(vx + vw - 1, curX));
        curY = Math.Max(vy, Math.Min(vy + vh - 1, curY));
        lastPhysX = curX;
        lastPhysY = curY;
        cooldownUntilTick = Environment.TickCount + 300;
        MoveCursorAbsolute(curX, curY);
        WriteOut("p " + (curX - vx) + " " + (curY - vy));
    }

    private static void Enter(double ratio)
    {
        capturingServer = false;
        active = true;
        PlaceAtReturnEdge(ratio);
    }

    private static void ClientReturned(double ratio)
    {
        capturingServer = false;
        active = false;
        PlaceAtReturnEdge(ratio);
    }

    private static void Move(int dx, int dy)
    {
        if (!active) return;

        int nx = curX + dx;
        int ny = curY + dy;
        long now = Environment.TickCount;

        if (now - cooldownUntilTick >= 0)
        {
            bool hit = false;
            double ratio = 0.5;
            if (returnEdge == "left" && nx <= vx && dx < 0)
            {
                hit = true;
                ratio = vh > 1 ? (double)(Math.Max(vy, Math.Min(vy + vh - 1, ny)) - vy) / (vh - 1) : 0.5;
            }
            else if (returnEdge == "right" && nx >= vx + vw - 1 && dx > 0)
            {
                hit = true;
                ratio = vh > 1 ? (double)(Math.Max(vy, Math.Min(vy + vh - 1, ny)) - vy) / (vh - 1) : 0.5;
            }
            else if (returnEdge == "top" && ny <= vy && dy < 0)
            {
                hit = true;
                ratio = vw > 1 ? (double)(Math.Max(vx, Math.Min(vx + vw - 1, nx)) - vx) / (vw - 1) : 0.5;
            }
            else if (returnEdge == "bottom" && ny >= vy + vh - 1 && dy > 0)
            {
                hit = true;
                ratio = vw > 1 ? (double)(Math.Max(vx, Math.Min(vx + vw - 1, nx)) - vx) / (vw - 1) : 0.5;
            }

            if (hit)
            {
                PlaceAtReturnEdge(ratio);
                cooldownUntilTick = Environment.TickCount + 500;
                active = false;
                ReleaseAll();
                CheckAndSendClipboard();
                WriteOut("r " + ratio.ToString("0.0000", CultureInfo.InvariantCulture));
                return;
            }
        }

        curX = Math.Max(vx, Math.Min(vx + vw - 1, nx));
        curY = Math.Max(vy, Math.Min(vy + vh - 1, ny));
        MoveCursorAbsolute(curX, curY);

        if (now - lastPosTick >= 33)
        {
            lastPosTick = now;
            WriteOut("p " + (curX - vx) + " " + (curY - vy));
        }
    }

    private static void Button(int button, bool down)
    {
        uint flags;
        uint data = 0;
        switch (button)
        {
            case 1: flags = down ? 0x0002u : 0x0004u; break;
            case 2: flags = down ? 0x0008u : 0x0010u; break;
            case 3: flags = down ? 0x0020u : 0x0040u; break;
            case 4: flags = down ? 0x0080u : 0x0100u; data = 1; break;
            case 5: flags = down ? 0x0080u : 0x0100u; data = 2; break;
            default: return;
        }
        Mouse(0, 0, data, flags);
        if (down) PressedButtons.Add(button); else PressedButtons.Remove(button);
    }

    private static void Wheel(int dy, int dx)
    {
        if (dy != 0) Mouse(0, 0, unchecked((uint)(dy * 120)), MOUSEEVENTF_WHEEL);
        if (dx != 0) Mouse(0, 0, unchecked((uint)(dx * 120)), MOUSEEVENTF_HWHEEL);
    }

    private static void Key(int code, bool down)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        int vk = 0;
        int scan = 0;
        int[] extPair;

        if (MediaVirtualKeys.TryGetValue(code, out vk))
        {
            i.u.ki.wVk = (ushort)vk;
            i.u.ki.dwFlags = (code == 119 ? 0u : KEYEVENTF_EXTENDEDKEY) | (down ? 0u : KEYEVENTF_KEYUP);
        }
        else if (ExtendedKeys.TryGetValue(code, out extPair))
        {
            scan = extPair[0];
            vk = extPair[1];
            i.u.ki.wVk = (ushort)vk;
            i.u.ki.wScan = (ushort)scan;
            i.u.ki.dwFlags = KEYEVENTF_EXTENDEDKEY | (down ? 0u : KEYEVENTF_KEYUP);
        }
        else
        {
            if (code >= 1 && code <= 88) scan = code;
            else if (code == 89) scan = 0x73;
            else if (code == 121) scan = 0x7E;
            else return;

            if (code == 29) vk = 0xA2;
            else if (code == 42) vk = 0xA0;
            else if (code == 54) vk = 0xA1;
            else if (code == 56) vk = 0xA4;
            else vk = (int)MapVirtualKey((uint)scan, 1);

            if (vk != 0)
            {
                i.u.ki.wVk = (ushort)vk;
                i.u.ki.wScan = (ushort)scan;
                i.u.ki.dwFlags = down ? 0u : KEYEVENTF_KEYUP;
            }
            else
            {
                i.u.ki.wScan = (ushort)scan;
                i.u.ki.dwFlags = KEYEVENTF_SCANCODE | (down ? 0u : KEYEVENTF_KEYUP);
            }
        }

        Send(i);
        if (down) PressedKeys.Add(code); else PressedKeys.Remove(code);

        if (!down && (code == 46 || code == 45) && (PressedKeys.Contains(29) || PressedKeys.Contains(97)))
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Thread.Sleep(60);
                CheckAndSendClipboard();
            });
        }
    }

    private static void ReleaseAll()
    {
        foreach (int code in new List<int>(PressedKeys)) Key(code, false);
        foreach (int button in new List<int>(PressedButtons)) Button(button, false);
    }

    private static int I(string s) { return int.Parse(s, CultureInfo.InvariantCulture); }
    private static double D(string s) { return double.Parse(s, CultureInfo.InvariantCulture); }

    private static void Handle(string line)
    {
        string[] p = line.Split(new char[] { ' ' }, 2);
        string cmd = p[0];
        string arg = p.Length > 1 ? p[1] : "";

        switch (cmd)
        {
            case "e": Enter(D(arg)); break;
            case "cr": ClientReturned(D(arg)); break;
            case "c": returnEdge = arg.Trim().ToLowerInvariant(); break;
            case "cb":
                try
                {
                    string text = Encoding.UTF8.GetString(Convert.FromBase64String(arg.Trim()));
                    WriteClipboardText(text);
                }
                catch { }
                break;
            case "m":
                string[] mp = arg.Split(' ');
                Move(I(mp[0]), I(mp[1]));
                break;
            case "b":
                if (active)
                {
                    string[] bp = arg.Split(' ');
                    Button(I(bp[0]), bp[1] == "1");
                }
                break;
            case "w":
                if (active)
                {
                    string[] wp = arg.Split(' ');
                    Wheel(I(wp[0]), I(wp[1]));
                }
                break;
            case "k":
                if (active)
                {
                    string[] kp = arg.Split(' ');
                    Key(I(kp[0]), kp[1] == "1");
                }
                break;
            case "l": active = false; capturingServer = false; ReleaseAll(); CheckAndSendClipboard(); break;
        }
    }

    public static void Run(string edge)
    {
        returnEdge = edge.Trim().ToLowerInvariant();
        SetProcessDPIAware();
        RefreshBounds();
        curX = vx + vw / 2;
        curY = vy + vh / 2;

        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;
        WriteOut("ready " + vw + "x" + vh);

        lastClipSeq = GetClipboardSequenceNumber();
        clipTimer = new Timer(_ => CheckAndSendClipboard(), null, 400, 400);
        StartHooksThread();

        StreamReader input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
        string line;
        while ((line = input.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            try { Handle(line); }
            catch (Exception ex) { Console.Error.WriteLine("[win_injector] erro: " + ex.Message); }
        }
        ReleaseAll();
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[KvmInjector]::Run($ReturnEdge)
