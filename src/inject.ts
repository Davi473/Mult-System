import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { Edge, LineReader } from './protocol';
import { SCRIPTS_DIR, detectLinuxScreen, ensureLinuxDeviceAccess } from './platform';

export class Injector extends EventEmitter {
  private proc: ChildProcess | null = null;
  public screenWidth = 1920;
  public screenHeight = 1080;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    readonly label: string
  ) {
    super();
  }

  start(): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
      this.proc = proc;
      let ready = false;

      const reader = new LineReader(
        (line) => {
          if (line.startsWith('ready')) {
            ready = true;
            const dims = line.slice(6).trim().split('x');
            if (dims.length === 2) {
              this.screenWidth = Number(dims[0]) || 1920;
              this.screenHeight = Number(dims[1]) || 1080;
            }
            console.log(`[Injetor ${this.label}] Pronto (tela ${this.screenWidth}x${this.screenHeight})`);
            resolve({ width: this.screenWidth, height: this.screenHeight });
          } else if (line.startsWith('r ')) {
            this.emit('return', Number(line.slice(2)));
          } else if (line.startsWith('p ')) {
            const parts = line.slice(2).trim().split(' ');
            if (parts.length >= 2) {
              this.emit('pos', { x: Number(parts[0]), y: Number(parts[1]) });
            }
          } else if (line.startsWith('cb ')) {
            try {
              const text = Buffer.from(line.slice(3).trim(), 'base64').toString('utf8');
              if (text) this.emit('clipboard', { type: 'clipboard', format: 'text', text });
            } catch {
              // ignore
            }
          } else if (line.startsWith('cb_img ')) {
            const imgB64 = line.slice(7).trim();
            if (imgB64) this.emit('clipboard', { type: 'clipboard', format: 'image', image: imgB64 });
          } else if (line.startsWith('cs_e ')) {
            this.emit('client_enter', Number(line.slice(5)));
          } else if (line === 'cs_l') {
            this.emit('client_leave');
          } else if (line.startsWith('cs_m ')) {
            const p = line.slice(5).trim().split(' ');
            this.emit('client_input', { type: 'move', dx: Number(p[0]), dy: Number(p[1]) });
          } else if (line.startsWith('cs_b ')) {
            const p = line.slice(5).trim().split(' ');
            this.emit('client_input', { type: 'button', button: Number(p[0]), down: p[1] === '1' });
          } else if (line.startsWith('cs_w ')) {
            const p = line.slice(5).trim().split(' ');
            this.emit('client_input', { type: 'wheel', dy: Number(p[0]), dx: Number(p[1]) });
          } else if (line.startsWith('cs_k ')) {
            const p = line.slice(5).trim().split(' ');
            this.emit('client_input', { type: 'key', code: Number(p[0]), down: p[1] === '1' });
          }
        },
        { maxLineLength: 10 * 1024 * 1024 }
      );

      proc.stdout!.on('data', (chunk) => {
        try {
          reader.push(chunk);
        } catch (err) {
          console.warn(`[Injetor ${this.label}] Aviso no LineReader:`, (err as Error).message);
        }
      });
      proc.on('error', (err) => {
        if (!ready) reject(err);
      });
      proc.on('exit', (code) => {
        this.proc = null;
        if (!ready) reject(new Error(`Injetor ${this.label} encerrou com código ${code}`));
        else this.emit('exit', code);
      });
    });
  }

  private write(line: string) {
    const stdin = this.proc?.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) {
      stdin.write(line + '\n');
    }
  }

  setReturnEdge(edge: Edge) {
    this.write(`c ${edge}`);
  }
  setClipboard(data: { text?: string; image?: string; format?: 'text' | 'image' } | string) {
    if (!data) return;
    if (typeof data === 'string') {
      const b64 = Buffer.from(data, 'utf8').toString('base64');
      this.write(`cb ${b64}`);
    } else if (data.image) {
      this.write(`cb_img ${data.image}`);
    } else if (data.text) {
      const b64 = Buffer.from(data.text, 'utf8').toString('base64');
      this.write(`cb ${b64}`);
    }
  }
  enter(yRatio: number) {
    this.write(`e ${Math.min(1, Math.max(0, yRatio)).toFixed(4)}`);
  }
  clientReturned(yRatio: number) {
    this.write(`cr ${Math.min(1, Math.max(0, yRatio)).toFixed(4)}`);
  }
  leave() {
    this.write('l');
  }
  move(dx: number, dy: number) {
    this.write(`m ${Math.trunc(dx)} ${Math.trunc(dy)}`);
  }
  button(button: number, down: boolean) {
    this.write(`b ${Math.trunc(button)} ${down ? 1 : 0}`);
  }
  wheel(dy: number, dx: number) {
    this.write(`w ${Math.trunc(dy)} ${Math.trunc(dx)}`);
  }
  key(code: number, down: boolean) {
    this.write(`k ${Math.trunc(code)} ${down ? 1 : 0}`);
  }
  stop() {
    this.proc?.kill();
  }
}

export function createInjector(returnEdge: Edge): Injector {
  if (process.platform === 'win32') {
    const script = path.join(SCRIPTS_DIR, 'win_injector.ps1');
    return new Injector(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ReturnEdge', returnEdge],
      'Windows'
    );
  }
  if (process.platform === 'linux') {
    ensureLinuxDeviceAccess(['/dev/uinput']);
    const { width, height } = detectLinuxScreen();
    const script = path.join(SCRIPTS_DIR, 'linux_inject.py');
    return new Injector('python3', [script, JSON.stringify({ width, height, edge: returnEdge })], 'Linux');
  }
  throw new Error(`Plataforma "${process.platform}" ainda não é suportada como cliente.`);
}
