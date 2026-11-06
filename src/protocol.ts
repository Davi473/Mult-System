import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

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

export const OP_MOVE = 0x01;
export const OP_BUTTON = 0x02;
export const OP_KEY = 0x03;
export const OP_WHEEL = 0x04;
export const OP_PING = 0x05;
export const OP_PONG = 0x06;
export const OP_POS = 0x07;
export const OP_JSON = 0x10;
export const OP_CLIPBOARD_BIN = 0x11;

/**
 * Pacotes trocados entre Servidor e Cliente (Binário ou NDJSON).
 */
export type Packet =
  | { type: 'enter'; yRatio: number; returnEdge?: Edge }
  | { type: 'leave' }
  | { type: 'config'; returnEdge: Edge }
  | { type: 'return'; yRatio: number }
  | { type: 'client_enter'; yRatio: number }
  | { type: 'client_leave' }
  | { type: 'client_return'; yRatio: number }
  | { type: 'clipboard'; text?: string; image?: string; format?: 'text' | 'image' }
  | { type: 'client_info'; width: number; height: number; name?: string; id?: string }
  | { type: 'client_pos'; x: number; y: number }
  | { type: 'move'; dx: number; dy: number }
  | { type: 'button'; button: number; down: boolean }
  | { type: 'wheel'; dy: number; dx: number }
  | { type: 'key'; code: number; down: boolean }
  | { type: 'ping'; seq: number; timestamp: number }
  | { type: 'pong'; seq: number; timestamp: number }
  | { type: 'auth_challenge'; nonce: string }
  | { type: 'auth_response'; hmac: string; clientName?: string; clientId?: string }
  | { type: 'auth_success'; clientId: string; serverName?: string }
  | { type: 'auth_fail'; reason: string };

export type InputPacket = Extract<Packet, { type: 'move' | 'button' | 'wheel' | 'key' }>;

/**
 * Codifica pacote em buffer binário ultracompacto para alta performance
 */
export function encodeBinary(packet: Packet): Buffer {
  switch (packet.type) {
    case 'move': {
      const buf = Buffer.allocUnsafe(5);
      buf.writeUInt8(OP_MOVE, 0);
      buf.writeInt16BE(Math.min(32767, Math.max(-32768, Math.trunc(packet.dx))), 1);
      buf.writeInt16BE(Math.min(32767, Math.max(-32768, Math.trunc(packet.dy))), 3);
      return buf;
    }
    case 'button': {
      const buf = Buffer.allocUnsafe(3);
      buf.writeUInt8(OP_BUTTON, 0);
      buf.writeUInt8(packet.button & 0xff, 1);
      buf.writeUInt8(packet.down ? 1 : 0, 2);
      return buf;
    }
    case 'key': {
      const buf = Buffer.allocUnsafe(4);
      buf.writeUInt8(OP_KEY, 0);
      buf.writeUInt16BE(packet.code & 0xffff, 1);
      buf.writeUInt8(packet.down ? 1 : 0, 3);
      return buf;
    }
    case 'wheel': {
      const buf = Buffer.allocUnsafe(5);
      buf.writeUInt8(OP_WHEEL, 0);
      buf.writeInt16BE(Math.min(32767, Math.max(-32768, Math.trunc(packet.dy))), 1);
      buf.writeInt16BE(Math.min(32767, Math.max(-32768, Math.trunc(packet.dx))), 3);
      return buf;
    }
    case 'ping': {
      const buf = Buffer.allocUnsafe(9);
      buf.writeUInt8(OP_PING, 0);
      buf.writeUInt32BE(packet.seq >>> 0, 1);
      buf.writeUInt32BE(packet.timestamp >>> 0, 5);
      return buf;
    }
    case 'pong': {
      const buf = Buffer.allocUnsafe(9);
      buf.writeUInt8(OP_PONG, 0);
      buf.writeUInt32BE(packet.seq >>> 0, 1);
      buf.writeUInt32BE(packet.timestamp >>> 0, 5);
      return buf;
    }
    case 'client_pos': {
      const buf = Buffer.allocUnsafe(5);
      buf.writeUInt8(OP_POS, 0);
      buf.writeInt16BE(Math.min(32767, Math.max(-32768, Math.trunc(packet.x))), 1);
      buf.writeInt16BE(Math.min(32767, Math.max(-32768, Math.trunc(packet.y))), 3);
      return buf;
    }
    default: {
      const jsonStr = JSON.stringify(packet);
      const jsonBuf = Buffer.from(jsonStr, 'utf8');
      const buf = Buffer.allocUnsafe(5 + jsonBuf.length);
      buf.writeUInt8(OP_JSON, 0);
      buf.writeUInt32BE(jsonBuf.length, 1);
      jsonBuf.copy(buf, 5);
      return buf;
    }
  }
}

/**
 * Codificação NDJSON legado para retrocompatibilidade
 */
export function encode(packet: Packet): string {
  return JSON.stringify(packet) + '\n';
}

/**
 * FrameReader avançado que processa tanto pacotes binários quanto NDJSON legado,
 * com proteção contra estouro de buffer (DoS / memory leak).
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxBufferSize: number;

  constructor(
    private readonly onPacket: (packet: Packet) => void,
    options?: { maxBufferSize?: number }
  ) {
    this.maxBufferSize = options?.maxBufferSize ?? 10 * 1024 * 1024; // 10MB max
  }

  push(chunk: Buffer | string): void {
    const chunkBuf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (this.buffer.length + chunkBuf.length > this.maxBufferSize) {
      this.buffer = Buffer.alloc(0);
      throw new Error(`Buffer overflow: excedeu ${this.maxBufferSize} bytes sem delimitador válido.`);
    }

    this.buffer = Buffer.concat([this.buffer, chunkBuf]);
    this.process();
  }

  private process(): void {
    while (this.buffer.length > 0) {
      const firstByte = this.buffer[0];

      // Caso 1: Pacote NDJSON em texto (começa com '{' ou espaço/newline)
      if (firstByte === 0x7b || firstByte === 0x0a || firstByte === 0x0d || firstByte === 0x20) {
        const newlineIdx = this.buffer.indexOf(0x0a);
        if (newlineIdx === -1) {
          // Linha ainda incompleta
          break;
        }
        const line = this.buffer.subarray(0, newlineIdx).toString('utf8').trim();
        this.buffer = this.buffer.subarray(newlineIdx + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as Packet;
            this.onPacket(parsed);
          } catch {
            // Ignora JSON corrompido
          }
        }
        continue;
      }

      // Caso 2: Pacote Binário por Opcode
      switch (firstByte) {
        case OP_MOVE: {
          if (this.buffer.length < 5) return;
          const dx = this.buffer.readInt16BE(1);
          const dy = this.buffer.readInt16BE(3);
          this.buffer = this.buffer.subarray(5);
          this.onPacket({ type: 'move', dx, dy });
          break;
        }
        case OP_BUTTON: {
          if (this.buffer.length < 3) return;
          const button = this.buffer.readUInt8(1);
          const down = this.buffer.readUInt8(2) === 1;
          this.buffer = this.buffer.subarray(3);
          this.onPacket({ type: 'button', button, down });
          break;
        }
        case OP_KEY: {
          if (this.buffer.length < 4) return;
          const code = this.buffer.readUInt16BE(1);
          const down = this.buffer.readUInt8(3) === 1;
          this.buffer = this.buffer.subarray(4);
          this.onPacket({ type: 'key', code, down });
          break;
        }
        case OP_WHEEL: {
          if (this.buffer.length < 5) return;
          const dy = this.buffer.readInt16BE(1);
          const dx = this.buffer.readInt16BE(3);
          this.buffer = this.buffer.subarray(5);
          this.onPacket({ type: 'wheel', dy, dx });
          break;
        }
        case OP_PING: {
          if (this.buffer.length < 9) return;
          const seq = this.buffer.readUInt32BE(1);
          const timestamp = this.buffer.readUInt32BE(5);
          this.buffer = this.buffer.subarray(9);
          this.onPacket({ type: 'ping', seq, timestamp });
          break;
        }
        case OP_PONG: {
          if (this.buffer.length < 9) return;
          const seq = this.buffer.readUInt32BE(1);
          const timestamp = this.buffer.readUInt32BE(5);
          this.buffer = this.buffer.subarray(9);
          this.onPacket({ type: 'pong', seq, timestamp });
          break;
        }
        case OP_POS: {
          if (this.buffer.length < 5) return;
          const x = this.buffer.readInt16BE(1);
          const y = this.buffer.readInt16BE(3);
          this.buffer = this.buffer.subarray(5);
          this.onPacket({ type: 'client_pos', x, y });
          break;
        }
        case OP_JSON: {
          if (this.buffer.length < 5) return;
          const len = this.buffer.readUInt32BE(1);
          if (len > this.maxBufferSize) {
            throw new Error(`Pacote JSON payload de ${len} bytes excede limite de segurança.`);
          }
          if (this.buffer.length < 5 + len) return;
          const jsonStr = this.buffer.subarray(5, 5 + len).toString('utf8');
          this.buffer = this.buffer.subarray(5 + len);
          try {
            const parsed = JSON.parse(jsonStr) as Packet;
            this.onPacket(parsed);
          } catch {
            // Ignora JSON corrompido
          }
          break;
        }
        default: {
          // Byte desconhecido - consome 1 byte para tentar ressincronizar
          this.buffer = this.buffer.subarray(1);
          break;
        }
      }
    }
  }
}

/**
 * Junta pedaços de um stream de texto (stdout de scripts) com limite de segurança contra DoS
 */
export class LineReader {
  private buffer = '';
  private readonly maxLineLength: number;

  constructor(
    private readonly onLine: (line: string) => void,
    options?: { maxLineLength?: number }
  ) {
    this.maxLineLength = options?.maxLineLength ?? 64 * 1024; // 64KB padrão
  }

  push(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    if (this.buffer.length > this.maxLineLength && !this.buffer.includes('\n')) {
      this.buffer = '';
      throw new Error(`LineReader overflow: linha excedeu ${this.maxLineLength} caracteres sem quebra.`);
    }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
    }
  }
}

/**
 * Agrupador de movimentos de mouse (Batching / Coalescing) para alta frequência (500Hz-1000Hz).
 * Reduz a carga de rede e CPU em até 80% mantendo latência e precisão ideais.
 */
export class MouseBatcher {
  private pendingDx = 0;
  private pendingDy = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onFlush: (dx: number, dy: number) => void,
    private readonly batchIntervalMs = 2 // ~400-500 updates/segundo máx
  ) {}

  push(dx: number, dy: number): void {
    this.pendingDx += dx;
    this.pendingDy += dy;

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.batchIntervalMs);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const dx = Math.trunc(this.pendingDx);
    const dy = Math.trunc(this.pendingDy);
    this.pendingDx -= dx;
    this.pendingDy -= dy;

    if (dx !== 0 || dy !== 0) {
      this.onFlush(dx, dy);
    }
  }
}

/**
 * Funções de Autenticação Handshake via HMAC-SHA256
 */
export function generateAuthNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function computeHmac(secretKey: string, nonce: string): string {
  return crypto.createHmac('sha256', secretKey).update(nonce).digest('hex');
}

export function verifyHmac(secretKey: string, nonce: string, providedHmac: string): boolean {
  if (!providedHmac || typeof providedHmac !== 'string') return false;
  const expected = computeHmac(secretKey, nonce);
  const bufExpected = Buffer.from(expected, 'hex');
  const bufProvided = Buffer.from(providedHmac, 'hex');
  if (bufExpected.length !== bufProvided.length) return false;
  return crypto.timingSafeEqual(bufExpected, bufProvided);
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
