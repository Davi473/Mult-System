import net from 'net';
import { createCapture } from './capture';
import { WebDashboard, KVMState } from './frontend';
import { Edge, Packet, LineReader, encode, loadEnv, saveEnv, parseEdge, oppositeEdge } from './protocol';

loadEnv();

const PORT = Number(process.env.KVM_PORT) || 5000;
const UI_PORT = Number(process.env.UI_PORT) || 8080;

async function main() {
  let clientEdge: Edge = parseEdge(process.env.CLIENT_EDGE, 'right');
  let mouseSpeed = Number(process.env.MOUSE_SPEED) || 1.0;
  let mouseAccel = process.env.MOUSE_ACCEL !== undefined ? Number(process.env.MOUSE_ACCEL) : 1.0;

  const capture = createCapture({ edge: clientEdge, speed: mouseSpeed, accel: mouseAccel });
  let client: net.Socket | null = null;
  let clientAddress: string | null = null;
  let remote = false; // True quando mouse/teclado do Servidor controla o Cliente
  let clientControlling = false; // True quando mouse/teclado do Cliente controla o Servidor

  let serverScreen = { width: 1920, height: 1080 };
  let clientScreen = { width: 1920, height: 1080 };
  let cursor: KVMState['cursor'] = { screen: 'server', x: 960, y: 540 };

  const send = (packet: Packet) => {
    if (client && !client.destroyed) client.write(encode(packet));
  };

  const dashboard = new WebDashboard(UI_PORT, {
    getState: () => ({
      clientConnected: client !== null && !client.destroyed,
      clientAddress,
      remoteActive: remote,
      clientEdge,
      mouseSpeed,
      mouseAccel,
      serverScreen,
      clientScreen,
      cursor,
    }),
    onUpdateConfig: (cfg) => {
      if (cfg.edge) {
        clientEdge = parseEdge(cfg.edge, clientEdge);
        const returnEdge = oppositeEdge(clientEdge);
        send({ type: 'config', returnEdge });
        saveEnv({ CLIENT_EDGE: clientEdge, RETURN_EDGE: returnEdge });
        console.log(`[Servidor] Layout alterado: Cliente posicionado em ${clientEdge.toUpperCase()} (retorno: ${returnEdge.toUpperCase()})`);
      }
      if (cfg.speed !== undefined) {
        mouseSpeed = Number(cfg.speed) || 1.0;
        saveEnv({ MOUSE_SPEED: mouseSpeed });
      }
      if (cfg.accel !== undefined) {
        mouseAccel = Number(cfg.accel);
        saveEnv({ MOUSE_ACCEL: mouseAccel });
      }
      capture.updateConfig({ edge: clientEdge, speed: mouseSpeed, accel: mouseAccel });
    },
    onForceSwitch: (toRemote: boolean) => {
      if (toRemote && client && !remote) {
        remote = true;
        capture.setRemote(true);
        const returnEdge = oppositeEdge(clientEdge);
        send({ type: 'enter', yRatio: 0.5, returnEdge });
        cursor = { screen: 'client', x: clientScreen.width / 2, y: clientScreen.height / 2 };
        console.log('[Servidor] Alternância manual pelo painel -> Cliente ativo.');
      } else if (!toRemote && remote) {
        remote = false;
        capture.setRemote(false, 0.5);
        send({ type: 'leave' });
        cursor = { screen: 'server', x: serverScreen.width / 2, y: serverScreen.height / 2 };
        console.log('[Servidor] Alternância manual pelo painel -> Servidor ativo.');
      }
    },
    onCenterCursor: () => {
      if (remote) {
        remote = false;
        capture.setRemote(false, 0.5);
        send({ type: 'leave' });
      }
      capture.centerCursor();
      cursor = { screen: 'server', x: serverScreen.width / 2, y: serverScreen.height / 2 };
    },
  });

  const backToServer = (yRatio: number, reason: string) => {
    if (!remote) return;
    remote = false;
    capture.setRemote(false, yRatio);
    cursor = {
      screen: 'server',
      x: clientEdge === 'right' ? serverScreen.width - 40 : clientEdge === 'left' ? 40 : Math.round(yRatio * serverScreen.width),
      y: clientEdge === 'bottom' ? serverScreen.height - 40 : clientEdge === 'top' ? 40 : Math.round(yRatio * serverScreen.height),
    };
    console.log(`[Servidor] Controle de volta no Servidor (${reason}).`);
    dashboard.broadcast();
  };

  capture.on('edge', (yRatio: number) => {
    if (!client || remote || clientControlling) return;
    remote = true;
    capture.setRemote(true);
    const returnEdge = oppositeEdge(clientEdge);
    send({ type: 'enter', yRatio, returnEdge });
    console.log(`[Servidor] Borda (${clientEdge}) atingida -> Mouse do Servidor controlando o Cliente.`);
    dashboard.broadcast();
  });

  capture.on('client_return', (yRatio: number) => {
    if (!clientControlling) return;
    clientControlling = false;
    send({ type: 'client_return', yRatio });
    console.log('[Servidor] Borda atingida -> Mouse do Cliente devolvido para o Cliente.');
    dashboard.broadcast();
  });

  capture.on('pos', (pos: { x: number; y: number }) => {
    if (!remote) {
      cursor = { screen: 'server', x: pos.x, y: pos.y };
      dashboard.broadcast();
    }
  });

  capture.on('input', (packet: Packet) => {
    if (remote) send(packet);
  });

  capture.on('clipboard', (text: string) => {
    if (client && !client.destroyed) {
      send({ type: 'clipboard', text });
      console.log('[Servidor] Área de transferência enviada para o Cliente Windows.');
    }
  });

  capture.on('emergency', () => {
    if (!remote) return;
    remote = false;
    send({ type: 'leave' });
    cursor = { screen: 'server', x: serverScreen.width / 2, y: serverScreen.height / 2 };
    console.log('[Servidor] ScrollLock -> controle de volta no Servidor.');
    dashboard.broadcast();
  });

  capture.on('exit', (code: number) => {
    console.log(`[Servidor] Captura encerrada (código ${code}). Saindo.`);
    process.exit(code === 3 ? 0 : 1);
  });

  serverScreen = await capture.start();
  cursor = { screen: 'server', x: Math.floor(serverScreen.width / 2), y: Math.floor(serverScreen.height / 2) };
  dashboard.start();

  const server = net.createServer((socket) => {
    if (client) {
      console.log('[Servidor] Novo cliente conectado; desconectando o anterior.');
      client.destroy();
    }
    client = socket;
    clientAddress = `${socket.remoteAddress?.replace('::ffff:', '')}:${socket.remotePort}`;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 2000);
    console.log(`[Servidor] Cliente conectado: ${clientAddress}`);

    // Envia imediatamente a borda de retorno configurada para sincronizar o Cliente
    send({ type: 'config', returnEdge: oppositeEdge(clientEdge) });
    dashboard.broadcast();

    const reader = new LineReader((line) => {
      let packet: any;
      try {
        packet = JSON.parse(line);
      } catch {
        return;
      }
      if (packet.type === 'return' || packet.type === 'return_server') {
        backToServer(Number(packet.yRatio ?? 0.5), 'borda do cliente');
      } else if (packet.type === 'client_enter') {
        if (remote) {
          remote = false;
          capture.setRemote(false, 0.5);
        }
        clientControlling = true;
        capture.clientEnter(Number(packet.yRatio ?? 0.5));
        console.log('[Servidor] Mouse/Teclado do Cliente Windows assumiu controle do Servidor Linux!');
        dashboard.broadcast();
      } else if (packet.type === 'client_leave') {
        if (clientControlling) {
          clientControlling = false;
          capture.clientLeave();
          console.log('[Servidor] Cliente Windows devolveu controle local (ScrollLock).');
          dashboard.broadcast();
        }
      } else if (
        packet.type === 'move' ||
        packet.type === 'button' ||
        packet.type === 'wheel' ||
        packet.type === 'key'
      ) {
        if (clientControlling) {
          capture.injectFromClient(packet);
        }
      } else if (packet.type === 'clipboard') {
        if (packet.text) {
          capture.setClipboard(String(packet.text));
          console.log('[Servidor] Área de transferência recebida do Cliente Windows.');
        }
      } else if (packet.type === 'client_info') {
        clientScreen = { width: Number(packet.width) || 1920, height: Number(packet.height) || 1080 };
        dashboard.broadcast();
      } else if (packet.type === 'client_pos') {
        if (remote) {
          cursor = { screen: 'client', x: Number(packet.x) || 0, y: Number(packet.y) || 0 };
          dashboard.broadcast();
        }
      }
    });

    socket.on('data', (chunk) => reader.push(chunk));
    socket.on('error', (err) => console.error('[Servidor] Erro no socket:', err.message));
    socket.on('close', () => {
      if (client !== socket) return;
      client = null;
      clientAddress = null;
      if (clientControlling) {
        clientControlling = false;
        capture.clientLeave();
      }
      console.log('[Servidor] Cliente desconectado.');
      backToServer(0.5, 'cliente desconectou');
      dashboard.broadcast();
    });
  });

  server.listen(PORT, () => {
    console.log(`[Servidor] Escutando na porta TCP ${PORT}. Cliente configurado em: ${clientEdge.toUpperCase()}.`);
    console.log(`[Servidor] Abra http://localhost:${UI_PORT} para configurar as telas visualmente!`);
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
