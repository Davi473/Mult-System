<#
  Injetor de mouse/teclado do CLIENTE KVM no Windows 11/10.

  Comandos via stdin:
    e <ratio>         -> controle entrou: posiciona o cursor a 40px da borda de entrada
    c <edge>          -> atualiza a borda de retorno (left, right, top, bottom)
    m <dx> <dy>       -> movimento relativo
    b <botao> <0|1>   -> botão (1=esq, 2=dir, 3=meio, 4=voltar, 5=avançar)
    w <dy> <dx>       -> rolagem
    k <codigo> <0|1>  -> tecla (código evdev do Linux -> scancode Win32)
    l                 -> controle saiu: solta todas as teclas/botões

  Saída via stdout:
    ready <largura>x<altura>
    r <ratio>         -> cursor atingiu a borda de retorno (devolver ao servidor)
    p <x> <y>         -> posição atual do cursor no cliente (para o Frontend visual)
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

    private static readonly Dictionary<int, int> Extended = new Dictionary<int, int>
    {
        { 96, 0x1C }, { 97, 0x1D }, { 98, 0x35 }, { 99, 0x37 }, { 100, 0x38 },
        { 102, 0x47 }, { 103, 0x48 }, { 104, 0x49 }, { 105, 0x4B }, { 106, 0x4D },
        { 107, 0x4F }, { 108, 0x50 }, { 109, 0x51 }, { 110, 0x52 }, { 111, 0x53 },
        { 125, 0x5B }, { 126, 0x5C }, { 127, 0x5D },
    };

    private static readonly Dictionary<int, int> VirtualKeys = new Dictionary<int, int>
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

    private static void Send(INPUT input)
    {
        SendInput(1, new INPUT[] { input }, InputSize);
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
        int vk;
        int scan;

        if (VirtualKeys.TryGetValue(code, out vk))
        {
            i.u.ki.wVk = (ushort)vk;
            i.u.ki.dwFlags = (code == 119 ? 0u : KEYEVENTF_EXTENDEDKEY) | (down ? 0u : KEYEVENTF_KEYUP);
        }
        else
        {
            bool ext = false;
            if (code >= 1 && code <= 88) scan = code;
            else if (code == 89) scan = 0x73;
            else if (code == 121) scan = 0x7E;
            else if (Extended.TryGetValue(code, out scan)) ext = true;
            else return;

            i.u.ki.wScan = (ushort)scan;
            i.u.ki.dwFlags = KEYEVENTF_SCANCODE | (ext ? KEYEVENTF_EXTENDEDKEY : 0u) | (down ? 0u : KEYEVENTF_KEYUP);
        }

        Send(i);
        if (down) PressedKeys.Add(code); else PressedKeys.Remove(code);
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
        string[] p = line.Split(' ');
        switch (p[0])
        {
            case "e": Enter(D(p[1])); break;
            case "c": returnEdge = p[1].Trim().ToLowerInvariant(); break;
            case "m": Move(I(p[1]), I(p[2])); break;
            case "b": if (active) Button(I(p[1]), p[2] == "1"); break;
            case "w": if (active) Wheel(I(p[1]), I(p[2])); break;
            case "k": if (active) Key(I(p[1]), p[2] == "1"); break;
            case "l": active = false; ReleaseAll(); break;
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
