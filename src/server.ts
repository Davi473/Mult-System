import net from 'net';
import { createCapture } from './capture';
import { Packet, LineReader, encode, loadEnv, parseEdge } from './protocol';

loadEnv();

const PORT = Number(process.env.KVM_PORT) || 5000;
// Em qual borda do Servidor o monitor do Cliente está posicionado ('right' ou 'left')
const CLIENT_EDGE = parseEdge(process.env.CLIENT_EDGE, 'right');
// Velocidade/aceleração do cursor LOCAL no Linux (o cursor local é movido pelo próprio KVM)
const MOUSE_SPEED = Number(process.env.MOUSE_SPEED) || 1.0;
const MOUSE_ACCEL = process.env.MOUSE_ACCEL !== undefined ? Number(process.env.MOUSE_ACCEL) : 1.0;

async function main() {
  const capture = createCapture({ edge: CLIENT_EDGE, speed: MOUSE_SPEED, accel: MOUSE_ACCEL });
  let client: net.Socket | null = null;
  let remote = false;

  const send = (packet: Packet) => {
    if (client && !client.destroyed) client.write(encode(packet));
  };

  const backToServer = (yRatio: number, reason: string) => {
    if (!remote) return;
    remote = false;
    capture.setRemote(false, yRatio);
    console.log(`[Servidor] Controle de volta no Servidor (${reason}).`);
  };

  capture.on('edge', (yRatio: number) => {
    if (!client || remote) return;
    remote = true;
    capture.setRemote(true);
    send({ type: 'enter', yRatio });
    console.log('[Servidor] Borda atingida -> controle transferido para o Cliente.');
  });

  capture.on('input', (packet: Packet) => {
    if (remote) send(packet);
  });

  capture.on('emergency', () => {
    if (!remote) return;
    remote = false;
    send({ type: 'leave' });
    console.log('[Servidor] ScrollLock -> controle de volta no Servidor.');
  });

  capture.on('exit', (code: number) => {
    console.log(`[Servidor] Captura encerrada (código ${code}). Saindo.`);
    process.exit(code === 3 ? 0 : 1);
  });

  await capture.start();

  const server = net.createServer((socket) => {
    if (client) {
      console.log('[Servidor] Novo cliente conectado; desconectando o anterior.');
      client.destroy();
    }
    client = socket;
    socket.setNoDelay(true); // Desativa algoritmo de Nagle para menor latência
    socket.setKeepAlive(true, 2000);
    console.log(`[Servidor] Cliente conectado: ${socket.remoteAddress}:${socket.remotePort}`);

    const reader = new LineReader((line) => {
      let packet: Packet;
      try {
        packet = JSON.parse(line);
      } catch {
        return;
      }
      if (packet.type === 'return') backToServer(packet.yRatio, 'borda do cliente');
    });

    socket.on('data', (chunk) => reader.push(chunk));
    socket.on('error', (err) => console.error('[Servidor] Erro no socket:', err.message));
    socket.on('close', () => {
      if (client !== socket) return;
      client = null;
      console.log('[Servidor] Cliente desconectado.');
      backToServer(0.5, 'cliente desconectou');
    });
  });

  server.listen(PORT, () => {
    console.log(`[Servidor] Escutando na porta TCP ${PORT}. Cliente fica à ${CLIENT_EDGE === 'right' ? 'DIREITA' : 'ESQUERDA'}.`);
    console.log('[Servidor] ScrollLock: volta ao servidor | no servidor: encerra e libera o mouse.');
  });

  const shutdown = () => {
    capture.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Servidor] Erro fatal:', err.message ?? err);
  process.exit(1);
});
