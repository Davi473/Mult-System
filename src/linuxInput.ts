import { spawn, spawnSync, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import { EventEmitter } from 'events';

/**
 * Descobre os arquivos /dev/input/eventX de mouses e teclados físicos no Linux
 */
export function findLinuxInputDevices(): string[] {
  if (!fs.existsSync('/proc/bus/input/devices')) return [];
  const content = fs.readFileSync('/proc/bus/input/devices', 'utf-8');
  const blocks = content.split('\n\n');
  const devices: string[] = [];

  for (const block of blocks) {
    if (block.includes('Mult-System Virtual')) continue;
    const handlersMatch = block.match(/H:\s+Handlers=([^\n]+)/);
    const evMatch = block.match(/B:\s+EV=([0-9a-fA-F]+)/);
    if (!handlersMatch || !evMatch) continue;

    const handlers = handlersMatch[1];
    const eventMatch = handlers.match(/event\d+/);
    if (!eventMatch) continue;

    const evBits = parseInt(evMatch[1], 16);
    // EV_KEY (0x02) + EV_REL (0x04) para mouse, ou kbd no handler para teclado
    const isMouse = handlers.includes('mouse') && (evBits & 0x04) !== 0;
    const isKeyboard = handlers.includes('kbd') && (evBits & 0x120013) === 0x120013;

    if (isMouse || isKeyboard) {
      devices.push(`/dev/input/${eventMatch[0]}`);
    }
  }
  return Array.from(new Set(devices));
}

/**
 * Garante que o usuário atual tenha permissão de leitura/escrita nos dispositivos /dev/input/event*
 * e em /dev/uinput (necessário no Wayland/Linux para capturar e injetar eventos globais).
 */
export function ensureLinuxInputPermissions(devices: string[]): void {
  const targets = [...devices];
  if (fs.existsSync('/dev/uinput')) {
    targets.push('/dev/uinput');
  }

  const needsPermission = targets.filter((dev) => {
    try {
      fs.accessSync(dev, fs.constants.R_OK | fs.constants.W_OK);
      return false;
    } catch {
      return true;
    }
  });

  if (needsPermission.length > 0) {
    const username = os.userInfo().username;
    console.log(
      `[Linux Wayland/X11] Solicitando permissão de acesso aos dispositivos de entrada (${needsPermission.join(', ')})...`
    );
    const res = spawnSync('sudo', ['setfacl', '-m', `u:${username}:rw`, ...needsPermission], {
      stdio: 'inherit',
    });
    if (res.status !== 0) {
      console.error(
        '[Linux] Falha ao aplicar setfacl. Execute com: sudo npm run start:server'
      );
    }
  }
}

/**
 * Captura global de Mouse e Teclado via Linux evdev (/dev/input/event*) + EVIOCGRAB.
 * Funciona nativamente tanto em Wayland quanto em X11!
 */
export class LinuxEvdevServer extends EventEmitter {
  private pyProc: ChildProcess | null = null;

  constructor(
    private screenWidth: number,
    private screenHeight: number,
    private clientEdge: 'right' | 'left'
  ) {
    super();
  }

  start(): boolean {
    const devices = findLinuxInputDevices();
    if (devices.length === 0) {
      console.error('[LinuxEvdev] Nenhum mouse/teclado encontrado em /proc/bus/input/devices');
      return false;
    }

    ensureLinuxInputPermissions(devices);
    console.log(`[LinuxEvdev] Monitorando dispositivos físicos: ${devices.join(', ')}`);

    const pyScript = `
import sys, os, struct, select, fcntl, json, time

devices = json.loads(sys.argv[1])
width = int(sys.argv[2])
height = int(sys.argv[3])
edge = sys.argv[4]

EVIOCGRAB = 0x40044590
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_ABSBIT = 0x40045567
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

EV_SYN = 0x00
EV_KEY = 0x01
EV_REL = 0x02
EV_ABS = 0x03

REL_X = 0x00
REL_Y = 0x01
REL_WHEEL = 0x08
ABS_X = 0x00
ABS_Y = 0x01

BTN_LEFT = 0x110
BTN_RIGHT = 0x111
BTN_MIDDLE = 0x112

# Cria ponteiro absoluto virtual via uinput para reposicionar o cursor local no retorno
uinput_fd = None
try:
    uinput_fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    fcntl.ioctl(uinput_fd, UI_SET_EVBIT, EV_SYN)
    fcntl.ioctl(uinput_fd, UI_SET_EVBIT, EV_KEY)
    fcntl.ioctl(uinput_fd, UI_SET_EVBIT, EV_ABS)
    fcntl.ioctl(uinput_fd, UI_SET_KEYBIT, BTN_LEFT)
    fcntl.ioctl(uinput_fd, UI_SET_KEYBIT, BTN_RIGHT)
    fcntl.ioctl(uinput_fd, UI_SET_KEYBIT, BTN_MIDDLE)
    fcntl.ioctl(uinput_fd, UI_SET_ABSBIT, ABS_X)
    fcntl.ioctl(uinput_fd, UI_SET_ABSBIT, ABS_Y)
    name = b"Mult-System Virtual Server Pointer"
    absmax = [0]*64
    absmin = [0]*64
    absfuzz = [0]*64
    absflat = [0]*64
    absmax[ABS_X] = width - 1
    absmax[ABS_Y] = height - 1
    udev = struct.pack("80sHHHHI64i64i64i64i", name, 0x03, 0x1234, 0x5679, 1, 0, *(absmax + absmin + absfuzz + absflat))
    os.write(uinput_fd, udev)
    fcntl.ioctl(uinput_fd, UI_DEV_CREATE)
except Exception as e:
    uinput_fd = None

def warp_local(x, y):
    if uinput_fd is None:
        return
    try:
        os.write(uinput_fd, struct.pack("llHHi", 0, 0, EV_ABS, ABS_X, int(x)))
        os.write(uinput_fd, struct.pack("llHHi", 0, 0, EV_ABS, ABS_Y, int(y)))
        os.write(uinput_fd, struct.pack("llHHi", 0, 0, EV_SYN, 0, 0))
    except Exception:
        pass

fds = []
for path in devices:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        fds.append(fd)
    except Exception as e:
        sys.stderr.write(f"Erro ao abrir {path}: {e}\\n")

grabbed = False
cur_x = width // 2
cur_y = height // 2

def set_grab(state):
    global grabbed
    if grabbed == state:
        return
    grabbed = state
    for fd in fds:
        try:
            fcntl.ioctl(fd, EVIOCGRAB, 1 if state else 0)
        except Exception:
            pass

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

EVENT_SIZE = struct.calcsize("llHHi")
stdin_fd = sys.stdin.fileno()
os.set_blocking(stdin_fd, False)
stdin_buf = ""

while True:
    rlist, _, _ = select.select(fds + [stdin_fd], [], [])
    for fd in rlist:
        if fd == stdin_fd:
            try:
                chunk = os.read(stdin_fd, 1024).decode("utf-8", errors="ignore")
                if not chunk:
                    set_grab(False)
                    sys.exit(0)
                stdin_buf += chunk
                lines = stdin_buf.split("\\n")
                stdin_buf = lines.pop()
                for line in lines:
                    msg = json.loads(line)
                    if msg.get("cmd") == "grab":
                        set_grab(True)
                    elif msg.get("cmd") == "ungrab":
                        set_grab(False)
                        cur_x = int(msg.get("x", width // 2))
                        cur_y = int(msg.get("y", height // 2))
                        warp_local(cur_x, cur_y)
            except Exception:
                pass
            continue

        try:
            data = os.read(fd, EVENT_SIZE * 32)
        except OSError:
            continue

        dx_acc = 0
        dy_acc = 0
        for i in range(0, len(data), EVENT_SIZE):
            chunk = data[i:i+EVENT_SIZE]
            if len(chunk) < EVENT_SIZE:
                break
            _, _, ev_type, code, value = struct.unpack("llHHi", chunk)

            if ev_type == EV_REL:
                if code == REL_X:
                    dx_acc += value
                elif code == REL_Y:
                    dy_acc += value
                elif code == REL_WHEEL and grabbed:
                    send({"type": "wheel", "amount": abs(value), "direction": -1 if value > 0 else 1})

            elif ev_type == EV_KEY:
                # Tecla de emergência ScrollLock (70) libera o grab imediatamente
                if code == 70 and value == 1 and grabbed:
                    set_grab(False)
                    send({"type": "emergency_release"})
                    continue

                if not grabbed:
                    continue

                if code in (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE):
                    btn = 1 if code == BTN_LEFT else (2 if code == BTN_RIGHT else 3)
                    if value == 1:
                        send({"type": "mousedown", "button": btn})
                    elif value == 0:
                        send({"type": "mouseup", "button": btn})
                else:
                    if value == 1:
                        send({"type": "keydown", "keycode": code})
                    elif value == 0:
                        send({"type": "keyup", "keycode": code})

        if dx_acc != 0 or dy_acc != 0:
            if not grabbed:
                cur_x = max(0, min(width - 1, cur_x + dx_acc))
                cur_y = max(0, min(height - 1, cur_y + dy_acc))
                if (edge == "right" and cur_x >= width - 1) or (edge == "left" and cur_x <= 0):
                    send({"type": "edge_hit", "yRatio": cur_y / float(height)})
            else:
                send({"type": "mousemove", "dx": dx_acc, "dy": dy_acc})
`;

    this.pyProc = spawn(
      'python3',
      ['-c', pyScript, JSON.stringify(devices), String(this.screenWidth), String(this.screenHeight), this.clientEdge],
      { stdio: ['pipe', 'pipe', 'inherit'] }
    );

    let buffer = '';
    this.pyProc.stdout?.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          this.emit('event', evt);
        } catch {
          // ignore
        }
      }
    });

    return true;
  }

  grab(): void {
    this.pyProc?.stdin?.write(JSON.stringify({ cmd: 'grab' }) + '\n');
  }

  ungrab(x: number, y: number): void {
    this.pyProc?.stdin?.write(JSON.stringify({ cmd: 'ungrab', x, y }) + '\n');
  }
}

/**
 * Injeção de Mouse e Teclado via Linux /dev/uinput (funciona em Wayland e X11 sem root!)
 */
export class LinuxUinputClient {
  private pyProc: ChildProcess | null = null;

  constructor(private screenWidth: number, private screenHeight: number) {}

  start(): boolean {
    if (!fs.existsSync('/dev/uinput')) return false;
    ensureLinuxInputPermissions([]);

    const pyScript = `
import sys, os, struct, fcntl, json

width = int(sys.argv[1])
height = int(sys.argv[2])

UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_SET_ABSBIT = 0x40045567
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

EV_SYN = 0x00
EV_KEY = 0x01
EV_REL = 0x02
EV_ABS = 0x03

REL_WHEEL = 0x08
ABS_X = 0x00
ABS_Y = 0x01

BTN_LEFT = 0x110
BTN_RIGHT = 0x111
BTN_MIDDLE = 0x112

fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
fcntl.ioctl(fd, UI_SET_EVBIT, EV_SYN)
fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
fcntl.ioctl(fd, UI_SET_EVBIT, EV_REL)
fcntl.ioctl(fd, UI_SET_EVBIT, EV_ABS)

fcntl.ioctl(fd, UI_SET_RELBIT, REL_WHEEL)
fcntl.ioctl(fd, UI_SET_ABSBIT, ABS_X)
fcntl.ioctl(fd, UI_SET_ABSBIT, ABS_Y)

for k in range(1, 249):
    fcntl.ioctl(fd, UI_SET_KEYBIT, k)
fcntl.ioctl(fd, UI_SET_KEYBIT, BTN_LEFT)
fcntl.ioctl(fd, UI_SET_KEYBIT, BTN_RIGHT)
fcntl.ioctl(fd, UI_SET_KEYBIT, BTN_MIDDLE)

name = b"Mult-System Virtual KVM Client"
absmax = [0]*64
absmin = [0]*64
absfuzz = [0]*64
absflat = [0]*64
absmax[ABS_X] = width - 1
absmax[ABS_Y] = height - 1

udev = struct.pack("80sHHHHI64i64i64i64i", name, 0x03, 0x1234, 0x5678, 1, 0, *(absmax + absmin + absfuzz + absflat))
os.write(fd, udev)
fcntl.ioctl(fd, UI_DEV_CREATE)

def emit(t, c, v):
    os.write(fd, struct.pack("llHHi", 0, 0, t, c, int(v)))

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    t = msg.get("type")
    if t == "move":
        emit(EV_ABS, ABS_X, msg["x"])
        emit(EV_ABS, ABS_Y, msg["y"])
        emit(EV_SYN, 0, 0)
    elif t == "button":
        btn = BTN_LEFT if msg["button"] == 1 else (BTN_RIGHT if msg["button"] == 2 else BTN_MIDDLE)
        emit(EV_KEY, btn, 1 if msg["down"] else 0)
        emit(EV_SYN, 0, 0)
    elif t == "wheel":
        val = -msg["amount"] if msg["direction"] > 0 else msg["amount"]
        emit(EV_REL, REL_WHEEL, val)
        emit(EV_SYN, 0, 0)
    elif t == "key":
        code = int(msg["keycode"])
        if 1 <= code <= 248:
            emit(EV_KEY, code, 1 if msg["down"] else 0)
            emit(EV_SYN, 0, 0)
`;

    this.pyProc = spawn('python3', ['-c', pyScript, String(this.screenWidth), String(this.screenHeight)], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    console.log('[LinuxUinput] Dispositivo virtual de Mouse/Teclado criado via /dev/uinput (Wayland/X11).');
    return true;
  }

  moveTo(x: number, y: number): void {
    this.pyProc?.stdin?.write(JSON.stringify({ type: 'move', x, y }) + '\n');
  }

  mouseButton(button: number, down: boolean): void {
    this.pyProc?.stdin?.write(JSON.stringify({ type: 'button', button, down }) + '\n');
  }

  wheel(amount: number, direction: number): void {
    this.pyProc?.stdin?.write(JSON.stringify({ type: 'wheel', amount, direction }) + '\n');
  }

  key(keycode: number, down: boolean): void {
    this.pyProc?.stdin?.write(JSON.stringify({ type: 'key', keycode, down }) + '\n');
  }
}
