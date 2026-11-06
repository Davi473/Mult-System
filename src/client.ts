import net from 'net';
import tls from 'tls';
import os from 'os';
import { Injector, createInjector } from './inject';
import {
  InputPacket,
  Packet,
  FrameReader,
  MouseBatcher,
  encodeBinary,
  loadEnv,
  parseEdge,
  computeHmac,
} from './protocol';
import { discoverServer } from './discovery';
import { getOrCreateSecretKey, isTLSEnabled } from './security';

loadEnv();

const SERVER_HOST = process.argv[2] || process.env.SERVER_HOST || 'servidor';
const SERVER_PORT = Number(process.env.KVM_PORT) || 5000;
const RETURN_EDGE = parseEdge(process.env.RETURN_EDGE, 'left');
const CLIENT_NAME = process.env.CLIENT_NAME || `${os.hostname()} (${process.platform})`;
const CLIENT_ID = process.env.CLIENT_ID || `${os.hostname()}-${process.pid}`;

const isIp = net.isIP(SERVER_HOST) !== 0;
const HOSTS = Array.from(
  new Set(
    [
      SERVER_HOST,
      !isIp && !SERVER_HOST.endsWith('.local') ? `${SERVER_HOST}.local` : '',
      ...(process.env.SERVER_FALLBACK_HOSTS ?? '192.168.1.15,192.168.1.14').split(','),
    ]
      .map((h) => h.trim())
      .filter(Boolean)
  )
);

class KVMClient {
  private socket: net.Socket | null = null;
  private active = false;
  private hostIndex = 0;
  private reconnectAttempts = 0;
  private mouseBatcher: MouseBatcher;
  private secretKey: string;

  constructor(private readonly injector: Injector) {
    this.secretKey = getOrCreateSecretKey();

    this.mouseBatcher = new MouseBatcher((dx, dy) => {
      this.send({ type: 'move', dx, dy });
    });

    injector.on('return', (yRatio: number) => {
      if (!this.active) return;
      this.active = false;
      console.log('[Cliente] Borda de retorno atingida -> devolvendo controle ao Servidor.');
      this.send({ type: 'return', yRatio });
    });

    injector.on('pos', (pos: { x: number; y: number }) => {
      if (this.active) {
        this.send({ type: 'client_pos', x: pos.x, y: pos.y });
      }
    });

    injector.on('clipboard', (data: { format?: string; text?: string; image?: string }) => {
      this.send({
        type: 'clipboard',
        format: data.format as 'text' | 'image',
        text: data.text,
        image: data.image,
      });
      console.log(`[Cliente] Área de transferência enviada (${data.format || 'text'}).`);
    });

    injector.on('client_enter', (yRatio: number) => {
      this.active = false;
      console.log('[Cliente] Borda atingida -> Mouse/Teclado do Cliente agora controlando o Servidor Linux!');
      this.send({ type: 'client_enter', yRatio });
    });

    injector.on('client_leave', () => {
      console.log('[Cliente] ScrollLock -> Controle voltou para o Cliente.');
      this.send({ type: 'client_leave' });
    });

    injector.on('client_input', (pkt: InputPacket) => {
      if (pkt.type === 'move') {
        this.mouseBatcher.push(pkt.dx, pkt.dy);
      } else {
        this.mouseBatcher.flush();
        this.send(pkt);
      }
    });

    injector.on('exit', (code: number) => {
      console.error(`[Cliente] Injetor encerrou (código ${code}). Saindo.`);
      process.exit(1);
    });
  }

  private send(packet: Packet) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(encodeBinary(packet));
    }
  }

  async connect() {
    let host = HOSTS[this.hostIndex % HOSTS.length];
    let port = SERVER_PORT;

    // Tenta autodescoberta UDP na rede local na primeira tentativa ou a cada ciclo
    if (this.reconnectAttempts === 0 || this.hostIndex % HOSTS.length === 0) {
      try {
        console.log('[Cliente] Procurando Servidor KVM automaticamente na rede local (mDNS/UDP)...');
        const discovered = await discoverServer({ timeoutMs: 1500 });
        if (discovered) {
          console.log(`[Cliente] Servidor descoberto automaticamente em: ${discovered.host}:${discovered.port} (${discovered.name})`);
          host = discovered.host;
          port = discovered.port;
        }
      } catch {
        // Fallback silencioso para lista estática
      }
    }

    let connected = false;
    const useTLS = isTLSEnabled();
    console.log(`[Cliente] Conectando em ${host}:${port} (${useTLS ? 'TLS Seguro' : 'TCP'})...`);

    const onConnect = () => {
      connected = true;
      this.reconnectAttempts = 0;
      socket.setTimeout(0);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 2000);
      this.socket = socket;
      console.log(`[Cliente] Conexão estabelecida com ${host}:${port}. Aguardando autenticação...`);

      // Envia informações iniciais do cliente
      this.send({
        type: 'client_info',
        name: CLIENT_NAME,
        id: CLIENT_ID,
        width: this.injector.screenWidth,
        height: this.injector.screenHeight,
      });
    };

    const socket: net.Socket = useTLS
      ? tls.connect({ host, port, rejectUnauthorized: false }, onConnect)
      : net.connect({ host, port, family: 4 }, onConnect);

    socket.setTimeout(4000);
    socket.on('timeout', () => {
      if (!connected) socket.destroy(new Error('tempo esgotado de conexão'));
    });

    const reader = new FrameReader(
      (packet) => {
        try {
          this.handle(packet);
        } catch (err) {
          console.error('[Cliente] Erro ao processar pacote:', (err as Error).message);
        }
      },
      { maxBufferSize: 10 * 1024 * 1024 }
    );

    socket.on('data', (chunk) => {
      try {
        reader.push(chunk);
      } catch (err) {
        console.error('[Cliente] Erro de protocolo / overflow:', (err as Error).message);
        socket.destroy();
      }
    });

    socket.on('error', (err) => console.error(`[Cliente] Erro no socket (${host}): ${err.message}`));

    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.active) {
        this.active = false;
        this.injector.leave();
      }
      if (!connected) {
        this.hostIndex++;
      }
      this.reconnectAttempts++;

      // Exponential Backoff com Jitter
      const baseDelay = Math.min(15000, 1000 * Math.pow(1.5, Math.min(this.reconnectAttempts, 7)));
      const jitter = Math.floor(Math.random() * 500);
      const delay = Math.round(baseDelay + jitter);

      console.log(`[Cliente] Desconectado. Nova tentativa em ${(delay / 1000).toFixed(1)}s (tentativa #${this.reconnectAttempts})...`);
      setTimeout(() => this.connect(), delay);
    });
  }

  private handle(packet: Packet) {
    switch (packet.type) {
      case 'auth_challenge': {
        const hmac = computeHmac(this.secretKey, packet.nonce);
        this.send({
          type: 'auth_response',
          hmac,
          clientName: CLIENT_NAME,
          clientId: CLIENT_ID,
        });
        console.log('[Cliente] Desafio de autenticação recebido. Resposta HMAC enviada.');
        break;
      }
      case 'auth_success':
        console.log(`[Cliente] Autenticado com sucesso no Servidor! (ID: ${packet.clientId})`);
        break;
      case 'auth_fail':
        console.error(`[Cliente] Falha de autenticação: ${packet.reason}. Verifique a KVM_SECRET_KEY no .env.`);
        break;
      case 'ping':
        this.send({ type: 'pong', seq: packet.seq, timestamp: packet.timestamp });
        break;
      case 'config':
        this.injector.setReturnEdge(packet.returnEdge);
        console.log(`[Cliente] Borda de retorno atualizada pelo Servidor: ${packet.returnEdge.toUpperCase()}`);
        break;
      case 'clipboard':
        if (packet.text || packet.image) {
          this.injector.setClipboard(packet);
          console.log(`[Cliente] Área de transferência recebida do Servidor (${packet.format || 'text'}).`);
        }
        break;
      case 'enter':
        if (packet.returnEdge) {
          this.injector.setReturnEdge(packet.returnEdge);
        }
        this.active = true;
        this.injector.enter(packet.yRatio);
        console.log('[Cliente] Controle recebido do Servidor.');
        break;
      case 'client_return':
        this.active = false;
        this.injector.clientReturned(packet.yRatio);
        console.log('[Cliente] Cursor retornou do Servidor Linux para o Cliente Windows.');
        break;
      case 'leave':
        if (this.active) {
          this.active = false;
          this.injector.leave();
          console.log('[Cliente] Controle devolvido ao Servidor.');
        }
        break;
      case 'move':
        if (this.active) this.injector.move(packet.dx, packet.dy);
        break;
      case 'button':
        if (this.active) this.injector.button(packet.button, packet.down);
        break;
      case 'wheel':
        if (this.active) this.injector.wheel(packet.dy, packet.dx);
        break;
      case 'key':
        if (this.active) this.injector.key(packet.code, packet.down);
        break;
    }
  }
}

async function main() {
  const injector = createInjector(RETURN_EDGE);
  await injector.start();
  new KVMClient(injector).connect();

  const shutdown = () => {
    injector.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Cliente] Erro fatal:', err.message ?? err);
  process.exit(1);
});
