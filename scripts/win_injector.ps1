<#
  Injetor de mouse/teclado e sincronização de Clipboard do CLIENTE KVM no Windows 11/10.

  Comandos via stdin:
    e <ratio>         -> controle entrou: posiciona o cursor a 40px da borda de entrada
    c <edge>          -> atualiza a borda de retorno (left, right, top, bottom)
    cb <base64>       -> atualiza o Clipboard do Windows com o texto copiado no Linux
    m <dx> <dy>       -> movimento relativo
    b <botao> <0|1>   -> botão (1=esq, 2=dir, 3=meio, 4=voltar, 5=avançar)
    w <dy> <dx>       -> rolagem
    k <codigo> <0|1>  -> tecla (código evdev do Linux -> VirtualKey + Scancode Win32)
    l                 -> controle saiu: solta todas as teclas/botões

  Saída via stdout:
    ready <largura>x<altura>
    r <ratio>         -> cursor atingiu a borda de retorno (devolver ao servidor)
    p <x> <y>         -> posição atual do cursor no cliente (para o Frontend visual)
    cb <base64>       -> texto copiado no Windows (para atualizar o Clipboard do Linux)
#>
param([string]$ReturnEdge = 'left')

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class KvmInjector
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")] private static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    [DllImport("user32.dll")] private static extern bool EmptyClipboard();
    [DllImport("user32.dll")] private static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] private static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll")] private static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr hMem);

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
        { 96,  new int[] { 0x1C, 0x0D } }, // KP Enter
        { 97,  new int[] { 0x1D, 0xA3 } }, // Right Ctrl (VK_RCONTROL)
        { 98,  new int[] { 0x35, 0x6F } }, // KP /
        { 99,  new int[] { 0x37, 0x2C } }, // PrintScreen
        { 100, new int[] { 0x38, 0xA5 } }, // Right Alt / AltGr (VK_RMENU)
        { 102, new int[] { 0x47, 0x24 } }, // Home
        { 103, new int[] { 0x48, 0x26 } }, // Up
        { 104, new int[] { 0x49, 0x21 } }, // PageUp
        { 105, new int[] { 0x4B, 0x25 } }, // Left
        { 106, new int[] { 0x4D, 0x27 } }, // Right
        { 107, new int[] { 0x4F, 0x23 } }, // End
        { 108, new int[] { 0x50, 0x28 } }, // Down
        { 109, new int[] { 0x51, 0x22 } }, // PageDown
        { 110, new int[] { 0x52, 0x2D } }, // Insert
        { 111, new int[] { 0x53, 0x2E } }, // Delete
        { 125, new int[] { 0x5B, 0x5B } }, // Left Win (VK_LWIN)
        { 126, new int[] { 0x5C, 0x5C } }, // Right Win (VK_RWIN)
        { 127, new int[] { 0x5D, 0x5D } }, // Menu (VK_APPS)
    };

    private static readonly Dictionary<int, int> MediaVirtualKeys = new Dictionary<int, int>
    {
        { 113, 0xAD }, { 114, 0xAE }, { 115, 0xAF }, { 119, 0x13 },
        { 163, 0xB0 }, { 164, 0xB3 }, { 165, 0xB1 }, { 166, 0xB2 },
    };

    private static readonly HashSet<int> PressedKeys = new HashSet<int>();
    private static readonly HashSet<int> PressedButtons = new HashSet<int>();
    private static readonly int InputSize = Marshal.SizeOf(typeof(INPUT));
    private static StreamWriter output;
    private static bool active;
    private static string returnEdge = "left";
    private static int vx, vy, vw, vh;
    private static int curX, curY;
    private static long cooldownUntilTick;
    private static long lastPosTick;
    private static string lastClipboard = "";

    private static void Send(INPUT input)
    {
        SendInput(1, new INPUT[] { input }, InputSize);
    }

    private static string ReadClipboardText()
    {
        if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            if (OpenClipboard(IntPtr.Zero))
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
        lastClipboard = text;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            if (OpenClipboard(IntPtr.Zero))
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
                    return;
                }
                finally { CloseClipboard(); }
            }
            Thread.Sleep(10);
        }
    }

    private static void CheckAndSendClipboard()
    {
        try
        {
            string txt = ReadClipboardText();
            if (!string.IsNullOrEmpty(txt) && txt != lastClipboard)
            {
                lastClipboard = txt;
                string b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(txt));
                output.WriteLine("cb " + b64);
            }
        }
        catch { }
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
        SetCursorPos(x, y);
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

    private static void Enter(double ratio)
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
        cooldownUntilTick = Environment.TickCount + 300;
        active = true;
        MoveCursorAbsolute(curX, curY);
        output.WriteLine("p " + (curX - vx) + " " + (curY - vy));
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
                active = false;
                ReleaseAll();
                CheckAndSendClipboard();
                output.WriteLine("r " + ratio.ToString("0.0000", CultureInfo.InvariantCulture));
                return;
            }
        }

        curX = Math.Max(vx, Math.Min(vx + vw - 1, nx));
        curY = Math.Max(vy, Math.Min(vy + vh - 1, ny));
        MoveCursorAbsolute(curX, curY);

        if (now - lastPosTick >= 33)
        {
            lastPosTick = now;
            output.WriteLine("p " + (curX - vx) + " " + (curY - vy));
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
            else if (code == 89) scan = 0x73;  // ABNT2: / ?
            else if (code == 121) scan = 0x7E; // ABNT2: . do numpad
            else return;

            if (code == 29) vk = 0xA2;      // Left Ctrl (VK_LCONTROL)
            else if (code == 42) vk = 0xA0; // Left Shift (VK_LSHIFT)
            else if (code == 54) vk = 0xA1; // Right Shift (VK_RSHIFT)
            else if (code == 56) vk = 0xA4; // Left Alt (VK_LMENU)
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

        // Se acabou de soltar C (46) ou X (45) com Ctrl (29 ou 97) pressionado, sincroniza o clipboard!
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
            case "l": active = false; ReleaseAll(); CheckAndSendClipboard(); break;
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
        output.WriteLine("ready " + vw + "x" + vh);

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
