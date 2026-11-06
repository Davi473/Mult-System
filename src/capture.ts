import { ChildProcess, spawn, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { Edge, InputPacket, LineReader } from './protocol';
import { SCRIPTS_DIR, detectLinuxScreen, ensureLinuxDeviceAccess } from './platform';

export interface EdgeEvent {
  edge: Edge;
  yRatio: number;
}

export interface ClipboardData {
  text?: string;
  image?: string;
  format?: 'text' | 'image';
}

export interface Capture extends EventEmitter {
  start(): Promise<{ width: number; height: number }>;
  setRemote(on: boolean, yRatio?: number, edge?: Edge): void;
  clientEnter(yRatio: number, edge?: Edge): void;
  clientLeave(): void;
  injectFromClient(packet: InputPacket): void;
  setClipboard(data: ClipboardData | string): void;
  updateConfig(cfg: Partial<CaptureOptions>): void;
  centerCursor(): void;
  stop(): void;
}

export interface CaptureOptions {
  edge: Edge;
  speed: number;
  accel: number;
}

export function createCapture(options: CaptureOptions): Capture {
  return process.platform === 'linux' ? new LinuxCapture(options) : new GenericCapture(options);
}

class LinuxCapture extends EventEmitter implements Capture {
  private proc: ChildProcess | null = null;
  private readonly script = path.join(SCRIPTS_DIR, 'linux_capture.py');

  constructor(private options: CaptureOptions) {
    super();
  }

  async start(): Promise<{ width: number; height: number }> {
    const list = spawnSync('python3', [this.script, '--list'], { encoding: 'utf8' });
    if (list.error || list.status !== 0) {
      throw new Error(`Falha ao executar python3 (${list.error?.message ?? list.stderr}). Instale o python3.`);
    }
    const devices = JSON.parse(list.stdout) as { mice: string[]; keyboards: string[] };
    ensureLinuxDeviceAccess([...devices.mice, ...devices.keyboards, '/dev/uinput']);

    const { width, height } = detectLinuxScreen();
    const config = JSON.stringify({ width, height, ...this.options });

    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const proc = spawn('python3', [this.script, config], { stdio: ['pipe', 'pipe', 'inherit'] });
      this.proc = proc;
      let ready = false;

      const reader = new LineReader((line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'ready':
            ready = true;
            console.log(`[Captura] Tela ${msg.width}x${msg.height}`);
            console.log(`[Captura] Mouses: ${msg.mice.join(', ')}`);
            console.log(`[Captura] Teclados: ${msg.keyboards.join(', ')}`);
            resolve({ width: Number(msg.width), height: Number(msg.height) });
            break;
          case 'edge':
            this.emit('edge', {
              edge: (msg.edge as Edge) || this.options.edge,
              yRatio: Number(msg.yRatio ?? 0.5),
            });
            break;
          case 'client_return':
            this.emit('client_return', Number(msg.yRatio));
            break;
          case 'pos':
            this.emit('pos', { x: Number(msg.x), y: Number(msg.y) });
            break;
          case 'clipboard':
            this.emit('clipboard', {
              text: msg.text,
              image: msg.image,
              format: msg.format || (msg.image ? 'image' : 'text'),
            });
            break;
          case 'emergency':
            this.emit('emergency');
            break;
          case 'move':
          case 'button':
          case 'wheel':
          case 'key':
            this.emit('input', msg as InputPacket);
            break;
        }
      });

      proc.stdout!.on('data', (chunk) => reader.push(chunk));
      proc.on('error', (err) => {
        if (!ready) reject(err);
      });
      proc.on('exit', (code) => {
        this.proc = null;
        if (!ready) reject(new Error(`linux_capture.py encerrou com código ${code}`));
        else this.emit('exit', code);
      });
    });
  }

  setRemote(on: boolean, yRatio?: number, edge?: Edge): void {
    this.proc?.stdin?.write(JSON.stringify({ cmd: 'remote', on, yRatio, edge }) + '\n');
  }

  clientEnter(yRatio: number, edge?: Edge): void {
    this.proc?.stdin?.write(JSON.stringify({ cmd: 'client_enter', yRatio, edge }) + '\n');
  }

  clientLeave(): void {
    this.proc?.stdin?.write(JSON.stringify({ cmd: 'client_leave' }) + '\n');
  }

  injectFromClient(packet: InputPacket): void {
    if (packet.type === 'move') {
      this.proc?.stdin?.write(JSON.stringify({ cmd: 'inject_move', dx: packet.dx, dy: packet.dy }) + '\n');
    } else if (packet.type === 'button') {
      this.proc?.stdin?.write(
        JSON.stringify({ cmd: 'inject_button', button: packet.button, down: packet.down }) + '\n'
      );
    } else if (packet.type === 'wheel') {
      this.proc?.stdin?.write(JSON.stringify({ cmd: 'inject_wheel', dy: packet.dy, dx: packet.dx }) + '\n');
    } else if (packet.type === 'key') {
      this.proc?.stdin?.write(JSON.stringify({ cmd: 'inject_key', code: packet.code, down: packet.down }) + '\n');
    }
  }

  setClipboard(data: ClipboardData | string): void {
    if (!data) return;
    const payload = typeof data === 'string' ? { text: data } : data;
    this.proc?.stdin?.write(JSON.stringify({ cmd: 'clipboard', ...payload }) + '\n');
  }

  updateConfig(cfg: Partial<CaptureOptions>): void {
    this.options = { ...this.options, ...cfg };
    this.proc?.stdin?.write(JSON.stringify({ cmd: 'config', ...cfg }) + '\n');
  }

  centerCursor(): void {
    this.proc?.stdin?.write(JSON.stringify({ cmd: 'center' }) + '\n');
  }

  stop(): void {
    this.proc?.kill();
  }
}

function uiohookToEvdev(code: number): number | undefined {
  const extended: Record<number, number> = {
    0x1c: 96, 0x1d: 97, 0x35: 98, 0x37: 99, 0x38: 100, 0x47: 102, 0x48: 103, 0x49: 104,
    0x4b: 105, 0x4d: 106, 0x4f: 107, 0x50: 108, 0x51: 109, 0x52: 110, 0x53: 111,
    0x5b: 125, 0x5c: 126, 0x5d: 127,
  };
  const high = code & 0xff00;
  if (high === 0x0e00 || high === 0xe000) return extended[code & 0xff];
  if (code >= 1 && code <= 88) return code;
  if (code === 0x73) return 89;
  if (code === 0x7e) return 121;
  return undefined;
}

class GenericCapture extends EventEmitter implements Capture {
  private remote = false;
  private warping = false;
  private width = 1920;
  private height = 1080;
  private hook: any;
  private nut: any;

  constructor(private options: CaptureOptions) {
    super();
  }

  async start(): Promise<{ width: number; height: number }> {
    this.nut = require('@nut-tree-fork/nut-js');
    const { uIOhook } = require('uiohook-napi');
    this.hook = uIOhook;
    this.nut.mouse.config.autoDelayMs = 0;
    this.width = await this.nut.screen.width();
    this.height = await this.nut.screen.height();

    uIOhook.on('mousemove', (e: any) => this.onMove(e.x, e.y));
    uIOhook.on('mousedown', (e: any) => this.forward({ type: 'button', button: Number(e.button), down: true }));
    uIOhook.on('mouseup', (e: any) => this.forward({ type: 'button', button: Number(e.button), down: false }));
    uIOhook.on('wheel', (e: any) => {
      const steps = Math.round(e.rotation) || Math.sign(e.rotation);
      if (e.direction === 4) this.forward({ type: 'wheel', dy: 0, dx: steps });
      else this.forward({ type: 'wheel', dy: -steps, dx: 0 });
    });
    const onKey = (down: boolean) => (e: any) => {
      if (e.keycode === 70 && down && this.remote) {
        this.setRemote(false, 0.5);
        this.emit('emergency');
        return;
      }
      const code = uiohookToEvdev(e.keycode);
      if (code !== undefined) this.forward({ type: 'key', code, down });
    };
    uIOhook.on('keydown', onKey(true));
    uIOhook.on('keyup', onKey(false));
    uIOhook.start();
    return { width: this.width, height: this.height };
  }

  private forward(packet: InputPacket) {
    if (this.remote) this.emit('input', packet);
  }

  private async warp(x: number, y: number) {
    this.warping = true;
    try {
      await this.nut.mouse.setPosition(new this.nut.Point(x, y));
    } finally {
      this.warping = false;
    }
  }

  private onMove(x: number, y: number) {
    if (this.warping) return;
    const cx = Math.floor(this.width / 2);
    const cy = Math.floor(this.height / 2);
    if (!this.remote) {
      this.emit('pos', { x, y });
      let hitEdge: Edge | null = null;
      let ratio = 0.5;
      if (x >= this.width - 1) {
        hitEdge = 'right';
        ratio = y / (this.height - 1);
      } else if (x <= 0) {
        hitEdge = 'left';
        ratio = y / (this.height - 1);
      } else if (y <= 0) {
        hitEdge = 'top';
        ratio = x / (this.width - 1);
      } else if (y >= this.height - 1) {
        hitEdge = 'bottom';
        ratio = x / (this.width - 1);
      }
      if (hitEdge) {
        this.emit('edge', { edge: hitEdge, yRatio: ratio });
      }
      return;
    }
    const dx = x - cx;
    const dy = y - cy;
    if (dx === 0 && dy === 0) return;
    this.emit('input', { type: 'move', dx, dy });
    void this.warp(cx, cy);
  }

  setRemote(on: boolean, yRatio = 0.5, edge?: Edge): void {
    this.remote = on;
    if (on) {
      void this.warp(Math.floor(this.width / 2), Math.floor(this.height / 2));
    } else {
      const e = edge || this.options.edge;
      const x = e === 'right' ? this.width - 40 : e === 'left' ? 40 : Math.round(yRatio * (this.width - 1));
      const y = e === 'bottom' ? this.height - 40 : e === 'top' ? 40 : Math.round(yRatio * (this.height - 1));
      void this.warp(x, y);
    }
  }

  updateConfig(cfg: Partial<CaptureOptions>): void {
    this.options = { ...this.options, ...cfg };
  }

  setClipboard(_data: ClipboardData | string): void {
    // no-op on generic fallback
  }

  clientEnter(_yRatio: number, _edge?: Edge): void {}
  clientLeave(): void {}
  injectFromClient(_packet: InputPacket): void {}

  centerCursor(): void {
    void this.warp(Math.floor(this.width / 2), Math.floor(this.height / 2));
  }

  stop(): void {
    this.hook?.stop();
  }
}
