#!/usr/bin/env python3
"""
Captura e Injeção bidirecional de mouse/teclado + Clipboard do SERVIDOR KVM no Linux (Wayland e X11).
- O mouse e teclado físicos do Servidor Linux funcionam sempre localmente no Linux e, ao cruzar a borda,
  assumem o controle do Cliente Windows 11.
- O mouse e teclado físicos do Cliente Windows 11, ao cruzar a borda para o Linux, movem o cursor e
  digitam no Linux via /dev/uinput (EV_REL + EV_KEY), sem bloquear o mouse/teclado físicos do Servidor!
"""
import base64
import fcntl
import hashlib
import json
import math
import os
import select
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time

EVIOCGRAB = 0x40044590
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

EV_SYN, EV_KEY, EV_REL = 0x00, 0x01, 0x02
SYN_REPORT = 0
REL_X, REL_Y, REL_HWHEEL, REL_WHEEL = 0x00, 0x01, 0x06, 0x08

MOUSE_BUTTONS = {0x110: 1, 0x111: 2, 0x112: 3, 0x113: 4, 0x114: 5}
BUTTON_TO_EVDEV = {v: k for k, v in MOUSE_BUTTONS.items()}
KEY_SCROLLLOCK = 70
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
    """Sincroniza texto e imagens da área de transferência do Linux com fallback: GTK3 -> wl-clipboard -> xclip."""

    def __init__(self):
        self.backend = None
        self.last_text = ""
        self.last_img_hash = ""
        self.cb = None
        self.GLib = None

        # 1. Tenta GTK3 (GDK X11/XWayland)
        try:
            os.environ["GDK_BACKEND"] = "x11"
            import gi
            gi.require_version("Gtk", "3.0")
            from gi.repository import Gtk, Gdk, GLib

            self.Gtk = Gtk
            self.Gdk = Gdk
            self.GLib = GLib
            self.cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            self.backend = "gtk"
            GLib.timeout_add(400, self._poll_gtk)
            t = threading.Thread(target=Gtk.main, daemon=True)
            t.start()
            log("Clipboard backend ativo: GTK3")
        except Exception as e:
            log("Clipboard GTK3 indisponível: %s. Tentando ferramentas CLI..." % e)

        # 2. Se GTK3 falhar, tenta wl-clipboard (Wayland nativo)
        if not self.backend and shutil.which("wl-paste") and shutil.which("wl-copy"):
            self.backend = "wayland"
            log("Clipboard backend ativo: wl-clipboard (Wayland)")
            t = threading.Thread(target=self._poll_cli_loop, daemon=True)
            t.start()

        # 3. Se wl-clipboard falhar, tenta xclip (X11)
        if not self.backend and shutil.which("xclip"):
            self.backend = "x11"
            log("Clipboard backend ativo: xclip (X11)")
            t = threading.Thread(target=self._poll_cli_loop, daemon=True)
            t.start()

        if not self.backend:
            log("Nenhum backend de clipboard disponível. Instale wl-clipboard, xclip ou python3-gi.")

    def _poll_gtk(self):
        try:
            self.cb.request_text(self._on_gtk_text)
            self.cb.request_image(self._on_gtk_image)
        except Exception:
            pass
        return True

    def _on_gtk_text(self, _clipboard, text):
        if text and text != self.last_text:
            self.last_text = text
            send({"type": "clipboard", "format": "text", "text": text})

    def _on_gtk_image(self, _clipboard, pixbuf):
        if not pixbuf:
            return
        try:
            success, png_bytes = pixbuf.save_to_bufferv("png", [], [])
            if success and png_bytes:
                h = hashlib.md5(png_bytes).hexdigest()
                if h != self.last_img_hash:
                    self.last_img_hash = h
                    b64 = base64.b64encode(png_bytes).decode("ascii")
                    send({"type": "clipboard", "format": "image", "image": b64})
        except Exception:
            pass

    def _poll_cli_loop(self):
        while True:
            time.sleep(0.5)
            self._check_cli_clipboard()

    def _check_cli_clipboard(self):
        try:
            # Checa texto
            cmd_text = ["wl-paste", "-n"] if self.backend == "wayland" else ["xclip", "-selection", "clipboard", "-o"]
            res = subprocess.run(cmd_text, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1)
            if res.returncode == 0 and res.stdout:
                text = res.stdout.decode("utf-8", errors="replace")
                if text and text != self.last_text:
                    self.last_text = text
                    send({"type": "clipboard", "format": "text", "text": text})
                    return

            # Checa imagem se texto não mudou
            cmd_img = ["wl-paste", "-t", "image/png"] if self.backend == "wayland" else ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]
            res_img = subprocess.run(cmd_img, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1)
            if res_img.returncode == 0 and res_img.stdout:
                img_data = res_img.stdout
                h = hashlib.md5(img_data).hexdigest()
                if h != self.last_img_hash:
                    self.last_img_hash = h
                    b64 = base64.b64encode(img_data).decode("ascii")
                    send({"type": "clipboard", "format": "image", "image": b64})
        except Exception:
            pass

    def read_and_send(self):
        if self.backend == "gtk":
            def _req():
                self.cb.request_text(self._on_gtk_text)
                self.cb.request_image(self._on_gtk_image)
                return False
            self.GLib.idle_add(_req)
        elif self.backend in ("wayland", "x11"):
            self._check_cli_clipboard()

    def write(self, text=None, image=None, format=None):
        if image:
            self._write_image(image)
        elif text:
            self._write_text(text)

    def _write_text(self, text):
        if not text:
            return
        self.last_text = text
        if self.backend == "gtk":
            def _set():
                self.cb.set_text(text, -1)
                self.cb.store()
                return False
            self.GLib.idle_add(_set)
        elif self.backend == "wayland":
            try:
                p = subprocess.Popen(["wl-copy"], stdin=subprocess.PIPE)
                p.communicate(text.encode("utf-8"), timeout=2)
            except Exception as e:
                log("Erro wl-copy: %s" % e)
        elif self.backend == "x11":
            try:
                p = subprocess.Popen(["xclip", "-selection", "clipboard"], stdin=subprocess.PIPE)
                p.communicate(text.encode("utf-8"), timeout=2)
            except Exception as e:
                log("Erro xclip: %s" % e)

    def _write_image(self, b64_png):
        if not b64_png:
            return
        try:
            png_bytes = base64.b64decode(b64_png)
            self.last_img_hash = hashlib.md5(png_bytes).hexdigest()
            if self.backend == "gtk":
                from gi.repository import GdkPixbuf
                loader = GdkPixbuf.PixbufLoader.new_with_type("png")
                loader.write(png_bytes)
                loader.close()
                pixbuf = loader.get_pixbuf()
                def _set():
                    self.cb.set_image(pixbuf)
                    self.cb.store()
                    return False
                self.GLib.idle_add(_set)
            elif self.backend == "wayland":
                p = subprocess.Popen(["wl-copy", "-t", "image/png"], stdin=subprocess.PIPE)
                p.communicate(png_bytes, timeout=2)
            elif self.backend == "x11":
                p = subprocess.Popen(["xclip", "-selection", "clipboard", "-t", "image/png"], stdin=subprocess.PIPE)
                p.communicate(png_bytes, timeout=2)
        except Exception as e:
            log("Erro ao salvar imagem no clipboard: %s" % e)


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


class VirtualInput:
    """Mouse relativo (REL_X, REL_Y) + botões + roda + teclado virtual via /dev/uinput no Servidor Linux."""

    def __init__(self):
        zeros = [0] * 64
        # Mouse relativo virtual (funciona nativamente no GNOME Wayland e X11)
        self.mouse_fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        for t in (EV_SYN, EV_KEY, EV_REL):
            fcntl.ioctl(self.mouse_fd, UI_SET_EVBIT, t)
        for code in MOUSE_BUTTONS:
            fcntl.ioctl(self.mouse_fd, UI_SET_KEYBIT, code)
        for code in (REL_X, REL_Y, REL_WHEEL, REL_HWHEEL):
            fcntl.ioctl(self.mouse_fd, UI_SET_RELBIT, code)

        m_name = (VIRTUAL_PREFIX + " Mouse").encode()
        os.write(
            self.mouse_fd,
            struct.pack("80sHHHHI64i64i64i64i", m_name, 0x03, 0x1234, 0x5679, 1, 0, *zeros, *zeros, *zeros, *zeros),
        )
        fcntl.ioctl(self.mouse_fd, UI_DEV_CREATE)

        # Teclado virtual
        self.kbd_fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(self.kbd_fd, UI_SET_EVBIT, EV_SYN)
        fcntl.ioctl(self.kbd_fd, UI_SET_EVBIT, EV_KEY)
        for k in range(1, 249):
            fcntl.ioctl(self.kbd_fd, UI_SET_KEYBIT, k)
        k_name = (VIRTUAL_PREFIX + " Keyboard").encode()
        os.write(
            self.kbd_fd,
            struct.pack("80sHHHHI64i64i64i64i", k_name, 0x03, 0x1234, 0x567A, 1, 0, *zeros, *zeros, *zeros, *zeros),
        )
        fcntl.ioctl(self.kbd_fd, UI_DEV_CREATE)

        self.pressed_buttons = set()
        self.pressed_keys = set()

    def _write(self, fd, *events):
        os.write(fd, b"".join(events) + ev(EV_SYN, SYN_REPORT, 0))

    def move_rel(self, dx, dy):
        evts = []
        if dx:
            evts.append(ev(EV_REL, REL_X, dx))
        if dy:
            evts.append(ev(EV_REL, REL_Y, dy))
        if evts:
            self._write(self.mouse_fd, *evts)

    def button(self, button_num, down):
        code = BUTTON_TO_EVDEV.get(int(button_num))
        if not code:
            return
        self._write(self.mouse_fd, ev(EV_KEY, code, 1 if down else 0))
        if down:
            self.pressed_buttons.add(code)
        else:
            self.pressed_buttons.discard(code)

    def wheel(self, dy, dx):
        if dy:
            self._write(self.mouse_fd, ev(EV_REL, REL_WHEEL, dy))
        if dx:
            self._write(self.mouse_fd, ev(EV_REL, REL_HWHEEL, dx))

    def key(self, code, down):
        c = int(code)
        if 1 <= c <= 248:
            self._write(self.kbd_fd, ev(EV_KEY, c, 1 if down else 0))
            if down:
                self.pressed_keys.add(c)
            else:
                self.pressed_keys.discard(c)

    def release_all(self):
        for code in list(self.pressed_buttons):
            self._write(self.mouse_fd, ev(EV_KEY, code, 0))
        for code in list(self.pressed_keys):
            self._write(self.kbd_fd, ev(EV_KEY, code, 0))
        self.pressed_buttons.clear()
        self.pressed_keys.clear()

    def close(self):
        self.release_all()
        for f in (self.mouse_fd, self.kbd_fd):
            try:
                fcntl.ioctl(f, UI_DEV_DESTROY)
            except OSError:
                pass
            try:
                os.close(f)
            except OSError:
                pass


class Capture:
    def __init__(self, cfg):
        self.width = int(cfg.get("width", 1920))
        self.height = int(cfg.get("height", 1080))
        self.edge = cfg.get("edge", "right")
        self.speed = float(cfg.get("speed", 1.0))
        self.accel = float(cfg.get("accel", 1.0))

        self.remote = False  # True quando mouse/teclado do Servidor controla o Cliente
        self.client_controlling = False  # True quando mouse/teclado do Cliente está na tela do Servidor
        self.edge_notified = False
        self.last_crossed_edge = None
        self.x = self.width // 2
        self.y = self.height // 2
        self.frac_x = 0.0
        self.frac_y = 0.0
        self.cooldown_until = 0.0
        self.last_pos_sent = 0.0

        self.vinput = None
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
            self.vinput = VirtualInput()
            time.sleep(0.2)
        except OSError as e:
            log("Aviso: uinput indisponível (%s)" % e)
            self.vinput = None

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
        if self.vinput:
            self.vinput.close()
            self.vinput = None

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
                self.set_remote(bool(msg.get("on")), msg.get("yRatio"), msg.get("edge"))
            elif cmd == "client_enter":
                self.on_client_enter(msg.get("yRatio", 0.5), msg.get("edge"))
            elif cmd == "client_leave":
                self.on_client_leave()
            elif cmd == "inject_move":
                self.on_inject_move(int(msg.get("dx", 0)), int(msg.get("dy", 0)))
            elif cmd == "inject_button":
                if self.client_controlling and self.vinput:
                    self.vinput.button(int(msg.get("button", 1)), bool(msg.get("down")))
            elif cmd == "inject_wheel":
                if self.client_controlling and self.vinput:
                    self.vinput.wheel(int(msg.get("dy", 0)), int(msg.get("dx", 0)))
            elif cmd == "inject_key":
                if self.client_controlling and self.vinput:
                    self.vinput.key(int(msg.get("code", 0)), bool(msg.get("down")))
            elif cmd == "clipboard":
                self.clipboard.write(text=msg.get("text"), image=msg.get("image") or msg.get("data"))
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
                send({"type": "pos", "x": self.x, "y": self.y})
        return True

    def on_client_enter(self, ratio, edge=None):
        self.client_controlling = True
        self.cooldown_until = time.monotonic() + 0.35
        r = min(max(float(ratio if ratio is not None else 0.5), 0.0), 1.0)
        offset = 50
        target_edge = edge if edge else self.edge
        if target_edge == "right":
            self.x = max(0, self.width - offset)
            self.y = int(r * (self.height - 1))
        elif target_edge == "left":
            self.x = min(self.width - 1, offset)
            self.y = int(r * (self.height - 1))
        elif target_edge == "top":
            self.x = int(r * (self.width - 1))
            self.y = min(self.height - 1, offset)
        else:
            self.x = int(r * (self.width - 1))
            self.y = max(0, self.height - offset)

        send({"type": "pos", "x": self.x, "y": self.y})

    def on_client_leave(self):
        self.client_controlling = False
        if self.vinput:
            self.vinput.release_all()

    def on_inject_move(self, dx, dy):
        if not self.client_controlling:
            return
        if self.vinput:
            self.vinput.move_rel(dx, dy)

        nx = self.x + dx
        ny = self.y + dy
        now = time.monotonic()

        if now >= self.cooldown_until:
            hit = False
            ratio = 0.5
            if self.edge == "right" and nx >= self.width - 1 and dx > 0:
                hit = True
                ratio = min(max(ny, 0), self.height - 1) / float(max(1, self.height - 1))
            elif self.edge == "left" and nx <= 0 and dx < 0:
                hit = True
                ratio = min(max(ny, 0), self.height - 1) / float(max(1, self.height - 1))
            elif self.edge == "top" and ny <= 0 and dy < 0:
                hit = True
                ratio = min(max(nx, 0), self.width - 1) / float(max(1, self.width - 1))
            elif self.edge == "bottom" and ny >= self.height - 1 and dy > 0:
                hit = True
                ratio = min(max(nx, 0), self.width - 1) / float(max(1, self.width - 1))

            if hit:
                self.client_controlling = False
                if self.vinput:
                    self.vinput.release_all()
                self.cooldown_until = now + 0.35
                send({"type": "client_return", "yRatio": round(ratio, 4)})
                return

        self.x = min(max(nx, 0), self.width - 1)
        self.y = min(max(ny, 0), self.height - 1)

        if now - self.last_pos_sent >= 0.033:
            self.last_pos_sent = now
            send({"type": "pos", "x": self.x, "y": self.y})

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
            if c in MODIFIER_KEYS and v == 2:
                continue
            if v in (0, 1, 2):
                send({"type": "key", "code": c, "down": v != 0})

    def on_motion(self, dx, dy):
        # Quando o Servidor está controlando o Cliente, envia deltas ao Cliente
        if self.remote:
            send({"type": "move", "dx": dx, "dy": dy})
            return

        # O mouse físico do Servidor SEMPRE funciona no Servidor!
        # Se o Cliente estava controlando o Servidor e você moveu o mouse físico do Servidor:
        if self.client_controlling and (abs(dx) + abs(dy) > 8):
            self.on_client_leave()
            send({"type": "client_return", "yRatio": 0.5})

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

        crossed_edge = None
        ratio = 0.5
        if now >= self.cooldown_until:
            if nx >= self.width - 1 and mx > 0:
                crossed_edge = "right"
                ratio = min(max(ny, 0), self.height - 1) / float(max(1, self.height - 1))
            elif nx <= 0 and mx < 0:
                crossed_edge = "left"
                ratio = min(max(ny, 0), self.height - 1) / float(max(1, self.height - 1))
            elif ny <= 0 and my < 0:
                crossed_edge = "top"
                ratio = min(max(nx, 0), self.width - 1) / float(max(1, self.width - 1))
            elif ny >= self.height - 1 and my > 0:
                crossed_edge = "bottom"
                ratio = min(max(nx, 0), self.width - 1) / float(max(1, self.width - 1))

        self.x = min(max(nx, 0), self.width - 1)
        self.y = min(max(ny, 0), self.height - 1)

        if now - self.last_pos_sent >= 0.033:
            self.last_pos_sent = now
            send({"type": "pos", "x": self.x, "y": self.y})

        if crossed_edge:
            if not self.edge_notified or self.last_crossed_edge != crossed_edge:
                self.edge_notified = True
                self.last_crossed_edge = crossed_edge
                send({"type": "edge", "edge": crossed_edge, "yRatio": round(ratio, 4)})
        else:
            margin = 20
            if (self.x > margin and self.x < self.width - margin and
                self.y > margin and self.y < self.height - margin):
                self.edge_notified = False
                self.last_crossed_edge = None

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
        elif self.client_controlling:
            self.on_client_leave()
            send({"type": "client_return", "yRatio": 0.5})

    def set_remote(self, on, ratio, edge=None):
        if on == self.remote:
            return
        if on:
            self.client_controlling = False
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
            self.cooldown_until = time.monotonic() + 0.35
            r = float(ratio) if ratio is not None else 0.5
            r = min(max(r, 0.0), 1.0)
            offset = 50
            target_edge = edge if edge else self.edge
            if target_edge == "right":
                self.x = max(0, self.width - offset)
                self.y = int(r * (self.height - 1))
            elif target_edge == "left":
                self.x = min(self.width - 1, offset)
                self.y = int(r * (self.height - 1))
            elif target_edge == "top":
                self.x = int(r * (self.width - 1))
                self.y = min(self.height - 1, offset)
            elif target_edge == "bottom":
                self.x = int(r * (self.width - 1))
                self.y = max(0, self.height - offset)

            self.frac_x = self.frac_y = 0.0
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
