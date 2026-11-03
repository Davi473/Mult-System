import fs from 'fs';
import path from 'path';

export type Edge = 'left' | 'right';

/**
 * Pacotes trocados entre Servidor e Cliente (NDJSON: um JSON por linha).
 * Teclas usam SEMPRE o código evdev do Linux (ex: A=30, Enter=28) como formato canônico.
 * Botões: 1=esquerdo, 2=direito, 3=meio, 4=voltar, 5=avançar.
 * Roda: dy/dx em "cliques" (positivo = cima / direita).
 */
export type Packet =
  | { type: 'enter'; yRatio: number } // servidor -> cliente: controle entrou no cliente
  | { type: 'leave' } // servidor -> cliente: controle voltou ao servidor (ex: ScrollLock)
  | { type: 'return'; yRatio: number } // cliente -> servidor: cursor atingiu a borda de retorno
  | { type: 'move'; dx: number; dy: number }
  | { type: 'button'; button: number; down: boolean }
  | { type: 'wheel'; dy: number; dx: number }
  | { type: 'key'; code: number; down: boolean };

export type InputPacket = Extract<Packet, { type: 'move' | 'button' | 'wheel' | 'key' }>;

export function encode(packet: Packet): string {
  return JSON.stringify(packet) + '\n';
}

/** Junta pedaços de um stream (TCP / stdout) e entrega linha a linha. */
export class LineReader {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
    }
  }
}

export function parseEdge(value: string | undefined, fallback: Edge): Edge {
  const v = value?.trim().toLowerCase();
  return v === 'left' || v === 'right' ? v : fallback;
}

/**
 * Carrega variáveis do arquivo .env na raiz do projeto (compatível com Windows, Linux e macOS)
 */
export function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
