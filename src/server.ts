import net from 'net';
import tls from 'tls';
import os from 'os';
import { createCapture, EdgeEvent, ClipboardData } from './capture';
import { WebDashboard, KVMState, ClientInfo } from './frontend';
import {
  Edge,
  Packet,
  FrameReader,
  MouseBatcher,
  encodeBinary,
  loadEnv,
  saveEnv,
  parseEdge,
  oppositeEdge,
} from './protocol';
import { DiscoveryServer } from './discovery';
import { getOrCreateSecretKey, getOrCreateTLSCredentials, isTLSEnabled, verifyHmac, generateAuthNonce } from './security';

loadEnv();

const PORT = Number(process.env.KVM_PORT) || 5000;
const UI_PORT = Number(process.env.UI_PORT) || 8080;
const SECRET_KEY = getOrCreateSecretKey();
const USE_TLS = isTLSEnabled();

interface ConnectedClientSession {
  id: string;
  pendingId?: string;
  socket: net.Socket;
  name: string;
  address: string;
  edge: Edge;
  authenticated: boolean;
  authNonce: string;
  authTimer: NodeJS.Timeout | null;
  screenWidth: number;
  screenHeight: number;
  rttMs: number;
  lastPingSent: number;
  pingSeq: number;
  packetsSec: number;
  packetCount: number;
  batcher: MouseBatcher;
}

const EDGES: Edge[] = ['right', 'left', 'top', 'bottom'];

function getAvailableEdge(existingClients: Map<string, ConnectedClientSession>, preferred: Edge): Edge {
  const usedEdges = new Set<Edge>();
  for (const c of existingClients.values()) {
    usedEdges.add(c.edge);
  }
  if (!usedEdges.has(preferred)) return preferred;
  for (const edge of EDGES) {
    if (!usedEdges.has(edge)) return edge;
  }
  return preferred;
}

async function main() {
  let defaultClientEdge: Edge = parseEdge(process.env.CLIENT_EDGE, 'right');
  let mouseSpeed = Number(process.env.MOUSE_SPEED) || 1.0;
  let mouseAccel = process.env.MOUSE_ACCEL !== undefined ? Number(process.env.MOUSE_ACCEL) : 1.0;

  const capture = createCapture({ edge: defaultClientEdge, speed: mouseSpeed, accel: mouseAccel });
  const clients = new Map<string, ConnectedClientSession>();

  let activeClientId: string | null = null;
  let controllingClientId: string | null = null;
  let serverScreen = { width: 1920, height: 1080 };
  let cursor: KVMState['cursor'] = { screen: 'server', x: 960, y: 540 };
  const recentEvents: string[] = [];

  const addEvent = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString('pt-BR');
    recentEvents.unshift(`[${timestamp}] ${msg}`);
    if (recentEvents.length > 30) recentEvents.pop();
  };

  const getActiveClient = (): ConnectedClientSession | null => {
    if (!activeClientId) return null;
    const client = clients.get(activeClientId);
    if (!client || client.socket.destroyed) {
      activeClientId = null;
      return null;
    }
    return client;
  };

  const sendToClient = (client: ConnectedClientSession, packet: Packet) => {
    if (client.socket && !client.socket.destroyed) {
      client.socket.write(encodeBinary(packet));
    }
  };

  const broadcastPacket = (packet: Packet, exceptSocket?: net.Socket) => {
    const encoded = encodeBinary(packet);
    for (const c of clients.values()) {
      if (c.authenticated && c.socket && !c.socket.destroyed && c.socket !== exceptSocket) {
        c.socket.write(encoded);
      }
    }
  };

  const getClientInfoList = (): ClientInfo[] => {
    return Array.from(clients.values()).map((c) => ({
      id: c.id,
      name: c.name,
      address: c.address,
      edge: c.edge,
      authenticated: c.authenticated,
      screen: { width: c.screenWidth, height: c.screenHeight },
      rttMs: c.rttMs,
      packetsSec: c.packetsSec,
      active: c.id === activeClientId,
    }));
  };

  const dashboard = new WebDashboard(UI_PORT, {
    getState: (): KVMState => {
      const activeClient = getActiveClient();
      const firstClient = Array.from(clients.values())[0];
      return {
        clientConnected: clients.size > 0,
        clientAddress: activeClient ? activeClient.address : firstClient?.address || null,
        remoteActive: activeClientId !== null,
        clientEdge: activeClient ? activeClient.edge : defaultClientEdge,
        mouseSpeed,
        mouseAccel,
        serverScreen,
        clientScreen: activeClient ? { width: activeClient.screenWidth, height: activeClient.screenHeight } : { width: 1920, height: 1080 },
        cursor,
        clients: getClientInfoList(),
        security: {
          tlsEnabled: USE_TLS,
          authRequired: true,
        },
        stats: {
          totalPacketsSec: Array.from(clients.values()).reduce((acc, c) => acc + c.packetsSec, 0),
          uptimeSeconds: Math.floor(process.uptime()),
        },
        events: recentEvents,
      };
    },
    onUpdateConfig: (cfg) => {
      if (cfg.clientId && cfg.edge) {
        const client = clients.get(cfg.clientId);
        if (client) {
          client.edge = parseEdge(cfg.edge, client.edge);
          const returnEdge = oppositeEdge(client.edge);
          sendToClient(client, { type: 'config', returnEdge });
          addEvent(`Layout do cliente "${client.name}" alterado para ${client.edge.toUpperCase()}`);
          console.log(`[Servidor] Cliente "${client.name}" posicionado em ${client.edge.toUpperCase()}`);
        }
      } else if (cfg.edge) {
        defaultClientEdge = parseEdge(cfg.edge, defaultClientEdge);
        const returnEdge = oppositeEdge(defaultClientEdge);
        saveEnv({ CLIENT_EDGE: defaultClientEdge, RETURN_EDGE: returnEdge });
        const firstClient = Array.from(clients.values())[0];
        if (firstClient) {
          firstClient.edge = defaultClientEdge;
          sendToClient(firstClient, { type: 'config', returnEdge });
        }
        addEvent(`Borda padrão alterada para ${defaultClientEdge.toUpperCase()}`);
      }
      if (cfg.speed !== undefined) {
        mouseSpeed = Number(cfg.speed) || 1.0;
        saveEnv({ MOUSE_SPEED: mouseSpeed });
      }
      if (cfg.accel !== undefined) {
        mouseAccel = Number(cfg.accel);
        saveEnv({ MOUSE_ACCEL: mouseAccel });
      }
      capture.updateConfig({ edge: defaultClientEdge, speed: mouseSpeed, accel: mouseAccel });
      dashboard.broadcast();
    },
    onForceSwitch: (toRemote: boolean, targetClientId?: string) => {
      if (toRemote) {
        let client = targetClientId ? clients.get(targetClientId) : null;
        if (!client) client = Array.from(clients.values()).find((c) => c.authenticated) || null;
        if (client && client.authenticated) {
          if (activeClientId && activeClientId !== client.id) {
            const prev = getActiveClient();
            if (prev) {
              prev.batcher.cancel();
              sendToClient(prev, { type: 'leave' });
            }
          }
          activeClientId = client.id;
          capture.setRemote(true, 0.5, client.edge);
          const returnEdge = oppositeEdge(client.edge);
          sendToClient(client, { type: 'enter', yRatio: 0.5, returnEdge });
          cursor = { screen: client.id, x: Math.round(client.screenWidth / 2), y: Math.round(client.screenHeight / 2) };
          addEvent(`Controle alternado manualmente para: ${client.name}`);
          console.log(`[Servidor] Alternância manual pelo painel -> "${client.name}" ativo.`);
          dashboard.broadcast();
        }
      } else if (activeClientId) {
        const prev = getActiveClient();
        if (prev) {
          prev.batcher.cancel();
          sendToClient(prev, { type: 'leave' });
        }
        activeClientId = null;
        capture.setRemote(false, 0.5);
        cursor = { screen: 'server', x: Math.round(serverScreen.width / 2), y: Math.round(serverScreen.height / 2) };
        addEvent('Controle de volta no Servidor Linux.');
        dashboard.broadcast();
      }
    },
    onCenterCursor: () => {
      if (activeClientId) {
        const prev = getActiveClient();
        if (prev) {
          prev.batcher.cancel();
          sendToClient(prev, { type: 'leave' });
        }
        activeClientId = null;
        capture.setRemote(false, 0.5);
      }
      capture.centerCursor();
      cursor = { screen: 'server', x: Math.round(serverScreen.width / 2), y: Math.round(serverScreen.height / 2) };
      addEvent('Cursor centralizado e recalibrado no Linux.');
      dashboard.broadcast();
    },
  });

  const backToServer = (yRatio: number, reason: string, fromEdge?: Edge) => {
    if (!activeClientId) return;
    const client = getActiveClient();
    if (client) {
      client.batcher.cancel();
    }
    activeClientId = null;
    const edge = fromEdge || client?.edge || defaultClientEdge;
    capture.setRemote(false, yRatio, edge);
    cursor = {
      screen: 'server',
      x: edge === 'right' ? serverScreen.width - 40 : edge === 'left' ? 40 : Math.round(yRatio * serverScreen.width),
      y: edge === 'bottom' ? serverScreen.height - 40 : edge === 'top' ? 40 : Math.round(yRatio * serverScreen.height),
    };
    addEvent(`Controle de volta ao Servidor (${reason})`);
    console.log(`[Servidor] Controle de volta no Servidor (${reason}).`);
    dashboard.broadcast();
  };

  capture.on('edge', (evt: EdgeEvent | number) => {
    const edge: Edge = typeof evt === 'object' && evt.edge ? evt.edge : defaultClientEdge;
    const yRatio = typeof evt === 'object' ? evt.yRatio : evt;

    if (activeClientId) return;

    // Localiza cliente configurado nesta borda
    let targetClient: ConnectedClientSession | null = null;
    for (const c of clients.values()) {
      if (c.authenticated && c.edge === edge) {
        targetClient = c;
        break;
      }
    }

    if (targetClient) {
      controllingClientId = null;
      activeClientId = targetClient.id;
      capture.setRemote(true, yRatio, edge);
      const returnEdge = oppositeEdge(edge);
      sendToClient(targetClient, { type: 'enter', yRatio, returnEdge });
      cursor = {
        screen: targetClient.id,
        x: returnEdge === 'left' ? 40 : returnEdge === 'right' ? targetClient.screenWidth - 40 : Math.round(yRatio * targetClient.screenWidth),
        y: returnEdge === 'top' ? 40 : returnEdge === 'bottom' ? targetClient.screenHeight - 40 : Math.round(yRatio * targetClient.screenHeight),
      };
      addEvent(`Borda [${edge.toUpperCase()}] atingida -> Controlando "${targetClient.name}"`);
      console.log(`[Servidor] Borda (${edge}) atingida -> Mouse controlando "${targetClient.name}".`);
      dashboard.broadcast();
    }
  });

  capture.on('client_return', (yRatio: number) => {
    if (!controllingClientId) return;
    const c = clients.get(controllingClientId);
    controllingClientId = null;
    if (c) {
      sendToClient(c, { type: 'client_return', yRatio });
    }
    addEvent('Mouse do cliente devolvido.');
    dashboard.broadcast();
  });

  capture.on('pos', (pos: { x: number; y: number }) => {
    if (!activeClientId) {
      cursor = { screen: 'server', x: pos.x, y: pos.y };
      dashboard.broadcast();
    }
  });

  capture.on('input', (packet: Packet) => {
    const activeClient = getActiveClient();
    if (activeClient) {
      if (packet.type === 'move') {
        activeClient.batcher.push(packet.dx, packet.dy);
      } else {
        activeClient.batcher.flush();
        sendToClient(activeClient, packet);
      }
      activeClient.packetCount++;
    }
  });

  capture.on('clipboard', (data: ClipboardData | string) => {
    const payload: Packet = typeof data === 'string'
      ? { type: 'clipboard', format: 'text', text: data }
      : { type: 'clipboard', format: data.format || 'text', text: data.text, image: data.image };
    broadcastPacket(payload);
    addEvent('Área de transferência do Linux sincronizada com os clientes.');
    console.log('[Servidor] Área de transferência enviada para clientes conectados.');
  });

  capture.on('emergency', () => {
    if (!activeClientId) return;
    const active = getActiveClient();
    if (active) {
      active.batcher.cancel();
      sendToClient(active, { type: 'leave' });
    }
    activeClientId = null;
    cursor = { screen: 'server', x: Math.round(serverScreen.width / 2), y: Math.round(serverScreen.height / 2) };
    addEvent('ScrollLock acionado: Controle devolvido de emergência para o Linux.');
    dashboard.broadcast();
  });

  capture.on('exit', (code: number) => {
    console.log(`[Servidor] Captura encerrada (código ${code}). Saindo.`);
    process.exit(code === 3 ? 0 : 1);
  });

  serverScreen = await capture.start();
  cursor = { screen: 'server', x: Math.floor(serverScreen.width / 2), y: Math.floor(serverScreen.height / 2) };
  dashboard.start();

  // Inicia Descoberta Automática de Rede UDP Broadcast
  const discoveryServer = new DiscoveryServer(PORT, os.hostname());
  discoveryServer.start();
  console.log(`[Descoberta] Anunciando presença na rede local (UDP Broadcast porta 5005).`);

  // Intervalos de Telemetria (Ping / Pong e PPS)
  const pingInterval = setInterval(() => {
    const now = Date.now();
    for (const c of clients.values()) {
      if (c.authenticated && !c.socket.destroyed) {
        c.pingSeq++;
        c.lastPingSent = now;
        sendToClient(c, { type: 'ping', seq: c.pingSeq, timestamp: now });
      }
    }
  }, 2000);

  const statsInterval = setInterval(() => {
    for (const c of clients.values()) {
      c.packetsSec = c.packetCount;
      c.packetCount = 0;
    }
    dashboard.broadcast();
  }, 1000);

  const handleConnection = (socket: net.Socket) => {
    const addr = `${socket.remoteAddress?.replace('::ffff:', '')}:${socket.remotePort}`;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 2000);

    const clientKey = `${socket.remoteAddress}_${socket.remotePort}`;
    const assignedEdge = getAvailableEdge(clients, defaultClientEdge);
    const authNonce = generateAuthNonce();

    const session: ConnectedClientSession = {
      id: clientKey,
      socket,
      name: `Cliente (${addr})`,
      address: addr,
      edge: assignedEdge,
      authenticated: false,
      authNonce,
      authTimer: null,
      screenWidth: 1920,
      screenHeight: 1080,
      rttMs: 0,
      lastPingSent: 0,
      pingSeq: 0,
      packetsSec: 0,
      packetCount: 0,
      batcher: new MouseBatcher((dx, dy) => {
        if (!socket.destroyed) socket.write(encodeBinary({ type: 'move', dx, dy }));
      }),
    };

    clients.set(clientKey, session);
    console.log(`[Servidor] Nova conexão de: ${addr}. Enviando desafio de autenticação HMAC...`);
    addEvent(`Conexão de ${addr} (autenticação pendente)`);

    // Timeout de autenticação (3 segundos)
    session.authTimer = setTimeout(() => {
      if (!session.authenticated) {
        console.warn(`[Segurança] Cliente ${addr} não respondeu ao desafio HMAC em 3s. Desconectando.`);
        addEvent(`Tentativa de conexão não autenticada rejeitada: ${addr}`);
        sendToClient(session, { type: 'auth_fail', reason: 'Tempo limite de autenticação esgotado' });
        socket.destroy();
      }
    }, 3000);

    // Envia desafio HMAC-SHA256
    sendToClient(session, { type: 'auth_challenge', nonce: authNonce });

    const reader = new FrameReader(
      (packet) => {
        if (!session.authenticated) {
          if (packet.type === 'client_info') {
            session.screenWidth = Number(packet.width) || session.screenWidth;
            session.screenHeight = Number(packet.height) || session.screenHeight;
            if (packet.name) session.name = packet.name;
            if (packet.id) session.pendingId = packet.id;
            return;
          }
          if (packet.type === 'auth_response') {
            const valid = verifyHmac(SECRET_KEY, session.authNonce, packet.hmac);
            if (valid) {
              session.authenticated = true;
              if (session.authTimer) {
                clearTimeout(session.authTimer);
                session.authTimer = null;
              }
              if (packet.clientName) session.name = packet.clientName;
              const finalId = packet.clientId || session.pendingId || session.id;
              if (finalId !== session.id) {
                const ghost = clients.get(finalId);
                if (ghost && ghost !== session) {
                  // Preserva borda da sessão anterior se reconectando com o mesmo ID
                  session.edge = ghost.edge;
                  ghost.batcher.cancel();
                  if (ghost.authTimer) clearTimeout(ghost.authTimer);
                  clients.delete(finalId);
                  if (!ghost.socket.destroyed) ghost.socket.destroy();
                }
                clients.delete(session.id);
                session.id = finalId;
                clients.set(session.id, session);
              }

              console.log(`[Segurança] Cliente "${session.name}" autenticado com sucesso via HMAC-SHA256!`);
              addEvent(`Cliente "${session.name}" autenticado com sucesso [Borda: ${session.edge.toUpperCase()}]`);

              sendToClient(session, { type: 'auth_success', clientId: session.id, serverName: os.hostname() });
              sendToClient(session, { type: 'config', returnEdge: oppositeEdge(session.edge) });
              dashboard.broadcast();
            } else {
              console.warn(`[Segurança] Falha na autenticação do cliente ${addr}: Chave HMAC inválida.`);
              addEvent(`Falha na autenticação (chave incorreta): ${addr}`);
              sendToClient(session, { type: 'auth_fail', reason: 'Chave HMAC inválida' });
              socket.destroy();
            }
          }
          return;
        }

        // Cliente autenticado - processa pacotes
        if (packet.type === 'pong') {
          session.rttMs = Math.max(0, Math.round(Date.now() - packet.timestamp));
        } else if (packet.type === 'return' || packet.type === 'client_return') {
          backToServer(Number(packet.yRatio ?? 0.5), `borda de "${session.name}"`, session.edge);
        } else if (packet.type === 'client_enter') {
          if (activeClientId) {
            const prev = getActiveClient();
            if (prev) {
              prev.batcher.cancel();
              sendToClient(prev, { type: 'leave' });
            }
            activeClientId = null;
            capture.setRemote(false, 0.5);
          }
          controllingClientId = session.id;
          capture.clientEnter(Number(packet.yRatio ?? 0.5), session.edge);
          console.log(`[Servidor] "${session.name}" assumiu controle do Servidor Linux!`);
          addEvent(`"${session.name}" assumiu controle do Servidor Linux`);
          dashboard.broadcast();
        } else if (packet.type === 'client_leave') {
          if (controllingClientId === session.id) {
            controllingClientId = null;
            capture.clientLeave();
            addEvent(`"${session.name}" devolveu controle`);
            dashboard.broadcast();
          }
        } else if (
          packet.type === 'move' ||
          packet.type === 'button' ||
          packet.type === 'wheel' ||
          packet.type === 'key'
        ) {
          if (controllingClientId === session.id) {
            session.packetCount++;
            capture.injectFromClient(packet);
          }
        } else if (packet.type === 'clipboard') {
          capture.setClipboard(packet);
          broadcastPacket(packet, socket);
          console.log(`[Servidor] Área de transferência recebida de "${session.name}".`);
          addEvent(`Área de transferência sincronizada de "${session.name}"`);
        } else if (packet.type === 'client_info') {
          session.screenWidth = Number(packet.width) || 1920;
          session.screenHeight = Number(packet.height) || 1080;
          if (packet.name) session.name = packet.name;
          dashboard.broadcast();
        } else if (packet.type === 'client_pos') {
          if (activeClientId === session.id) {
            cursor = { screen: session.id, x: Number(packet.x) || 0, y: Number(packet.y) || 0 };
            dashboard.broadcast();
          }
        }
      },
      { maxBufferSize: 10 * 1024 * 1024 }
    );

    socket.on('data', (chunk) => {
      try {
        reader.push(chunk);
      } catch (err) {
        console.error(`[Servidor] Erro de protocolo/overflow com ${addr}:`, (err as Error).message);
        socket.destroy();
      }
    });

    socket.on('error', (err) => {
      console.warn(`[Servidor] Erro no socket (${addr}):`, err.message);
    });

    socket.on('close', () => {
      if (session.authTimer) clearTimeout(session.authTimer);
      session.batcher.cancel();

      if (clients.get(session.id) === session) {
        clients.delete(session.id);
      }
      if (clients.get(clientKey) === session) {
        clients.delete(clientKey);
      }

      if (controllingClientId === session.id && !clients.has(session.id)) {
        controllingClientId = null;
        capture.clientLeave();
      }
      if (activeClientId === session.id && !clients.has(session.id)) {
        backToServer(0.5, `cliente "${session.name}" desconectou`, session.edge);
      }
      console.log(`[Servidor] Cliente desconectado: ${session.name}`);
      addEvent(`Cliente desconectado: ${session.name}`);
      dashboard.broadcast();
    });
  };

  const tlsCreds = getOrCreateTLSCredentials();
  const server = tlsCreds
    ? tls.createServer(tlsCreds, handleConnection)
    : net.createServer(handleConnection);

  server.listen(PORT, () => {
    console.log(`[Servidor] Escutando na porta TCP ${PORT} (${tlsCreds ? 'TLS Seguro' : 'TCP'}).`);
    console.log(`[Servidor] Proteção HMAC ativa com chave Pre-Shared Key (PSK).`);
    console.log(`[Servidor] Dashboard Web: http://localhost:${UI_PORT}`);
  });

  const shutdown = () => {
    clearInterval(pingInterval);
    clearInterval(statsInterval);
    discoveryServer.stop();
    dashboard.stop();
    server.close();
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
