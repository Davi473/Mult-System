import net from 'net';
import { mouse, keyboard, screen, Button, Point } from '@nut-tree-fork/nut-js';
import { KVMPacket, serializePacket, UIOHOOK_TO_NUT_KEY, loadEnv } from './protocol';
import { LinuxUinputClient } from './linuxInput';

loadEnv();

const SERVER_HOST = process.argv[2] || process.env.SERVER_HOST || 'servidor';
const SERVER_PORT = Number(process.env.KVM_PORT) || 5000;
// Se o Cliente está à direita do Servidor, a borda de retorno ao Servidor é a esquerda ('left')
const RETURN_EDGE: 'left' | 'right' = (process.env.RETURN_EDGE as 'left' | 'right') || 'left';

const FALLBACK_HOSTS = Array.from(
  new Set([
    SERVER_HOST,
    SERVER_HOST.endsWith('.local') ? SERVER_HOST : `${SERVER_HOST}.local`,
    '192.168.1.15',
    '192.168.1.14',
  ])
);

class KVMClient {
  private socket: net.Socket | null = null;
  private isActive = false;
  private screenWidth = 1920;
  private screenHeight = 1080;
  private cursorX = 960;
  private cursorY = 540;
  private hostIndex = 0;
  private linuxUinput: LinuxUinputClient | null = null;

  async start() {
    mouse.config.autoDelayMs = 0;
    keyboard.config.autoDelayMs = 0;

    try {
      this.screenWidth = await screen.width();
      this.screenHeight = await screen.height();
    } catch {
      this.screenWidth = 1920;
      this.screenHeight = 1080;
    }

    if (process.platform === 'linux') {
      const uinput = new LinuxUinputClient(this.screenWidth, this.screenHeight);
      if (uinput.start()) {
        this.linuxUinput = uinput;
      }
    }

    console.log(`[Cliente] Resolução local: ${this.screenWidth}x${this.screenHeight}`);
    console.log(`[Cliente] Borda de retorno ao Servidor: ${RETURN_EDGE.toUpperCase()}`);

    this.connectToServer();
  }

  private connectToServer() {
    const targetHost = FALLBACK_HOSTS[this.hostIndex % FALLBACK_HOSTS.length];
    const socket = new net.Socket();
    socket.setNoDelay(true);

    console.log(`[Cliente] Tentando conectar ao Servidor em ${targetHost}:${SERVER_PORT}...`);

    socket.connect({ port: SERVER_PORT, host: targetHost, family: 4 }, () => {
      console.log(`[Cliente] Conectado com sucesso ao Servidor em ${targetHost}:${SERVER_PORT}`);
      this.socket = socket;
    });

    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const packet: KVMPacket = JSON.parse(line);
          await this.handleServerPacket(packet);
        } catch (err) {
          console.error('[Cliente] Erro ao processar pacote:', err);
        }
      }
    });

    socket.on('close', () => {
      console.log('[Cliente] Conexão encerrada. Tentando reconectar em 2s...');
      this.socket = null;
      this.isActive = false;
      this.hostIndex++;
      setTimeout(() => this.connectToServer(), 2000);
    });

    socket.on('error', (err) => {
      console.error(`[Cliente] Erro ao conectar em ${targetHost}:`, err.message);
    });
  }

  private sendToServer(packet: KVMPacket) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(serializePacket(packet));
    }
  }

  private mapMouseButton(button: number): Button {
    switch (button) {
      case 1:
        return Button.LEFT;
      case 2:
        return Button.RIGHT;
      case 3:
        return Button.MIDDLE;
      default:
        return Button.LEFT;
    }
  }

  private async setCursorPos(x: number, y: number) {
    if (this.linuxUinput) {
      this.linuxUinput.moveTo(x, y);
    } else {
      await mouse.setPosition(new Point(x, y));
    }
  }

  private async handleServerPacket(packet: KVMPacket) {
    switch (packet.type) {
      case 'enter_client': {
        this.isActive = true;
        this.cursorY = Math.min(
          this.screenHeight - 2,
          Math.max(2, Math.floor(packet.yRatio * this.screenHeight))
        );
        this.cursorX = RETURN_EDGE === 'left' ? 10 : this.screenWidth - 10;

        await this.setCursorPos(this.cursorX, this.cursorY);
        console.log('[Cliente] Controle recebido no Cliente!');
        break;
      }

      case 'mousemove': {
        if (!this.isActive) return;

        this.cursorX += packet.dx;
        this.cursorY = Math.min(this.screenHeight - 1, Math.max(0, this.cursorY + packet.dy));

        const hitLeftReturn = RETURN_EDGE === 'left' && this.cursorX <= 0;
        const hitRightReturn = RETURN_EDGE === 'right' && this.cursorX >= this.screenWidth - 1;

        if (hitLeftReturn || hitRightReturn) {
          this.isActive = false;
          const yRatio = this.cursorY / this.screenHeight;
          console.log('[Cliente] Borda oposta atingida! Devolvendo controle ao Servidor...');
          this.sendToServer({ type: 'return_server', yRatio });
          return;
        }

        this.cursorX = Math.min(this.screenWidth - 1, Math.max(0, this.cursorX));
        await this.setCursorPos(this.cursorX, this.cursorY);
        break;
      }

      case 'mousedown': {
        if (!this.isActive) return;
        if (this.linuxUinput) {
          this.linuxUinput.mouseButton(packet.button, true);
        } else {
          await mouse.pressButton(this.mapMouseButton(packet.button));
        }
        break;
      }

      case 'mouseup': {
        if (!this.isActive) return;
        if (this.linuxUinput) {
          this.linuxUinput.mouseButton(packet.button, false);
        } else {
          await mouse.releaseButton(this.mapMouseButton(packet.button));
        }
        break;
      }

      case 'wheel': {
        if (!this.isActive) return;
        if (this.linuxUinput) {
          this.linuxUinput.wheel(packet.amount, packet.direction);
        } else {
          const scrollAmount = packet.amount * 30;
          if (packet.direction > 0) {
            await mouse.scrollDown(scrollAmount);
          } else {
            await mouse.scrollUp(scrollAmount);
          }
        }
        break;
      }

      case 'keydown': {
        if (!this.isActive) return;
        if (this.linuxUinput) {
          this.linuxUinput.key(packet.keycode, true);
        } else {
          const nutKey = UIOHOOK_TO_NUT_KEY[packet.keycode];
          if (nutKey !== undefined) {
            await keyboard.pressKey(nutKey);
          }
        }
        break;
      }

      case 'keyup': {
        if (!this.isActive) return;
        if (this.linuxUinput) {
          this.linuxUinput.key(packet.keycode, false);
        } else {
          const nutKey = UIOHOOK_TO_NUT_KEY[packet.keycode];
          if (nutKey !== undefined) {
            await keyboard.releaseKey(nutKey);
          }
        }
        break;
      }
    }
  }
}

new KVMClient().start().catch(console.error);
