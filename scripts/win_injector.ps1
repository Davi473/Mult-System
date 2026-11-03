<#
  Injetor de mouse/teclado do CLIENTE KVM no Windows.

  Lê comandos de texto pelo stdin (um por linha) e injeta via SendInput (Win32):
    e <yRatio>        -> controle entrou: posiciona o cursor na borda de entrada
    m <dx> <dy>       -> movimento relativo
    b <botao> <0|1>   -> botão (1=esq, 2=dir, 3=meio, 4=voltar, 5=avançar)
    w <dy> <dx>       -> rolagem (em "cliques" da roda; positivo = cima/direita)
    k <codigo> <0|1>  -> tecla (código evdev do Linux, convertido para scancode)
    l                 -> controle saiu: solta todas as teclas/botões pressionados

  Escreve no stdout:
    ready <largura>x<altura>
    r <yRatio>        -> cursor atingiu a borda de retorno (devolver ao servidor)

  Teclas são enviadas por SCANCODE (independente do layout), então o layout
  ABNT2 / US configurado no Windows é respeitado.
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

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x1000;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_SCANCODE = 0x0008;

    // evdev -> scancode estendido (prefixo E0)
    private static readonly Dictionary<int, int> Extended = new Dictionary<int, int>
    {
        { 96, 0x1C },  // KP Enter
        { 97, 0x1D },  // Ctrl direito
        { 98, 0x35 },  // KP /
        { 99, 0x37 },  // PrintScreen
        { 100, 0x38 }, // Alt direito / AltGr
        { 102, 0x47 }, // Home
        { 103, 0x48 }, // Cima
        { 104, 0x49 }, // PageUp
        { 105, 0x4B }, // Esquerda
        { 106, 0x4D }, // Direita
        { 107, 0x4F }, // End
        { 108, 0x50 }, // Baixo
        { 109, 0x51 }, // PageDown
        { 110, 0x52 }, // Insert
        { 111, 0x53 }, // Delete
        { 125, 0x5B }, // Windows esquerdo
        { 126, 0x5C }, // Windows direito
        { 127, 0x5D }, // Menu
    };

    // evdev -> Virtual Key (teclas de mídia e Pause)
    private static readonly Dictionary<int, int> VirtualKeys = new Dictionary<int, int>
    {
        { 113, 0xAD }, // Mudo
        { 114, 0xAE }, // Volume -
        { 115, 0xAF }, // Volume +
        { 119, 0x13 }, // Pause
        { 163, 0xB0 }, // Próxima faixa
        { 164, 0xB3 }, // Play/Pause
        { 165, 0xB1 }, // Faixa anterior
        { 166, 0xB2 }, // Stop
    };

    private static readonly HashSet<int> PressedKeys = new HashSet<int>();
    private static readonly HashSet<int> PressedButtons = new HashSet<int>();
    private static readonly int InputSize = Marshal.SizeOf(typeof(INPUT));
    private static StreamWriter output;
    private static bool active;
    private static bool returnLeft = true;
    private static int vx, vy, vw, vh;

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

    private static void RefreshBounds()
    {
        vx = GetSystemMetrics(76); // SM_XVIRTUALSCREEN
        vy = GetSystemMetrics(77); // SM_YVIRTUALSCREEN
        vw = GetSystemMetrics(78); // SM_CXVIRTUALSCREEN
        vh = GetSystemMetrics(79); // SM_CYVIRTUALSCREEN
    }

    private static void Enter(double ratio)
    {
        RefreshBounds();
        int x = returnLeft ? vx + 3 : vx + vw - 4;
        int y = vy + (int)Math.Round(Math.Max(0.0, Math.Min(1.0, ratio)) * (vh - 1));
        SetCursorPos(x, y);
        active = true;
    }

    private static void Move(int dx, int dy)
    {
        if (!active) return;
        Mouse(dx, dy, 0, MOUSEEVENTF_MOVE);

        POINT p;
        GetCursorPos(out p);
        bool hit = returnLeft ? (p.X <= vx && dx < 0) : (p.X >= vx + vw - 1 && dx > 0);
        if (hit)
        {
            active = false;
            ReleaseAll();
            double ratio = vh > 1 ? (double)(p.Y - vy) / (vh - 1) : 0.5;
            output.WriteLine("r " + ratio.ToString("0.0000", CultureInfo.InvariantCulture));
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
            if (code >= 1 && code <= 88) scan = code;          // mesmo valor do scancode set 1
            else if (code == 89) scan = 0x73;                  // KEY_RO  (ABNT2: tecla / ?)
            else if (code == 121) scan = 0x7E;                 // KEY_KPCOMMA (ABNT2: . do numpad)
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
            case "m": Move(I(p[1]), I(p[2])); break;
            case "b": if (active) Button(I(p[1]), p[2] == "1"); break;
            case "w": if (active) Wheel(I(p[1]), I(p[2])); break;
            case "k": if (active) Key(I(p[1]), p[2] == "1"); break;
            case "l": active = false; ReleaseAll(); break;
        }
    }

    public static void Run(string edge)
    {
        returnLeft = edge != "right";
        SetProcessDPIAware();
        RefreshBounds();

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
