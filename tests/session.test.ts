import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameReader, computeHmac, verifyHmac, encodeBinary, Packet } from '../src/protocol';

test('Session: HMAC handshake verification and client_info handling', () => {
  const secret = 'super-secret-key';
  const nonce = 'random-nonce-1234';

  let authenticated = false;
  let clientSession: {
    id: string;
    pendingId?: string;
    name: string;
    width: number;
    height: number;
  } = {
    id: 'initial_addr_123',
    name: 'Unknown',
    width: 1920,
    height: 1080,
  };

  const clients = new Map<string, typeof clientSession>();
  clients.set(clientSession.id, clientSession);

  const reader = new FrameReader((packet: Packet) => {
    if (!authenticated) {
      if (packet.type === 'client_info') {
        clientSession.width = packet.width;
        clientSession.height = packet.height;
        if (packet.name) clientSession.name = packet.name;
        if (packet.id) clientSession.pendingId = packet.id;
        return;
      }
      if (packet.type === 'auth_response') {
        const valid = verifyHmac(secret, nonce, packet.hmac);
        if (valid) {
          authenticated = true;
          if (packet.clientName) clientSession.name = packet.clientName;
          const finalId = packet.clientId || clientSession.pendingId || clientSession.id;
          if (finalId !== clientSession.id) {
            clients.delete(clientSession.id);
            clientSession.id = finalId;
            clients.set(clientSession.id, clientSession);
          }
        }
      }
      return;
    }
  });

  // 1. Client sends initial client_info before auth
  reader.push(
    encodeBinary({
      type: 'client_info',
      width: 2560,
      height: 1440,
      name: 'Windows-PC',
      id: 'win-client-01',
    })
  );

  // Client info was recorded and pendingId stored without overwriting authenticated sessions prematurely
  assert.equal(clientSession.width, 2560);
  assert.equal(clientSession.height, 1440);
  assert.equal(clientSession.pendingId, 'win-client-01');

  // 2. Client sends auth_response
  const hmac = computeHmac(secret, nonce);
  reader.push(
    encodeBinary({
      type: 'auth_response',
      hmac,
      clientName: 'Windows-PC-Renamed',
      clientId: 'win-client-01',
    })
  );

  assert.equal(authenticated, true);
  assert.equal(clients.has('win-client-01'), true);
  assert.equal(clients.get('win-client-01')?.name, 'Windows-PC-Renamed');
});
