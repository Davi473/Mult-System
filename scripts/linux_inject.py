#!/usr/bin/env python3
"""
Injetor de mouse/teclado do CLIENTE KVM no Linux (Wayland e X11) via /dev/uinput.
Suporta bordas left, right, top, bottom, cooldown anti-ping-pong e telemetria p <x> <y>.
"""
import fcntl
import json
import os
import struct
import sys
import time

UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_SET_ABSBIT = 0x40045567
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0x00, 0x01, 0x02, 0x03
REL_HWHEEL, REL_WHEEL = 0x06, 0x08
ABS_X, ABS_Y = 0x00, 0x01
BUTTONS = {1: 0x110, 2: 0x111, 3: 0x112, 4: 0x113, 5: 0x114}
EVENT_FMT = "llHHi"


def ev(t, c, v):
    return struct.pack(EVENT_FMT, 0, 0, t, c, int(v))


def create_device(name, setup, absmax=None):
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    setup(fd)
    amax = [0] * 64
    if absmax:
        amax[ABS_X], amax[ABS_Y] = absmax
    zeros = [0] * 64
    os.write(
        fd,
        struct.pack("80sHHHHI64i64i64i64i", name.encode(), 0x03, 0x1234, 0x5680, 1, 0, *amax, *zeros, *zeros, *zeros),
    )
    fcntl.ioctl(fd, UI_DEV_CREATE)
    return fd


def main():
    cfg = json.loads(sys.argv[1]) if len(sys.argv[1:]) else {}
    width = int(cfg.get("width", 1920))
    height = int(cfg.get("height", 1080))
    return_edge = cfg.get("edge", "left")

    def setup_keyboard(fd):
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_SYN)
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
        for code in range(1, 249):
            fcntl.ioctl(fd, UI_SET_KEYBIT, code)

    def setup_pointer(fd):
        for t in (EV_SYN, EV_KEY, EV_REL, EV_ABS):
            fcntl.ioctl(fd, UI_SET_EVBIT, t)
        for code in BUTTONS.values():
            fcntl.ioctl(fd, UI_SET_KEYBIT, code)
        for code in (REL_WHEEL, REL_HWHEEL):
            fcntl.ioctl(fd, UI_SET_RELBIT, code)
        for code in (ABS_X, ABS_Y):
            fcntl.ioctl(fd, UI_SET_ABSBIT, code)

    kbd = create_device("Mult-System Virtual Client Keyboard", setup_keyboard)
    ptr = create_device("Mult-System Virtual Client Pointer", setup_pointer, (width - 1, height - 1))

    def write(fd, *events):
        os.write(fd, b"".join(events) + ev(EV_SYN, 0, 0))

    def out(line):
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    active = False
    x, y = width // 2, height // 2
    cooldown_until = 0.0
    last_pos = 0.0
    pressed_keys, pressed_buttons = set(), set()

    def release_all():
        for code in list(pressed_keys):
            write(kbd, ev(EV_KEY, code, 0))
        for code in list(pressed_buttons):
            write(ptr, ev(EV_KEY, code, 0))
        pressed_keys.clear()
        pressed_buttons.clear()

    out("ready %dx%d" % (width, height))
    try:
        for raw in sys.stdin:
            p = raw.split()
            if not p:
                continue
            cmd = p[0]
            if cmd == "c":
                return_edge = p[1].strip().lower()
            elif cmd == "e":
                active = True
                r = min(max(float(p[1]), 0.0), 1.0)
                offset = 40
                if return_edge == "left":
                    x, y = offset, int(r * (height - 1))
                elif return_edge == "right":
                    x, y = width - 1 - offset, int(r * (height - 1))
                elif return_edge == "top":
                    x, y = int(r * (width - 1)), offset
                else:
                    x, y = int(r * (width - 1)), height - 1 - offset
                cooldown_until = time.monotonic() + 0.30
                write(ptr, ev(EV_ABS, ABS_X, x), ev(EV_ABS, ABS_Y, y))
                out("p %d %d" % (x, y))
            elif cmd == "l":
                active = False
                release_all()
            elif not active:
                continue
            elif cmd == "m":
                dx, dy = int(p[1]), int(p[2])
                nx, ny = x + dx, y + dy
                now = time.monotonic()
                if now >= cooldown_until:
                    hit = False
                    ratio = 0.5
                    if return_edge == "left" and nx <= 0 and dx < 0:
                        hit = True
                        ratio = min(max(ny, 0), height - 1) / float(max(1, height - 1))
                    elif return_edge == "right" and nx >= width - 1 and dx > 0:
                        hit = True
                        ratio = min(max(ny, 0), height - 1) / float(max(1, height - 1))
                    elif return_edge == "top" and ny <= 0 and dy < 0:
                        hit = True
                        ratio = min(max(nx, 0), width - 1) / float(max(1, width - 1))
                    elif return_edge == "bottom" and ny >= height - 1 and dy > 0:
                        hit = True
                        ratio = min(max(nx, 0), width - 1) / float(max(1, width - 1))
                    if hit:
                        active = False
                        release_all()
                        out("r %.4f" % ratio)
                        continue
                x = min(max(nx, 0), width - 1)
                y = min(max(ny, 0), height - 1)
                write(ptr, ev(EV_ABS, ABS_X, x), ev(EV_ABS, ABS_Y, y))
                if now - last_pos >= 0.033:
                    last_pos = now
                    out("p %d %d" % (x, y))
            elif cmd == "b":
                code = BUTTONS.get(int(p[1]))
                if code:
                    down = p[2] == "1"
                    write(ptr, ev(EV_KEY, code, 1 if down else 0))
                    (pressed_buttons.add if down else pressed_buttons.discard)(code)
            elif cmd == "w":
                dy, dx = int(p[1]), int(p[2])
                if dy:
                    write(ptr, ev(EV_REL, REL_WHEEL, dy))
                if dx:
                    write(ptr, ev(EV_REL, REL_HWHEEL, dx))
            elif cmd == "k":
                code = int(p[1])
                if 1 <= code <= 248:
                    down = p[2] == "1"
                    write(kbd, ev(EV_KEY, code, 1 if down else 0))
                    (pressed_keys.add if down else pressed_keys.discard)(code)
    except KeyboardInterrupt:
        pass
    finally:
        release_all()
        for fd in (kbd, ptr):
            try:
                fcntl.ioctl(fd, UI_DEV_DESTROY)
            except OSError:
                pass
            os.close(fd)


if __name__ == "__main__":
    main()
