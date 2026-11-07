import dgram from 'dgram';
import os from 'os';

export interface DiscoveryBeacon {
  type: 'MULT_KVM_BEACON';
  name: string;
  port: number;
  host?: string;
}

export const DEFAULT_DISCOVERY_PORT = 5005;

/**
 * Coleta todos os endereços de broadcast IPv4 das interfaces ativas locais.
 */
export function getBroadcastAddresses(): string[] {
  const broadcasts = new Set<string>(['255.255.255.255']);
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const ipParts = iface.address.split('.').map(Number);
        const maskParts = iface.netmask ? iface.netmask.split('.').map(Number) : [255, 255, 255, 0];
        if (ipParts.length === 4 && maskParts.length === 4) {
          const bcastParts = ipParts.map((part, i) => (part | (~maskParts[i] & 255)) >>> 0);
          broadcasts.add(bcastParts.join('.'));
        }
      }
    }
  }
  return Array.from(broadcasts);
}

/**
 * Anunciador de presença do Servidor KVM na rede local via UDP Broadcast
 */
export class DiscoveryServer {
  private socket: dgram.Socket | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private readonly discoveryPort: number;
  private readonly beaconPayload: Buffer;

  constructor(
    private readonly servicePort: number,
    private readonly serverName: string = os.hostname(),
    discoveryPort?: number
  ) {
    this.discoveryPort = discoveryPort || Number(process.env.KVM_DISCOVERY_PORT) || DEFAULT_DISCOVERY_PORT;
    this.beaconPayload = Buffer.from(
      JSON.stringify({
        type: 'MULT_KVM_BEACON',
        name: this.serverName,
        port: this.servicePort,
      } as DiscoveryBeacon)
    );
  }

  start(): void {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      console.warn('[Descoberta] Aviso no socket UDP:', err.message);
    });

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8').trim();
      if (text === 'MULT_KVM_DISCOVER') {
        socket.send(this.beaconPayload, rinfo.port, rinfo.address, () => {});
      }
    });

    socket.bind(this.discoveryPort, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // Ignora caso permissão não concedida
      }

      this.intervalTimer = setInterval(() => {
        this.broadcastBeacon();
      }, 3000);
      this.intervalTimer.unref?.();
      this.broadcastBeacon();
    });
  }

  private broadcastBeacon(): void {
    if (!this.socket) return;
    const addresses = getBroadcastAddresses();
    for (const addr of addresses) {
      try {
        this.socket.send(this.beaconPayload, this.discoveryPort, addr, () => {});
      } catch {
        // Ignora erros transitórios de rota
      }
    }
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
  }
}

/**
 * Localiza automaticamente o Servidor KVM na rede local sem necessitar digitar IPs
 */
export async function discoverServer(options?: {
  timeoutMs?: number;
  discoveryPort?: number;
}): Promise<{ host: string; port: number; name: string } | null> {
  const timeoutMs = options?.timeoutMs ?? 2000;
  const discoveryPort = options?.discoveryPort || Number(process.env.KVM_DISCOVERY_PORT) || DEFAULT_DISCOVERY_PORT;

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        try {
          socket.close();
        } catch {}
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    socket.on('error', () => {
      clearTimeout(timer);
      cleanup();
      resolve(null);
    });

    socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString('utf8')) as DiscoveryBeacon;
        if (data.type === 'MULT_KVM_BEACON' && data.port) {
          clearTimeout(timer);
          cleanup();
          resolve({
            host: rinfo.address,
            port: data.port,
            name: data.name || rinfo.address,
          });
        }
      } catch {
        // Ignora pacotes de terceiros
      }
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {}

      const probe = Buffer.from('MULT_KVM_DISCOVER');
      const addrs = getBroadcastAddresses();
      for (const addr of addrs) {
        try {
          socket.send(probe, discoveryPort, addr, () => {});
        } catch {}
      }
    });
  });
}
