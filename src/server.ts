import net from 'net';
import { uIOhook } from 'uiohook-napi';
import { mouse, screen, Point } from '@nut-tree-fork/nut-js';
import { KVMPacket, serializePacket, loadEnv } from './protocol';
import { LinuxEvdevServer } from './linuxInput';

loadEnv();

const PORT = Number(process.env.KVM_PORT) || 5000;
// Define em qual borda do Servidor o monitor do Cliente está posicionado ('right' ou 'left')
const CLIENT_EDGE: 'right' | 'left' = (process.env.CLIENT_EDGE as 'right' | 'left') || 'right';

class KVMServer {
  private clientSocket: net.Socket | null = null;
  private isRemoteActive = false;
  private screenWidth = 1920;
  private screenHeight = 1080;
  private anchorX = 960;
  private anchorY = 540;
  private isWarpingPointer = false;
  private linuxEvdev: LinuxEvdevServer | null = null;

  async start() {
    mouse.config.autoDelayMs = 0;

    try {
      this.screenWidth = await screen.width();
      this.screenHeight = await screen.height();
    } catch {
      this.screenWidth = 1920;
      this.screenHeight = 1080;
    }
    this.anchorX = Math.floor(this.screenWidth / 2);
    this.anchorY = Math.floor(this.screenHeight / 2);

    console.log(`[Servidor] Resolução detectada: ${this.screenWidth}x${this.screenHeight}`);
    console.log(`[Servidor] Borda configurada para transição ao Cliente: ${CLIENT_EDGE.toUpperCase()}`);

    this.setupTcpServer();

    if (process.platform === 'linux') {
      this.setupLinuxEvdevHooks();
    } else {
      this.setupGlobalHooks();
    }
  }

  private setupTcpServer() {
    const server = net.createServer((socket) => {
      console.log(`[Servidor] Cliente conectado: ${socket.remoteAddress}:${socket.remotePort}`);
      socket.setNoDelay(true);
      this.clientSocket = socket;

      let buffer = '';
      socket.on('data', async (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const packet: KVMPacket = JSON.parse(line);
            await this.handleClientPacket(packet);
          } catch (err) {
            console.error('[Servidor] Erro ao decodificar pacote do cliente:', err);
          }
        }
      });

      socket.on('close', () => {
        console.log('[Servidor] Cliente desconectado.');
        this.clientSocket = null;
        this.isRemoteActive = false;
        this.linuxEvdev?.ungrab(this.anchorX, this.anchorY);
      });

      socket.on('error', (err) => {
        console.error('[Servidor] Erro no socket:', err.message);
      });
    });

    server.listen(PORT, () => {
      console.log(`[Servidor] Escutando conexões TCP na porta ${PORT} (IPv4 e IPv6)...`);
    });
  }

  private sendToClient(packet: KVMPacket) {
    if (this.clientSocket && !this.clientSocket.destroyed) {
      this.clientSocket.write(serializePacket(packet));
    }
  }

  private async handleClientPacket(packet: KVMPacket) {
    if (packet.type === 'return_server') {
      this.isRemoteActive = false;
      const targetY = Math.min(
        this.screenHeight - 2,
        Math.max(2, Math.floor(packet.yRatio * this.screenHeight))
      );
      const targetX = CLIENT_EDGE === 'right' ? this.screenWidth - 10 : 10;

      if (this.linuxEvdev) {
        this.linuxEvdev.ungrab(targetX, targetY);
      } else {
        this.isWarpingPointer = true;
        await mouse.setPosition(new Point(targetX, targetY));
        this.isWarpingPointer = false;
      }

      console.log('[Servidor] Controle devolvido ao Servidor.');
    }
  }

  private setupLinuxEvdevHooks() {
    this.linuxEvdev = new LinuxEvdevServer(this.screenWidth, this.screenHeight, CLIENT_EDGE);
    const started = this.linuxEvdev.start();
    if (!started) {
      console.log('[Servidor] Usando fallback uIOhook...');
      this.setupGlobalHooks();
      return;
    }

    console.log(
      '[Servidor] Captura evdev ativa (compatível com Wayland e X11). Pressione ScrollLock a qualquer momento para destravar o mouse.'
    );

    this.linuxEvdev.on('event', (evt) => {
      if (!this.clientSocket) return;

      if (evt.type === 'edge_hit' && !this.isRemoteActive) {
        this.isRemoteActive = true;
        this.linuxEvdev?.grab();
        console.log('[Servidor] Borda atingida! Transferindo controle para o Cliente...');
        this.sendToClient({ type: 'enter_client', yRatio: evt.yRatio });
        return;
      }

      if (evt.type === 'emergency_release') {
        this.isRemoteActive = false;
        console.log('[Servidor] ScrollLock pressionado! Controle retomado no Servidor.');
        return;
      }

      if (this.isRemoteActive) {
        this.sendToClient(evt as KVMPacket);
      }
    });
  }

  private setupGlobalHooks() {
    uIOhook.on('mousemove', async (e) => {
      if (!this.clientSocket || this.isWarpingPointer) return;

      if (!this.isRemoteActive) {
        const hitRightEdge = CLIENT_EDGE === 'right' && e.x >= this.screenWidth - 1;
        const hitLeftEdge = CLIENT_EDGE === 'left' && e.x <= 0;

        if (hitRightEdge || hitLeftEdge) {
          this.isRemoteActive = true;
          const yRatio = e.y / this.screenHeight;

          console.log('[Servidor] Borda atingida! Transferindo controle para o Cliente...');
          this.sendToClient({ type: 'enter_client', yRatio });

          this.isWarpingPointer = true;
          await mouse.setPosition(new Point(this.anchorX, this.anchorY));
          this.isWarpingPointer = false;
        }
      } else {
        const dx = e.x - this.anchorX;
        const dy = e.y - this.anchorY;

        if (dx !== 0 || dy !== 0) {
          this.sendToClient({ type: 'mousemove', dx, dy });

          this.isWarpingPointer = true;
          await mouse.setPosition(new Point(this.anchorX, this.anchorY));
          this.isWarpingPointer = false;
        }
      }
    });

    uIOhook.on('mousedown', (e) => {
      if (!this.isRemoteActive) return;
      this.sendToClient({ type: 'mousedown', button: Number(e.button) });
    });

    uIOhook.on('mouseup', (e) => {
      if (!this.isRemoteActive) return;
      this.sendToClient({ type: 'mouseup', button: Number(e.button) });
    });

    uIOhook.on('wheel', (e) => {
      if (!this.isRemoteActive) return;
      this.sendToClient({
        type: 'wheel',
        amount: e.amount,
        direction: e.direction,
      });
    });

    uIOhook.on('keydown', (e) => {
      if (!this.isRemoteActive) return;
      this.sendToClient({ type: 'keydown', keycode: e.keycode });
    });

    uIOhook.on('keyup', (e) => {
      if (!this.isRemoteActive) return;
      this.sendToClient({ type: 'keyup', keycode: e.keycode });
    });

    uIOhook.start();
    console.log('[Servidor] Hooks globais de mouse e teclado iniciados.');
  }
}

new KVMServer().start().catch(console.error);
