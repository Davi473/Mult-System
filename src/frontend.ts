import http from 'http';
import { Edge } from './protocol';

export interface KVMState {
  clientConnected: boolean;
  clientAddress: string | null;
  remoteActive: boolean;
  clientEdge: Edge;
  mouseSpeed: number;
  mouseAccel: number;
  serverScreen: { width: number; height: number };
  clientScreen: { width: number; height: number };
  cursor: { screen: 'server' | 'client'; x: number; y: number };
}

export interface FrontendHandlers {
  getState: () => KVMState;
  onUpdateConfig: (cfg: { edge?: Edge; speed?: number; accel?: number }) => void;
  onForceSwitch: (toRemote: boolean) => void;
  onCenterCursor: () => void;
}

export class WebDashboard {
  private sseClients = new Set<http.ServerResponse>();

  constructor(private readonly port: number, private readonly handlers: FrontendHandlers) {}

  start(): void {
    const server = http.createServer((req, res) => {
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
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            this.handlers.onUpdateConfig(data);
            this.broadcast();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, state: this.handlers.getState() }));
          } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
          }
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/switch') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            this.handlers.onForceSwitch(Boolean(data.remote));
            this.broadcast();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400);
            res.end();
          }
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/center') {
        this.handlers.onCenterCursor();
        this.broadcast();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML_PAGE);
    });

    server.on('error', (err) => {
      console.error(`[Dashboard] Erro ao iniciar porta ${this.port}:`, err.message);
    });

    server.listen(this.port, '0.0.0.0', () => {
      console.log(`[Dashboard] Painel visual disponível em: http://localhost:${this.port}`);
    });
  }

  broadcast(): void {
    if (this.sseClients.size === 0) return;
    const payload = `data: ${JSON.stringify(this.handlers.getState())}\n\n`;
    for (const client of this.sseClients) {
      client.write(payload);
    }
  }
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mult-System KVM — Configuração Visual de Telas</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --green: #22c55e;
      --amber: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; padding: 24px; }
    .container { max-width: 1060px; margin: 0 auto; display: grid; gap: 20px; }
    header {
      display: flex; justify-content: space-between; align-items: center;
      background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 18px 24px;
    }
    header h1 { font-size: 1.25rem; font-weight: 700; display: flex; align-items: center; gap: 10px; }
    .badges { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .badge {
      padding: 6px 12px; border-radius: 999px; font-size: 0.8rem; font-weight: 600;
      background: #0f172a; border: 1px solid var(--border); display: flex; align-items: center; gap: 6px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .dot.online { background: var(--green); box-shadow: 0 0 8px var(--green); }
    .dot.active { background: var(--accent); box-shadow: 0 0 8px var(--accent); }

    .grid { display: grid; grid-template-columns: 1fr 330px; gap: 20px; }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }

    .card {
      background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 20px;
    }
    .card h2 { font-size: 1rem; margin-bottom: 6px; color: var(--text); }
    .card p.sub { font-size: 0.83rem; color: var(--muted); margin-bottom: 16px; }

    /* Palco de Monitores */
    .stage {
      position: relative; height: 430px; background: #090d16;
      border: 1px dashed var(--border); border-radius: 12px; overflow: hidden;
      user-select: none;
    }
    .snap-zone {
      position: absolute; border: 2px dashed rgba(56, 189, 248, 0.22);
      border-radius: 10px; display: flex; align-items: center; justify-content: center;
      color: rgba(148, 163, 184, 0.45); font-size: 0.78rem; font-weight: 600;
      transition: all 0.15s ease; cursor: pointer;
    }
    .snap-zone:hover, .snap-zone.highlight {
      border-color: var(--accent); background: rgba(56, 189, 248, 0.08); color: var(--accent);
    }

    .monitor {
      position: absolute; width: 184px; height: 108px; border-radius: 10px;
      background: #1e293b; border: 2px solid #475569;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      box-shadow: 0 10px 25px rgba(0,0,0,0.45); transition: box-shadow 0.2s, border-color 0.2s;
    }
    .monitor.active-screen {
      border-color: var(--green);
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.25), 0 12px 30px rgba(0,0,0,0.6);
    }
    .monitor.server { cursor: default; background: linear-gradient(145deg, #1e293b, #0f172a); }
    .monitor.client {
      cursor: grab; background: linear-gradient(145deg, #172554, #0f172a);
      border-color: var(--accent); z-index: 10;
    }
    .monitor.client:active { cursor: grabbing; }
    .monitor .num {
      font-size: 1.5rem; font-weight: 800; color: rgba(255,255,255,0.9); line-height: 1;
    }
    .monitor .title { font-size: 0.8rem; font-weight: 600; margin-top: 4px; }
    .monitor .res { font-size: 0.7rem; color: var(--muted); margin-top: 2px; }

    /* Ponteiro em tempo real dentro da miniatura */
    .cursor-dot {
      position: absolute; width: 10px; height: 10px; border-radius: 50%;
      background: #f43f5e; border: 2px solid #fff;
      box-shadow: 0 0 10px #f43f5e; transform: translate(-50%, -50%);
      pointer-events: none; z-index: 20;
    }

    .controls { display: flex; flex-direction: column; gap: 16px; }
    .edge-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    button {
      background: #0f172a; color: var(--text); border: 1px solid var(--border);
      padding: 10px 12px; border-radius: 8px; font-size: 0.85rem; font-weight: 600;
      cursor: pointer; transition: all 0.15s;
    }
    button:hover { border-color: var(--accent); color: var(--accent); }
    button.active {
      background: rgba(56, 189, 248, 0.15); border-color: var(--accent); color: var(--accent);
    }
    button.primary {
      background: var(--accent); color: #0f172a; border-color: var(--accent);
    }
    button.primary:hover { filter: brightness(1.1); color: #0f172a; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .field label { font-size: 0.82rem; color: var(--muted); display: flex; justify-content: space-between; }
    input[type="range"] { width: 100%; accent-color: var(--accent); }

    .status-box {
      background: #0f172a; border: 1px solid var(--border); border-radius: 10px;
      padding: 12px; font-size: 0.82rem; display: grid; gap: 6px;
    }
    .status-row { display: flex; justify-content: space-between; }
    .status-row span:first-child { color: var(--muted); }
    .kbd {
      background: #1e293b; border: 1px solid #475569; border-radius: 4px;
      padding: 1px 6px; font-family: monospace; font-size: 0.78rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🖥️ Mult-System KVM — Disposição de Telas</h1>
      <div class="badges">
        <div class="badge">
          <span class="dot" id="connDot"></span>
          <span id="connText">Aguardando Cliente...</span>
        </div>
        <div class="badge">
          <span class="dot active"></span>
          <span id="activeScreenText">Tela Ativa: Servidor (Linux)</span>
        </div>
      </div>
    </header>

    <div class="grid">
      <div class="card">
        <h2>Arraste o Monitor 2 (Cliente Windows 11) para posicionar</h2>
        <p class="sub">
          Você pode arrastar o monitor <strong>2 (Cliente)</strong> para a Direita, Esquerda, Acima ou Abaixo do monitor <strong>1 (Servidor)</strong>, ou clicar nas zonas pontilhadas. O ponto vermelho mostra a posição do cursor em tempo real.
        </p>

        <div class="stage" id="stage">
          <div class="snap-zone" id="zone-top" onclick="setEdge('top')">⬆ Acima</div>
          <div class="snap-zone" id="zone-bottom" onclick="setEdge('bottom')">⬇ Abaixo</div>
          <div class="snap-zone" id="zone-left" onclick="setEdge('left')">⬅ Esquerda</div>
          <div class="snap-zone" id="zone-right" onclick="setEdge('right')">Direita ➡</div>

          <div class="monitor server" id="monServer">
            <div class="num">1</div>
            <div class="title">Servidor (Linux)</div>
            <div class="res" id="resServer">1920x1080</div>
            <div class="cursor-dot" id="dotServer"></div>
          </div>

          <div class="monitor client" id="monClient">
            <div class="num">2</div>
            <div class="title">Cliente (Windows 11)</div>
            <div class="res" id="resClient">1920x1080</div>
            <div class="cursor-dot" id="dotClient" style="display:none"></div>
          </div>
        </div>
      </div>

      <div class="card controls">
        <div>
          <h2>Posição do Cliente</h2>
          <p class="sub">Em qual lado do Servidor Linux está o monitor do Windows 11?</p>
          <div class="edge-buttons">
            <button id="btn-left" onclick="setEdge('left')">⬅ À Esquerda</button>
            <button id="btn-right" onclick="setEdge('right')">À Direita ➡</button>
            <button id="btn-top" onclick="setEdge('top')">⬆ Acima</button>
            <button id="btn-bottom" onclick="setEdge('bottom')">⬇ Abaixo</button>
          </div>
        </div>

        <div class="field">
          <label>
            <span>Sensibilidade da Borda (Linux)</span>
            <strong id="speedVal">1.0x</strong>
          </label>
          <input type="range" id="speedRange" min="0.5" max="2.5" step="0.1" value="1.0" onchange="updateSpeed(this.value)" oninput="document.getElementById('speedVal').innerText = this.value + 'x'" />
        </div>

        <div class="status-box">
          <div class="status-row">
            <span>Cursor Atual:</span>
            <strong id="cursorCoords">x: 960, y: 540</strong>
          </div>
          <div class="status-row">
            <span>Cliente IP:</span>
            <strong id="clientIp">—</strong>
          </div>
          <div class="status-row">
            <span>Tecla de Emergência:</span>
            <span><span class="kbd">ScrollLock</span></span>
          </div>
        </div>

        <div style="display:grid; gap:8px; margin-top:auto">
          <button class="primary" onclick="testSwitch()">⚡ Alternar Cursor para o Cliente Agora</button>
          <button onclick="centerCursor()">🎯 Recalibrar / Centralizar Cursor no Linux</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const stage = document.getElementById('stage');
    const monServer = document.getElementById('monServer');
    const monClient = document.getElementById('monClient');
    const dotServer = document.getElementById('dotServer');
    const dotClient = document.getElementById('dotClient');

    const W = 184, H = 108, GAP = 10;
    let currentState = null;
    let dragging = false;
    let dragOffsetX = 0, dragOffsetY = 0;

    function getPositions() {
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
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

    function layoutStage(edge) {
      const pos = getPositions();
      monServer.style.left = pos.server.x + 'px';
      monServer.style.top = pos.server.y + 'px';

      for (const side of ['right', 'left', 'top', 'bottom']) {
        const z = document.getElementById('zone-' + side);
        z.style.left = pos[side].x + 'px';
        z.style.top = pos[side].y + 'px';
        z.style.width = W + 'px';
        z.style.height = H + 'px';
        z.classList.toggle('highlight', side === edge);
        document.getElementById('btn-' + side).classList.toggle('active', side === edge);
      }

      if (!dragging && pos[edge]) {
        monClient.style.left = pos[edge].x + 'px';
        monClient.style.top = pos[edge].y + 'px';
      }
    }

    monClient.addEventListener('pointerdown', (e) => {
      dragging = true;
      monClient.setPointerCapture(e.pointerId);
      const rect = monClient.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
    });

    monClient.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const stageRect = stage.getBoundingClientRect();
      const x = e.clientX - stageRect.left - dragOffsetX;
      const y = e.clientY - stageRect.top - dragOffsetY;
      monClient.style.left = x + 'px';
      monClient.style.top = y + 'px';

      const nearest = findNearestEdge(x, y);
      for (const side of ['right', 'left', 'top', 'bottom']) {
        document.getElementById('zone-' + side).classList.toggle('highlight', side === nearest);
      }
    });

    monClient.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      monClient.releasePointerCapture(e.pointerId);
      const x = parseFloat(monClient.style.left);
      const y = parseFloat(monClient.style.top);
      const nearest = findNearestEdge(x, y);
      setEdge(nearest);
    });

    function findNearestEdge(x, y) {
      const pos = getPositions();
      let best = 'right', bestDist = Infinity;
      for (const side of ['right', 'left', 'top', 'bottom']) {
        const d = Math.hypot(x - pos[side].x, y - pos[side].y);
        if (d < bestDist) { bestDist = d; best = side; }
      }
      return best;
    }

    async function setEdge(edge) {
      layoutStage(edge);
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edge }),
      });
    }

    async function updateSpeed(speed) {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speed: Number(speed) }),
      });
    }

    async function testSwitch() {
      const nextRemote = !(currentState && currentState.remoteActive);
      await fetch('/api/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote: nextRemote }),
      });
    }

    async function centerCursor() {
      await fetch('/api/center', { method: 'POST' });
    }

    function render(state) {
      currentState = state;
      layoutStage(state.clientEdge);

      const connDot = document.getElementById('connDot');
      const connText = document.getElementById('connText');
      connDot.className = 'dot ' + (state.clientConnected ? 'online' : '');
      connText.innerText = state.clientConnected ? 'Cliente Conectado' : 'Aguardando Cliente...';
      document.getElementById('clientIp').innerText = state.clientAddress || 'Desconectado';

      document.getElementById('resServer').innerText = state.serverScreen.width + 'x' + state.serverScreen.height;
      document.getElementById('resClient').innerText = state.clientScreen.width + 'x' + state.clientScreen.height;

      monServer.classList.toggle('active-screen', !state.remoteActive);
      monClient.classList.toggle('active-screen', state.remoteActive);
      document.getElementById('activeScreenText').innerText =
        state.remoteActive ? 'Tela Ativa: Cliente (Windows 11)' : 'Tela Ativa: Servidor (Linux)';

      document.getElementById('speedRange').value = state.mouseSpeed;
      document.getElementById('speedVal').innerText = state.mouseSpeed + 'x';

      const c = state.cursor;
      document.getElementById('cursorCoords').innerText =
        (c.screen === 'client' ? '[Win] ' : '[Linux] ') + 'x: ' + Math.round(c.x) + ', y: ' + Math.round(c.y);

      if (c.screen === 'server') {
        dotServer.style.display = 'block';
        dotClient.style.display = 'none';
        dotServer.style.left = ((c.x / Math.max(1, state.serverScreen.width)) * 100) + '%';
        dotServer.style.top = ((c.y / Math.max(1, state.serverScreen.height)) * 100) + '%';
      } else {
        dotServer.style.display = 'none';
        dotClient.style.display = 'block';
        dotClient.style.left = ((c.x / Math.max(1, state.clientScreen.width)) * 100) + '%';
        dotClient.style.top = ((c.y / Math.max(1, state.clientScreen.height)) * 100) + '%';
      }
    }

    window.addEventListener('resize', () => currentState && layoutStage(currentState.clientEdge));
    layoutStage('right');

    const es = new EventSource('/api/events');
    es.onmessage = (ev) => render(JSON.parse(ev.data));
  </script>
</body>
</html>
`;
