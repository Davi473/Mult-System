import net from 'net';
import { uIOhook } from 'uiohook-napi';
import { mouse, screen, Point } from '@nut-tree-fork/nut-js';
import { KVMPacket, serializePacket, loadEnv } from './protocol';

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

  async start() {
    mouse.config.autoDelayMs = 0;

    this.screenWidth = await screen.width();
    this.screenHeight = await screen.height();
    this.anchorX = Math.floor(this.screenWidth / 2);
    this.anchorY = Math.floor(this.screenHeight / 2);

    console.log(`[Servidor] Resolução detectada: ${this.screenWidth}x${this.screenHeight}`);
    console.log(`[Servidor] Borda configurada para transição ao Cliente: ${CLIENT_EDGE.toUpperCase()}`);

    this.setupTcpServer();
    this.setupGlobalHooks();
  }

  private setupTcpServer() {
    const server = net.createServer((socket) => {
      console.log(`[Servidor] Cliente conectado: ${socket.remoteAddress}:${socket.remotePort}`);
      socket.setNoDelay(true); // Desativa algoritmo de Nagle para menor latência
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
      const targetX = CLIENT_EDGE === 'right' ? this.screenWidth - 5 : 5;

      this.isWarpingPointer = true;
      await mouse.setPosition(new Point(targetX, targetY));
      this.isWarpingPointer = false;

      console.log('[Servidor] Controle devolvido ao Servidor.');
    }
  }

  private setupGlobalHooks() {
    uIOhook.on('mousemove', async (e) => {
      if (!this.clientSocket || this.isWarpingPointer) return;

      if (!this.isRemoteActive) {
        // Detecção de borda no Servidor
        const hitRightEdge = CLIENT_EDGE === 'right' && e.x >= this.screenWidth - 1;
        const hitLeftEdge = CLIENT_EDGE === 'left' && e.x <= 0;

        if (hitRightEdge || hitLeftEdge) {
          this.isRemoteActive = true;
          const yRatio = e.y / this.screenHeight;

          console.log('[Servidor] Borda atingida! Transferindo controle para o Cliente...');
          this.sendToClient({ type: 'enter_client', yRatio });

          // Ancora o cursor no centro da tela do Servidor para calcular deltas (dx, dy) contínuos
          this.isWarpingPointer = true;
          await mouse.setPosition(new Point(this.anchorX, this.anchorY));
          this.isWarpingPointer = false;
        }
      } else {
        // Modo Remoto Ativo: calcula movimento relativo em relação à âncora
        const dx = e.x - this.anchorX;
        const dy = e.y - this.anchorY;

        if (dx !== 0 || dy !== 0) {
          this.sendToClient({ type: 'mousemove', dx, dy });

          // Reposiciona o cursor físico na âncora para impedir que trave nas bordas locais
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
