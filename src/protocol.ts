import fs from 'fs';
import path from 'path';

export type Edge = 'left' | 'right' | 'top' | 'bottom';

export function oppositeEdge(edge: Edge): Edge {
  switch (edge) {
    case 'right':
      return 'left';
    case 'left':
      return 'right';
    case 'top':
      return 'bottom';
    case 'bottom':
      return 'top';
  }
}

/**
 * Pacotes trocados entre Servidor e Cliente (NDJSON: um JSON por linha).
 */
export type Packet =
  | { type: 'enter'; yRatio: number; returnEdge?: Edge }
  | { type: 'leave' }
  | { type: 'config'; returnEdge: Edge }
  | { type: 'return'; yRatio: number }
  | { type: 'client_enter'; yRatio: number }
  | { type: 'client_leave' }
  | { type: 'client_return'; yRatio: number }
  | { type: 'clipboard'; text: string }
  | { type: 'client_info'; width: number; height: number }
  | { type: 'client_pos'; x: number; y: number }
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
  if (v === 'left' || v === 'right' || v === 'top' || v === 'bottom') {
    return v;
  }
  return fallback;
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

/**
 * Salva/atualiza chaves no arquivo .env na raiz do projeto
 */
export function saveEnv(updates: Record<string, string | number>): void {
  const envPath = path.resolve(process.cwd(), '.env');
  let lines: string[] = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  }
  const remaining = new Map<string, string>(
    Object.entries(updates).map(([k, v]) => [k, String(v)])
  );

  const updatedLines = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return rawLine;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) return rawLine;
    const key = line.slice(0, eqIndex).trim();
    if (remaining.has(key)) {
      const val = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${val}`;
    }
    return rawLine;
  });

  for (const [k, v] of remaining.entries()) {
    updatedLines.push(`${k}=${v}`);
  }

  fs.writeFileSync(envPath, updatedLines.join('\n'), 'utf-8');
}
