import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { Edge, LineReader } from './protocol';
import { SCRIPTS_DIR, detectLinuxScreen, ensureLinuxDeviceAccess } from './platform';

/**
 * Injeta mouse/teclado no CLIENTE através de um processo auxiliar
 * (PowerShell + SendInput no Windows, Python + uinput no Linux).
 * Ambos falam o mesmo protocolo de texto (ver scripts/win_injector.ps1).
 *
 * Eventos: 'return' (yRatio) quando o cursor atinge a borda de retorno; 'exit' (code).
 */
export class Injector extends EventEmitter {
  private proc: ChildProcess | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    readonly label: string
  ) {
    super();
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
      this.proc = proc;
      let ready = false;

      const reader = new LineReader((line) => {
        if (line.startsWith('ready')) {
          ready = true;
          console.log(`[Injetor ${this.label}] Pronto (tela ${line.slice(6)})`);
          resolve();
        } else if (line.startsWith('r ')) {
          this.emit('return', Number(line.slice(2)));
        }
      });

      proc.stdout!.on('data', (chunk) => reader.push(chunk));
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
    this.proc?.stdin?.write(line + '\n');
  }

  enter(yRatio: number) {
    this.write(`e ${Math.min(1, Math.max(0, yRatio)).toFixed(4)}`);
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
