import net from 'net';
import { Injector, createInjector } from './inject';
import { Packet, LineReader, encode, loadEnv, parseEdge } from './protocol';

loadEnv();

const SERVER_HOST = process.argv[2] || process.env.SERVER_HOST || 'servidor';
const SERVER_PORT = Number(process.env.KVM_PORT) || 5000;
// Se o Cliente está à direita do Servidor, a borda de retorno ao Servidor é a esquerda ('left')
const RETURN_EDGE = parseEdge(process.env.RETURN_EDGE, 'left');

// Candidatos de conexão: host informado, variante .local (mDNS) e IPs extras opcionais
const isIp = net.isIP(SERVER_HOST) !== 0;
const HOSTS = Array.from(
  new Set(
    [
      SERVER_HOST,
      !isIp && !SERVER_HOST.endsWith('.local') ? `${SERVER_HOST}.local` : '',
      ...(process.env.SERVER_FALLBACK_HOSTS ?? '192.168.1.15').split(','),
    ]
      .map((h) => h.trim())
      .filter(Boolean)
  )
);

class KVMClient {
  private socket: net.Socket | null = null;
  private active = false;
  private hostIndex = 0;

  constructor(private readonly injector: Injector) {
    injector.on('return', (yRatio: number) => {
      if (!this.active) return;
      this.active = false;
      console.log('[Cliente] Borda de retorno atingida -> devolvendo controle ao Servidor.');
      this.send({ type: 'return', yRatio });
    });
    injector.on('exit', (code: number) => {
      console.error(`[Cliente] Injetor encerrou (código ${code}). Saindo.`);
      process.exit(1);
    });
  }

  private send(packet: Packet) {
    if (this.socket && !this.socket.destroyed) this.socket.write(encode(packet));
  }

  connect() {
    const host = HOSTS[this.hostIndex % HOSTS.length];
    const socket = new net.Socket();
    let connected = false;
    console.log(`[Cliente] Conectando em ${host}:${SERVER_PORT}...`);

    socket.setTimeout(4000);
    socket.on('timeout', () => {
      if (!connected) socket.destroy(new Error('tempo esgotado'));
    });

    socket.connect({ host, port: SERVER_PORT, family: 4 }, () => {
      connected = true;
      socket.setTimeout(0);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 2000);
      this.socket = socket;
      console.log(`[Cliente] Conectado ao Servidor ${host}:${SERVER_PORT}. Borda de retorno: ${RETURN_EDGE}.`);
    });

    const reader = new LineReader((line) => {
      try {
        this.handle(JSON.parse(line) as Packet);
      } catch (err) {
        console.error('[Cliente] Pacote inválido:', (err as Error).message);
      }
    });
    socket.on('data', (chunk) => reader.push(chunk));

    socket.on('error', (err) => console.error(`[Cliente] Erro (${host}): ${err.message}`));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.active) {
        this.active = false;
        this.injector.leave();
      }
      if (!connected) this.hostIndex++; // tenta o próximo candidato
      console.log('[Cliente] Desconectado. Nova tentativa em 2s...');
      setTimeout(() => this.connect(), 2000);
    });
  }

  private handle(packet: Packet) {
    switch (packet.type) {
      case 'enter':
        this.active = true;
        this.injector.enter(packet.yRatio);
        console.log('[Cliente] Controle recebido.');
        break;
      case 'leave':
        if (this.active) {
          this.active = false;
          this.injector.leave();
          console.log('[Cliente] Controle devolvido ao Servidor (ScrollLock).');
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
