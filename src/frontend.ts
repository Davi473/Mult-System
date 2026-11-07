import http from 'http';
import { Edge } from './protocol';

export interface ClientInfo {
  id: string;
  name: string;
  address: string;
  edge: Edge;
  authenticated: boolean;
  screen: { width: number; height: number };
  rttMs: number;
  packetsSec: number;
  active: boolean;
}

export interface KVMState {
  clientConnected: boolean;
  clientAddress: string | null;
  remoteActive: boolean;
  clientEdge: Edge;
  mouseSpeed: number;
  mouseAccel: number;
  serverScreen: { width: number; height: number };
  clientScreen: { width: number; height: number };
  cursor: { screen: string; x: number; y: number };
  clients: ClientInfo[];
  security: {
    tlsEnabled: boolean;
    authRequired: boolean;
  };
  stats: {
    totalPacketsSec: number;
    uptimeSeconds: number;
  };
  events: string[];
}

export interface FrontendHandlers {
  getState: () => KVMState;
  onUpdateConfig: (cfg: { edge?: Edge; clientId?: string; speed?: number; accel?: number }) => void;
  onForceSwitch: (toRemote: boolean, targetClientId?: string) => void;
  onCenterCursor: () => void;
}

export class WebDashboard {
  private sseClients = new Set<http.ServerResponse>();
  private server: http.Server | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private lastBroadcastMs = 0;

  constructor(private readonly port: number, private readonly handlers: FrontendHandlers) {}

  private readJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) {
          req.destroy();
          reject(new Error('Payload muito grande'));
        }
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  start(): void {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(this.handlers.getState())}\n\n`);
        this.sseClients.add(res);
        req.on('close', () => this.sseClients.delete(res));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/config') {
        try {
          const data = await this.readJsonBody(req);
          this.handlers.onUpdateConfig(data);
          this.flushBroadcast();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, state: this.handlers.getState() }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/switch') {
        try {
          const data = await this.readJsonBody(req);
          this.handlers.onForceSwitch(Boolean(data.remote), data.clientId);
          this.flushBroadcast();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/center') {
        this.handlers.onCenterCursor();
        this.flushBroadcast();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML_PAGE);
    });

    this.server = server;

    server.on('error', (err) => {
      console.error(`[Dashboard] Erro ao iniciar porta ${this.port}:`, err.message);
    });

    server.listen(this.port, '0.0.0.0', () => {
      console.log(`[Dashboard] Painel visual disponível em: http://localhost:${this.port}`);
    });
  }

  private flushBroadcast(): void {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.lastBroadcastMs = Date.now();
    if (this.sseClients.size === 0) return;
    const payload = `data: ${JSON.stringify(this.handlers.getState())}\n\n`;
    for (const client of this.sseClients) {
      client.write(payload);
    }
  }

  broadcast(): void {
    if (this.sseClients.size === 0) return;
    const elapsed = Date.now() - this.lastBroadcastMs;
    if (elapsed >= 30) {
      this.flushBroadcast();
    } else if (!this.broadcastTimer) {
      this.broadcastTimer = setTimeout(() => this.flushBroadcast(), 30 - elapsed);
      this.broadcastTimer.unref?.();
    }
  }

  stop(): void {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {}
    }
    this.sseClients.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }
  }
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mult-System KVM — Painel de Controle Multi-Dispositivos</title>
  <style>
    :root {
      --bg: #0b0f19;
      --panel: #131d31;
      --panel-hover: #1b2842;
      --border: #24344d;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --green: #22c55e;
      --amber: #f59e0b;
      --danger: #ef4444;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; display: grid; gap: 18px; }
    
    header {
      display: flex; justify-content: space-between; align-items: center;
      background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 16px 22px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    header h1 { font-size: 1.25rem; font-weight: 700; display: flex; align-items: center; gap: 10px; }
    .badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .badge {
      padding: 5px 12px; border-radius: 999px; font-size: 0.78rem; font-weight: 600;
      background: #090e17; border: 1px solid var(--border); display: flex; align-items: center; gap: 6px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .dot.online { background: var(--green); box-shadow: 0 0 8px var(--green); }
    .dot.active { background: var(--accent); box-shadow: 0 0 8px var(--accent); }

    .metrics-row {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px;
    }
    .metric-card {
      background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px;
      display: flex; flex-direction: column; gap: 4px;
    }
    .metric-title { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; font-weight: 600; }
    .metric-value { font-size: 1.35rem; font-weight: 800; color: var(--text); display: flex; align-items: center; gap: 8px; }

    .grid { display: grid; grid-template-columns: 1fr 340px; gap: 18px; }
    @media (max-width: 960px) { .grid { grid-template-columns: 1fr; } }

    .card {
      background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 20px;
    }
    .card h2 { font-size: 1rem; margin-bottom: 6px; color: var(--text); display: flex; align-items: center; justify-content: space-between; }
    .card p.sub { font-size: 0.82rem; color: var(--muted); margin-bottom: 14px; }

    /* Palco de Monitores */
    .stage {
      position: relative; height: 420px; background: #070a12;
      border: 1px dashed var(--border); border-radius: 12px; overflow: hidden;
      user-select: none;
    }
    .snap-zone {
      position: absolute; border: 2px dashed rgba(56, 189, 248, 0.25);
      border-radius: 10px; display: flex; align-items: center; justify-content: center;
      color: rgba(148, 163, 184, 0.5); font-size: 0.78rem; font-weight: 600;
      transition: all 0.15s ease; cursor: pointer;
    }
    .snap-zone:hover, .snap-zone.highlight {
      border-color: var(--accent); background: rgba(56, 189, 248, 0.1); color: var(--accent);
    }

    .monitor {
      position: absolute; width: 180px; height: 105px; border-radius: 10px;
      background: #192338; border: 2px solid #3b4e6d;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5); transition: box-shadow 0.2s, border-color 0.2s;
    }
    .monitor.server {
      cursor: default; background: linear-gradient(145deg, #1e293b, #0f172a);
      border-color: #475569; z-index: 5;
    }
    .monitor.client-tile {
      cursor: grab; background: linear-gradient(145deg, #14244d, #0b152d);
      border-color: var(--accent); z-index: 10;
    }
    .monitor.client-tile:active { cursor: grabbing; }
    .monitor.active-screen {
      border-color: var(--green);
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.3), 0 12px 30px rgba(0,0,0,0.6);
    }
    .monitor .num { font-size: 1.4rem; font-weight: 800; color: rgba(255,255,255,0.9); line-height: 1; }
    .monitor .title { font-size: 0.78rem; font-weight: 600; margin-top: 4px; text-align: center; max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .monitor .res { font-size: 0.68rem; color: var(--muted); margin-top: 2px; }
    .monitor .ping-pill {
      position: absolute; bottom: 6px; right: 6px; font-size: 0.65rem; font-weight: 700;
      padding: 1px 5px; border-radius: 999px; background: rgba(0,0,0,0.6); color: var(--green);
    }

    .cursor-dot {
      position: absolute; width: 10px; height: 10px; border-radius: 50%;
      background: #f43f5e; border: 2px solid #fff;
      box-shadow: 0 0 10px #f43f5e; transform: translate(-50%, -50%);
      pointer-events: none; z-index: 30;
    }

    .controls { display: flex; flex-direction: column; gap: 14px; }
    button {
      background: #090e17; color: var(--text); border: 1px solid var(--border);
      padding: 9px 12px; border-radius: 8px; font-size: 0.82rem; font-weight: 600;
      cursor: pointer; transition: all 0.15s;
    }
    button:hover { border-color: var(--accent); color: var(--accent); }
    button.primary { background: var(--accent); color: #090e17; border-color: var(--accent); }
    button.primary:hover { filter: brightness(1.1); color: #090e17; }

    .client-list { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
    .client-row {
      background: #090e17; border: 1px solid var(--border); border-radius: 8px; padding: 10px;
      display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem;
    }
    .client-row-info { display: flex; flex-direction: column; gap: 2px; }
    .client-row-name { font-weight: 700; color: var(--text); }
    .client-row-sub { font-size: 0.72rem; color: var(--muted); }

    .events-log {
      height: 110px; overflow-y: auto; background: #070a12; border: 1px solid var(--border);
      border-radius: 8px; padding: 8px; font-family: monospace; font-size: 0.72rem; color: #94a3b8;
      display: flex; flex-direction: column; gap: 4px;
    }
    .events-log div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .field label { font-size: 0.8rem; color: var(--muted); display: flex; justify-content: space-between; }
    input[type="range"] { width: 100%; accent-color: var(--accent); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🖥️ Mult-System KVM — Multi-Dispositivos</h1>
      <div class="badges">
        <div class="badge">
          <span class="dot" id="secDot"></span>
          <span id="secText">HMAC PSK Ativo</span>
        </div>
        <div class="badge">
          <span class="dot" id="connDot"></span>
          <span id="connText">0 Clientes Conectados</span>
        </div>
        <div class="badge">
          <span class="dot active"></span>
          <span id="activeScreenText">Servidor (Linux)</span>
        </div>
      </div>
    </header>

    <div class="metrics-row">
      <div class="metric-card">
        <div class="metric-title">Latência (RTT)</div>
        <div class="metric-value" id="valLatency">0 ms</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Taxa de Pacotes (Mouse PPS)</div>
        <div class="metric-value" id="valPps">0 p/s</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Dispositivos Conectados</div>
        <div class="metric-value" id="valClients">0</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Criptografia / Protocolo</div>
        <div class="metric-value" id="valProtocol" style="font-size: 1rem;">Binário Compacto</div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>
          <span>Topologia de Monitores (Arraste os Clientes)</span>
          <span style="font-size: 0.75rem; color: var(--muted); font-weight: normal;">Arraste para Esquerda, Direita, Cima ou Baixo</span>
        </h2>
        <p class="sub">
          O Servidor Linux fica no centro. Arraste qualquer cliente conectado para posicioná-lo ao redor da tela central. O ponto vermelho mostra o cursor em tempo real.
        </p>

        <div class="stage" id="stage">
          <div class="snap-zone" id="zone-top" onclick="setFirstClientEdge('top')">⬆ Acima</div>
          <div class="snap-zone" id="zone-bottom" onclick="setFirstClientEdge('bottom')">⬇ Abaixo</div>
          <div class="snap-zone" id="zone-left" onclick="setFirstClientEdge('left')">⬅ Esquerda</div>
          <div class="snap-zone" id="zone-right" onclick="setFirstClientEdge('right')">Direita ➡</div>

          <div class="monitor server" id="monServer">
            <div class="num">1</div>
            <div class="title">Servidor (Linux)</div>
            <div class="res" id="resServer">1920x1080</div>
            <div class="cursor-dot" id="dotServer"></div>
          </div>

          <!-- Clientes renderizados dinamicamente -->
          <div id="clientsContainer"></div>
        </div>

        <div style="margin-top: 14px;">
          <h2 style="font-size: 0.88rem; margin-bottom: 6px;">Histórico de Eventos em Tempo Real</h2>
          <div class="events-log" id="eventsLog">
            <div>[KVM] Servidor iniciado e pronto para conexões.</div>
          </div>
        </div>
      </div>

      <div class="card controls">
        <div>
          <h2>Dispositivos Conectados</h2>
          <div class="client-list" id="clientList">
            <div style="font-size: 0.8rem; color: var(--muted); padding: 8px 0;">Nenhum cliente conectado no momento. Inicie o cliente no Windows ou outro Linux.</div>
          </div>
        </div>

        <div class="field">
          <label>
            <span>Sensibilidade da Borda (Linux)</span>
            <strong id="speedVal">1.0x</strong>
          </label>
          <input type="range" id="speedRange" min="0.5" max="2.5" step="0.1" value="1.0" onchange="updateSpeed(this.value)" oninput="document.getElementById('speedVal').innerText = this.value + 'x'" />
        </div>

        <div style="display:grid; gap:8px; margin-top:auto">
          <button class="primary" onclick="testSwitch()">⚡ Alternar Cursor para o Cliente Ativo</button>
          <button onclick="centerCursor()">🎯 Centralizar / Recalibrar Cursor no Linux</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const stage = document.getElementById('stage');
    const monServer = document.getElementById('monServer');
    const dotServer = document.getElementById('dotServer');
    const clientsContainer = document.getElementById('clientsContainer');
    const clientList = document.getElementById('clientList');
    const eventsLog = document.getElementById('eventsLog');

    const W = 180, H = 105, GAP = 10;
    let currentState = null;
    let draggingClientId = null;
    let dragOffsetX = 0, dragOffsetY = 0;

    function getPositions() {
      const sw = stage.clientWidth || 700;
      const sh = stage.clientHeight || 420;
      const sx = Math.round((sw - W) / 2);
      const sy = Math.round((sh - H) / 2);
      return {
        server: { x: sx, y: sy },
        right:  { x: sx + W + GAP, y: sy },
        left:   { x: sx - W - GAP, y: sy },
        top:    { x: sx, y: sy - H - GAP },
        bottom: { x: sx, y: sy + H + GAP },
      };
    }

    function layoutStage() {
      const pos = getPositions();
      monServer.style.left = pos.server.x + 'px';
      monServer.style.top = pos.server.y + 'px';

      for (const side of ['right', 'left', 'top', 'bottom']) {
        const z = document.getElementById('zone-' + side);
        if (z && pos[side]) {
          z.style.left = pos[side].x + 'px';
          z.style.top = pos[side].y + 'px';
          z.style.width = W + 'px';
          z.style.height = H + 'px';
        }
      }
    }

    async function setClientEdge(clientId, edge) {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, edge }),
      });
    }

    async function setFirstClientEdge(edge) {
      if (currentState && currentState.clients.length > 0) {
        setClientEdge(currentState.clients[0].id, edge);
      } else {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ edge }),
        });
      }
    }

    async function updateSpeed(speed) {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speed: Number(speed) }),
      });
    }

    async function testSwitch(clientId) {
      const nextRemote = !(currentState && currentState.remoteActive);
      await fetch('/api/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote: nextRemote, clientId }),
      });
    }

    async function centerCursor() {
      await fetch('/api/center', { method: 'POST' });
    }

    function findNearestEdge(x, y) {
      const pos = getPositions();
      let best = 'right', bestDist = Infinity;
      for (const side of ['right', 'left', 'top', 'bottom']) {
        const d = Math.hypot(x - pos[side].x, y - pos[side].y);
        if (d < bestDist) { bestDist = d; best = side; }
      }
      return best;
    }

    function escapeHtml(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    let lastClientsTopologyKey = '';
    let lastEventsKey = '';

    function render(state) {
      currentState = state;
      layoutStage();

      // Atualiza métricas
      const activeClient = state.clients.find(c => c.active) || state.clients[0];
      document.getElementById('valLatency').innerText = (activeClient ? activeClient.rttMs : 0) + ' ms';
      document.getElementById('valPps').innerText = state.stats.totalPacketsSec + ' p/s';
      document.getElementById('valClients').innerText = state.clients.length;
      document.getElementById('valProtocol').innerText = state.security.tlsEnabled ? 'TLS + Binário' : 'HMAC + Binário';

      document.getElementById('connDot').className = 'dot ' + (state.clientConnected ? 'online' : '');
      document.getElementById('connText').innerText = state.clients.length + (state.clients.length === 1 ? ' Cliente Conectado' : ' Clientes Conectados');
      document.getElementById('secDot').className = 'dot ' + (state.security.authRequired ? 'online' : '');

      monServer.classList.toggle('active-screen', !state.remoteActive);
      document.getElementById('activeScreenText').innerText = state.remoteActive && activeClient
        ? 'Ativo: ' + activeClient.name
        : 'Ativo: Servidor (Linux)';

      document.getElementById('resServer').innerText = state.serverScreen.width + 'x' + state.serverScreen.height;
      document.getElementById('speedRange').value = state.mouseSpeed;
      document.getElementById('speedVal').innerText = state.mouseSpeed + 'x';

      // Posiciona cursor no Servidor
      const c = state.cursor;
      if (c.screen === 'server') {
        dotServer.style.display = 'block';
        dotServer.style.left = ((c.x / Math.max(1, state.serverScreen.width)) * 100) + '%';
        dotServer.style.top = ((c.y / Math.max(1, state.serverScreen.height)) * 100) + '%';
      } else {
        dotServer.style.display = 'none';
      }

      const pos = getPositions();
      const topologyKey = state.clients.map(cl => [cl.id, cl.name, cl.edge, cl.active, cl.screen.width, cl.screen.height].join(':')).join('|');

      // Só reconstrói o DOM dos clientes quando a lista/topologia muda (e não durante arrasto),
      // evitando destruir elementos durante cliques ou drag-and-drop!
      if (topologyKey !== lastClientsTopologyKey && !draggingClientId) {
        lastClientsTopologyKey = topologyKey;
        clientsContainer.innerHTML = '';

        state.clients.forEach((client, idx) => {
          const mon = document.createElement('div');
          mon.className = 'monitor client-tile' + (client.active ? ' active-screen' : '');
          mon.dataset.clientId = client.id;

          const p = pos[client.edge] || pos.right;
          mon.style.left = p.x + 'px';
          mon.style.top = p.y + 'px';

          mon.innerHTML = \`
            <div class="num">\${idx + 2}</div>
            <div class="title" title="\${escapeHtml(client.name)}">\${escapeHtml(client.name)}</div>
            <div class="res">\${client.screen.width}x\${client.screen.height} [\${escapeHtml(client.edge.toUpperCase())}]</div>
            <div class="ping-pill" data-ping-for="\${escapeHtml(client.id)}">\${client.rttMs}ms</div>
            <div class="cursor-dot" data-dot-for="\${escapeHtml(client.id)}" style="display:none"></div>
          \`;

          // Drag and Drop
          mon.addEventListener('pointerdown', (e) => {
            draggingClientId = client.id;
            mon.setPointerCapture(e.pointerId);
            const rect = mon.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
          });

          mon.addEventListener('pointermove', (e) => {
            if (draggingClientId !== client.id) return;
            const stageRect = stage.getBoundingClientRect();
            const x = e.clientX - stageRect.left - dragOffsetX;
            const y = e.clientY - stageRect.top - dragOffsetY;
            mon.style.left = x + 'px';
            mon.style.top = y + 'px';

            const nearest = findNearestEdge(x, y);
            for (const side of ['right', 'left', 'top', 'bottom']) {
              document.getElementById('zone-' + side).classList.toggle('highlight', side === nearest);
            }
          });

          mon.addEventListener('pointerup', (e) => {
            if (draggingClientId !== client.id) return;
            draggingClientId = null;
            mon.releasePointerCapture(e.pointerId);
            for (const side of ['right', 'left', 'top', 'bottom']) {
              document.getElementById('zone-' + side).classList.remove('highlight');
            }
            const x = parseFloat(mon.style.left);
            const y = parseFloat(mon.style.top);
            const nearest = findNearestEdge(x, y);
            lastClientsTopologyKey = '';
            setClientEdge(client.id, nearest);
          });

          clientsContainer.appendChild(mon);
        });

        // Renderiza lista lateral de clientes
        if (state.clients.length === 0) {
          clientList.innerHTML = '<div style="font-size: 0.8rem; color: var(--muted); padding: 8px 0;">Nenhum cliente conectado no momento.</div>';
        } else {
          clientList.innerHTML = '';
          state.clients.forEach((client) => {
            const row = document.createElement('div');
            row.className = 'client-row';
            row.innerHTML = \`
              <div class="client-row-info">
                <div class="client-row-name">\${escapeHtml(client.name)}</div>
                <div class="client-row-sub" data-sub-for="\${escapeHtml(client.id)}">\${escapeHtml(client.address)} • Borda: <strong>\${escapeHtml(client.edge.toUpperCase())}</strong> • \${client.rttMs}ms</div>
              </div>
            \`;
            const btn = document.createElement('button');
            btn.textContent = client.active ? 'Devolver' : 'Assumir';
            btn.addEventListener('click', () => testSwitch(client.id));
            row.appendChild(btn);
            clientList.appendChild(row);
          });
        }
      }

      // Atualiza in-place posição de cursor, ping e coordenadas (sem recriar DOM)
      state.clients.forEach((client) => {
        const mon = clientsContainer.querySelector(\`[data-client-id="\${CSS.escape(client.id)}"]\`);
        if (mon && draggingClientId !== client.id) {
          const p = pos[client.edge] || pos.right;
          mon.style.left = p.x + 'px';
          mon.style.top = p.y + 'px';
        }
        const pingEl = clientsContainer.querySelector(\`[data-ping-for="\${CSS.escape(client.id)}"]\`);
        if (pingEl) pingEl.textContent = client.rttMs + 'ms';

        const subEl = clientList.querySelector(\`[data-sub-for="\${CSS.escape(client.id)}"]\`);
        if (subEl) {
          subEl.innerHTML = \`\${escapeHtml(client.address)} • Borda: <strong>\${escapeHtml(client.edge.toUpperCase())}</strong> • \${client.rttMs}ms\`;
        }

        const dot = clientsContainer.querySelector(\`[data-dot-for="\${CSS.escape(client.id)}"]\`);
        if (dot) {
          if (c.screen === client.id) {
            dot.style.display = 'block';
            dot.style.left = ((c.x / Math.max(1, client.screen.width)) * 100) + '%';
            dot.style.top = ((c.y / Math.max(1, client.screen.height)) * 100) + '%';
          } else {
            dot.style.display = 'none';
          }
        }
      });

      // Atualiza log de eventos apenas quando houver mudança
      if (state.events && state.events.length > 0) {
        const eventsKey = state.events[0] + ':' + state.events.length;
        if (eventsKey !== lastEventsKey) {
          lastEventsKey = eventsKey;
          eventsLog.innerHTML = state.events.slice(0, 15).map(ev => \`<div>\${escapeHtml(ev)}</div>\`).join('');
        }
      }
    }

    window.addEventListener('resize', () => layoutStage());
    layoutStage();

    const es = new EventSource('/api/events');
    es.onmessage = (ev) => render(JSON.parse(ev.data));
  </script>
</body>
</html>
`;
