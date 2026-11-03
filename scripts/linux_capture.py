#!/usr/bin/env python3
"""
Captura de mouse/teclado e sincronização de Clipboard do SERVIDOR KVM no Linux (Wayland e X11).
"""
import fcntl
import json
import math
import os
import select
import signal
import struct
import sys
import threading
import time

EVIOCGRAB = 0x40044590
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_SET_ABSBIT = 0x40045567
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0x00, 0x01, 0x02, 0x03
SYN_REPORT = 0
REL_X, REL_Y, REL_HWHEEL, REL_WHEEL = 0x00, 0x01, 0x06, 0x08
ABS_X, ABS_Y = 0x00, 0x01

MOUSE_BUTTONS = {0x110: 1, 0x111: 2, 0x112: 3, 0x113: 4, 0x114: 5}
KEY_SCROLLLOCK = 70
# Teclas modificadoras (Ctrl, Shift, Alt, Win/Super) não devem enviar auto-repeat (v == 2)
MODIFIER_KEYS = {29, 42, 54, 56, 97, 100, 125, 126}

EVENT_FMT = "llHHi"
EVENT_SIZE = struct.calcsize(EVENT_FMT)
VIRTUAL_PREFIX = "Mult-System Virtual"

stdout_lock = threading.Lock()


def log(msg):
    sys.stderr.write("[linux_capture] " + msg + "\n")
    sys.stderr.flush()


def send(obj):
    with stdout_lock:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def ev(t, c, v):
    return struct.pack(EVENT_FMT, 0, 0, t, c, int(v))


class LinuxClipboard:
    """Sincroniza a área de transferência do Linux (Wayland/X11) via GTK3 (forçando XWayland GDK_BACKEND=x11)."""

    def __init__(self):
        self.available = False
        self.last_text = ""
        self.cb = None
        self.GLib = None
        try:
            # No Wayland, processos em background precisam usar o backend X11 (XWayland)
            # para conseguir ler/escrever o clipboard global sem precisar de janela em foco.
            os.environ["GDK_BACKEND"] = "x11"
            import gi

            gi.require_version("Gtk", "3.0")
            from gi.repository import Gtk, Gdk, GLib

            self.Gtk = Gtk
            self.Gdk = Gdk
            self.GLib = GLib
            self.cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            self.available = True
            # Monitora mudanças no clipboard do Linux a cada 400ms automaticamente
            GLib.timeout_add(400, self._poll)
            t = threading.Thread(target=Gtk.main, daemon=True)
            t.start()
        except Exception as e:
            log("Clipboard GTK3 indisponível: %s" % e)

    def _poll(self):
        try:
            self.cb.request_text(self._on_text)
        except Exception:
            pass
        return True

    def read_and_send(self):
        if not self.available:
            return

        def _req():
            self.cb.request_text(self._on_text)
            return False

        self.GLib.idle_add(_req)

    def _on_text(self, _clipboard, text):
        if text and text != self.last_text:
            self.last_text = text
            send({"type": "clipboard", "text": text})

    def write(self, text):
        if not self.available or not text:
            return
        self.last_text = text

        def _set():
            self.cb.set_text(text, -1)
            self.cb.store()
            return False

        self.GLib.idle_add(_set)


def list_devices():
    """Retorna (mouses, teclados) lendo /proc/bus/input/devices."""
    mice, keyboards = [], []
    try:
        with open("/proc/bus/input/devices") as f:
            content = f.read()
    except OSError:
        return mice, keyboards

    for block in content.strip().split("\n\n"):
        name, handlers, evbits = "", [], 0
        for line in block.splitlines():
            if line.startswith("N: Name="):
                name = line[len("N: Name=") :].strip().strip('"')
            elif line.startswith("H: Handlers="):
                handlers = line[len("H: Handlers=") :].split()
            elif line.startswith("B: EV="):
                evbits = int(line[len("B: EV=") :].strip(), 16)

        if name.startswith(VIRTUAL_PREFIX):
            continue
        events = [h for h in handlers if h.startswith("event")]
        if not events:
            continue
        path = "/dev/input/" + events[0]

        is_mouse = any(h.startswith("mouse") for h in handlers) and (evbits & (1 << EV_REL)) != 0
        is_joystick = any(h.startswith("js") for h in handlers)
        is_keyboard = "kbd" in handlers and (evbits & 0x120013) == 0x120013 and not is_joystick

        if is_mouse:
            mice.append(path)
        elif is_keyboard:
            keyboards.append(path)
    return mice, keyboards


class VirtualPointer:
    """Ponteiro absoluto virtual via /dev/uinput para posicionar o cursor no retorno ao Servidor."""

    def __init__(self, width, height):
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        for t in (EV_SYN, EV_KEY, EV_REL, EV_ABS):
            fcntl.ioctl(self.fd, UI_SET_EVBIT, t)
        for code in MOUSE_BUTTONS:
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, code)
        for code in (REL_WHEEL, REL_HWHEEL):
            fcntl.ioctl(self.fd, UI_SET_RELBIT, code)
        for code in (ABS_X, ABS_Y):
            fcntl.ioctl(self.fd, UI_SET_ABSBIT, code)

        absmax = [0] * 64
        absmax[ABS_X] = width - 1
        absmax[ABS_Y] = height - 1
        zeros = [0] * 64
        name = (VIRTUAL_PREFIX + " Pointer").encode()
        os.write(
            self.fd,
            struct.pack("80sHHHHI64i64i64i64i", name, 0x03, 0x1234, 0x5679, 1, 0, *absmax, *zeros, *zeros, *zeros),
        )
        fcntl.ioctl(self.fd, UI_DEV_CREATE)

    def _write(self, *events):
        os.write(self.fd, b"".join(events) + ev(EV_SYN, SYN_REPORT, 0))

    def move(self, x, y):
        self._write(ev(EV_ABS, ABS_X, x), ev(EV_ABS, ABS_Y, y))

    def close(self):
        try:
            fcntl.ioctl(self.fd, UI_DEV_DESTROY)
        except OSError:
            pass
        os.close(self.fd)


class Capture:
    def __init__(self, cfg):
        self.width = int(cfg.get("width", 1920))
        self.height = int(cfg.get("height", 1080))
        self.edge = cfg.get("edge", "right")
        self.speed = float(cfg.get("speed", 1.0))
        self.accel = float(cfg.get("accel", 1.0))

        self.remote = False
        self.edge_notified = False
        self.x = self.width // 2
        self.y = self.height // 2
        self.frac_x = 0.0
        self.frac_y = 0.0
        self.cooldown_until = 0.0
        self.last_pos_sent = 0.0

        self.pointer = None
        self.clipboard = LinuxClipboard()
        self.mouse_fds = {}
        self.kbd_fds = {}
        self.motion = {}
        self.stdin_buf = b""

    def setup(self):
        mice, keyboards = list_devices()
        if not mice:
            raise RuntimeError("Nenhum mouse encontrado em /proc/bus/input/devices")

        try:
            self.pointer = VirtualPointer(self.width, self.height)
            time.sleep(0.2)
        except OSError as e:
            log("Aviso: uinput indisponível (%s)" % e)
            self.pointer = None

        for path in mice:
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                self.mouse_fds[fd] = path
                self.motion[fd] = [0, 0]
            except OSError as e:
                log("Não foi possível abrir mouse %s: %s" % (path, e))

        if not self.mouse_fds:
            raise RuntimeError("Nenhum mouse pôde ser aberto (verifique permissões em /dev/input)")

        for path in keyboards:
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                self.kbd_fds[fd] = path
            except OSError as e:
                log("Não foi possível abrir teclado %s: %s" % (path, e))

        send(
            {
                "type": "ready",
                "mice": list(self.mouse_fds.values()),
                "keyboards": list(self.kbd_fds.values()),
                "width": self.width,
                "height": self.height,
            }
        )

    def close(self):
        for fd in list(self.mouse_fds) + list(self.kbd_fds):
            try:
                fcntl.ioctl(fd, EVIOCGRAB, 0)
            except OSError:
                pass
            try:
                os.close(fd)
            except OSError:
                pass
        self.mouse_fds.clear()
        self.kbd_fds.clear()
        if self.pointer:
            self.pointer.close()
            self.pointer = None

    def run(self):
        stdin_fd = sys.stdin.fileno()
        os.set_blocking(stdin_fd, False)
        while True:
            fds = list(self.mouse_fds) + list(self.kbd_fds) + [stdin_fd]
            readable, _, _ = select.select(fds, [], [])
            for fd in readable:
                if fd == stdin_fd:
                    if not self.read_stdin(fd):
                        return
                elif fd in self.mouse_fds:
                    self.read_mouse(fd)
                elif fd in self.kbd_fds:
                    self.read_keyboard(fd)

    def read_events(self, fd, table):
        try:
            data = os.read(fd, EVENT_SIZE * 64)
        except BlockingIOError:
            return []
        except OSError as e:
            log("Dispositivo desconectado: %s (%s)" % (table.get(fd), e))
            table.pop(fd, None)
            self.motion.pop(fd, None)
            try:
                os.close(fd)
            except OSError:
                pass
            return []
        count = len(data) // EVENT_SIZE
        return [struct.unpack_from(EVENT_FMT, data, i * EVENT_SIZE)[2:] for i in range(count)]

    def read_stdin(self, fd):
        try:
            chunk = os.read(fd, 16384)
        except BlockingIOError:
            return True
        if not chunk:
            return False
        self.stdin_buf += chunk
        while b"\n" in self.stdin_buf:
            line, self.stdin_buf = self.stdin_buf.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            cmd = msg.get("cmd")
            if cmd == "remote":
                self.set_remote(bool(msg.get("on")), msg.get("yRatio"))
            elif cmd == "clipboard":
                self.clipboard.write(msg.get("text", ""))
            elif cmd == "config":
                if "edge" in msg:
                    self.edge = msg["edge"]
                    self.edge_notified = False
                if "speed" in msg:
                    self.speed = float(msg["speed"])
                if "accel" in msg:
                    self.accel = float(msg["accel"])
            elif cmd == "center":
                self.x = self.width // 2
                self.y = self.height // 2
                if self.pointer:
                    self.pointer.move(self.x, self.y)
                send({"type": "pos", "x": self.x, "y": self.y})
        return True

    def read_mouse(self, fd):
        for t, c, v in self.read_events(fd, self.mouse_fds):
            acc = self.motion.get(fd)
            if acc is None:
                return
            if t == EV_REL:
                if c == REL_X:
                    acc[0] += v
                elif c == REL_Y:
                    acc[1] += v
                elif c == REL_WHEEL:
                    self.on_wheel(v, 0)
                elif c == REL_HWHEEL:
                    self.on_wheel(0, v)
            elif t == EV_KEY and c in MOUSE_BUTTONS and v in (0, 1):
                self.on_button(c, v == 1)
            elif t == EV_SYN and c == SYN_REPORT and (acc[0] or acc[1]):
                self.on_motion(acc[0], acc[1])
                acc[0] = acc[1] = 0

    def read_keyboard(self, fd):
        for t, c, v in self.read_events(fd, self.kbd_fds):
            if t != EV_KEY:
                continue
            if c == KEY_SCROLLLOCK:
                if v == 1:
                    self.on_scrolllock()
                continue
            if not self.remote:
                continue
            # Ignora auto-repeat (v == 2) em teclas modificadoras (Ctrl, Shift, Alt, Win)
            if c in MODIFIER_KEYS and v == 2:
                continue
            if v in (0, 1, 2):
                send({"type": "key", "code": c, "down": v != 0})

    def on_motion(self, dx, dy):
        if self.remote:
            send({"type": "move", "dx": dx, "dy": dy})
            return

        speed = math.hypot(dx, dy)
        factor = self.speed * (1.0 + self.accel * min(speed, 30.0) / 30.0)
        self.frac_x += dx * factor
        self.frac_y += dy * factor
        mx, my = int(self.frac_x), int(self.frac_y)
        self.frac_x -= mx
        self.frac_y -= my
        if mx == 0 and my == 0:
            return

        nx = self.x + mx
        ny = self.y + my
        now = time.monotonic()

        crossed = False
        ratio = 0.5
        if now >= self.cooldown_until:
            if self.edge == "right" and nx >= self.width - 1 and mx > 0:
                crossed = True
                ratio = min(max(ny, 0), self.height - 1) / float(max(1, self.height - 1))
            elif self.edge == "left" and nx <= 0 and mx < 0:
                crossed = True
                ratio = min(max(ny, 0), self.height - 1) / float(max(1, self.height - 1))
            elif self.edge == "top" and ny <= 0 and my < 0:
                crossed = True
                ratio = min(max(nx, 0), self.width - 1) / float(max(1, self.width - 1))
            elif self.edge == "bottom" and ny >= self.height - 1 and my > 0:
                crossed = True
                ratio = min(max(nx, 0), self.width - 1) / float(max(1, self.width - 1))

        self.x = min(max(nx, 0), self.width - 1)
        self.y = min(max(ny, 0), self.height - 1)

        if now - self.last_pos_sent >= 0.033:
            self.last_pos_sent = now
            send({"type": "pos", "x": self.x, "y": self.y})

        if crossed:
            if not self.edge_notified:
                self.edge_notified = True
                send({"type": "edge", "yRatio": round(ratio, 4)})
        else:
            margin = 20
            away = (
                (self.edge == "right" and self.x < self.width - margin)
                or (self.edge == "left" and self.x > margin)
                or (self.edge == "top" and self.y > margin)
                or (self.edge == "bottom" and self.y < self.height - margin)
            )
            if away:
                self.edge_notified = False

    def on_button(self, code, down):
        if self.remote:
            send({"type": "button", "button": MOUSE_BUTTONS[code], "down": down})

    def on_wheel(self, dy, dx):
        if self.remote:
            send({"type": "wheel", "dy": dy, "dx": dx})

    def on_scrolllock(self):
        if self.remote:
            self.set_remote(False, None)
            send({"type": "emergency"})

    def set_remote(self, on, ratio):
        if on == self.remote:
            return
        if on:
            # Ao entrar no Cliente, lê o clipboard atual do Linux e envia para o Windows 11
            self.clipboard.read_and_send()
            for fd in list(self.mouse_fds) + list(self.kbd_fds):
                try:
                    fcntl.ioctl(fd, EVIOCGRAB, 1)
                except OSError as e:
                    log("Falha ao capturar dispositivo: %s" % e)
            self.remote = True
        else:
            for fd in list(self.mouse_fds) + list(self.kbd_fds):
                try:
                    fcntl.ioctl(fd, EVIOCGRAB, 0)
                except OSError:
                    pass
            self.remote = False
            self.cooldown_until = time.monotonic() + 0.30
            r = float(ratio) if ratio is not None else 0.5
            r = min(max(r, 0.0), 1.0)
            offset = 40
            if self.edge == "right":
                self.x = max(0, self.width - offset)
                self.y = int(r * (self.height - 1))
            elif self.edge == "left":
                self.x = min(self.width - 1, offset)
                self.y = int(r * (self.height - 1))
            elif self.edge == "top":
                self.x = int(r * (self.width - 1))
                self.y = min(self.height - 1, offset)
            elif self.edge == "bottom":
                self.x = int(r * (self.width - 1))
                self.y = max(0, self.height - offset)

            self.frac_x = self.frac_y = 0.0
            if self.pointer:
                self.pointer.move(self.x, self.y)
            send({"type": "pos", "x": self.x, "y": self.y})
        self.edge_notified = False


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--list":
        mice, keyboards = list_devices()
        print(json.dumps({"mice": mice, "keyboards": keyboards}))
        return

    cfg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    capture = Capture(cfg)
    try:
        capture.setup()
        capture.run()
    except KeyboardInterrupt:
        pass
    except RuntimeError as e:
        log(str(e))
        sys.exit(2)
    finally:
        capture.close()


if __name__ == "__main__":
    main()
