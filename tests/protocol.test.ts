import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeBinary,
  FrameReader,
  LineReader,
  MouseBatcher,
  oppositeEdge,
  parseEdge,
  Packet,
  computeHmac,
  verifyHmac,
  generateAuthNonce,
} from '../src/protocol';

test('Protocol: Binary encoding and decoding of MOVE', () => {
  const input: Packet = { type: 'move', dx: -15, dy: 42 };
  const encoded = encodeBinary(input);
  assert.equal(encoded.length, 5, 'MOVE packet must be 5 bytes');

  let received: Packet | null = null;
  const reader = new FrameReader((pkt) => {
    received = pkt;
  });

  reader.push(encoded);
  assert.deepEqual(received, input);
});

test('Protocol: Binary encoding and decoding of BUTTON, KEY and WHEEL', () => {
  const packets: Packet[] = [
    { type: 'button', button: 1, down: true },
    { type: 'button', button: 2, down: false },
    { type: 'key', code: 104, down: true },
    { type: 'wheel', dy: -120, dx: 0 },
  ];

  const receivedList: Packet[] = [];
  const reader = new FrameReader((pkt) => {
    receivedList.push(pkt);
  });

  for (const p of packets) {
    const encoded = encodeBinary(p);
    reader.push(encoded);
  }

  assert.deepEqual(receivedList, packets);
});

test('Protocol: Binary encoding of PING / PONG (64-bit timestamp) and CLIENT_POS', () => {
  const realTimestamp = 1794082000123; // > 2^32 (testa prevenção de truncamento 32-bit)
  const ping: Packet = { type: 'ping', seq: 42, timestamp: realTimestamp };
  const pong: Packet = { type: 'pong', seq: 42, timestamp: realTimestamp };
  const pos: Packet = { type: 'client_pos', x: 500, y: 300 };

  const receivedList: Packet[] = [];
  const reader = new FrameReader((pkt) => receivedList.push(pkt));

  reader.push(encodeBinary(ping));
  reader.push(encodeBinary(pong));
  reader.push(encodeBinary(pos));

  assert.deepEqual(receivedList, [ping, pong, pos]);
});

test('Protocol: JSON payload encoding and backward-compatibility with NDJSON', () => {
  const enterPacket: Packet = { type: 'enter', yRatio: 0.75, returnEdge: 'left' };
  const receivedList: Packet[] = [];
  const reader = new FrameReader((pkt) => receivedList.push(pkt));

  // Binary wrapped JSON (Opcode 0x10)
  reader.push(encodeBinary(enterPacket));

  // Legacy raw text NDJSON
  reader.push(Buffer.from('{"type":"leave"}\n', 'utf8'));

  assert.deepEqual(receivedList, [enterPacket, { type: 'leave' }]);
});

test('Protocol: Buffer protection against overflow', () => {
  const reader = new FrameReader(() => {}, { maxBufferSize: 1024 });

  assert.throws(() => {
    // Envia 2048 bytes sem delimitador
    const junk = Buffer.alloc(2048, 0xaa);
    reader.push(junk);
  }, /Buffer overflow/);
});

test('Protocol: LineReader protection against infinite line growth', () => {
  const lr = new LineReader(() => {}, { maxLineLength: 512 });

  assert.throws(() => {
    const longString = 'A'.repeat(1000);
    lr.push(longString);
  }, /LineReader overflow/);
});

test('Protocol: MouseBatcher coalesces rapid mouse moves', async () => {
  let flushedCount = 0;
  let totalDx = 0;
  let totalDy = 0;

  const batcher = new MouseBatcher((dx, dy) => {
    flushedCount++;
    totalDx += dx;
    totalDy += dy;
  }, 10);

  // Simula mouse a 1000Hz (10 eventos em micro-intervalos)
  for (let i = 0; i < 10; i++) {
    batcher.push(2, -1);
  }

  // Imediatamente forçamos flush (ou aguardamos o timer)
  batcher.flush();

  assert.equal(flushedCount, 1, 'Eventos agrupados devem disparar apenas 1 pacote combinado');
  assert.equal(totalDx, 20);
  assert.equal(totalDy, -10);

  // Testa cancelamento de lote pendente
  batcher.push(15, 15);
  batcher.cancel();
  batcher.flush();
  assert.equal(flushedCount, 1, 'Lote cancelado não deve emitir pacotes');
});

test('Security: HMAC-SHA256 handshake challenge and response', () => {
  const secretKey = 'test-secret-key-1234';
  const wrongKey = 'wrong-secret-key-5678';
  const nonce = generateAuthNonce();

  assert.equal(typeof nonce, 'string');
  assert.equal(nonce.length, 32);

  const hmac = computeHmac(secretKey, nonce);
  assert.equal(verifyHmac(secretKey, nonce, hmac), true, 'Valid key and nonce must succeed');
  assert.equal(verifyHmac(wrongKey, nonce, hmac), false, 'Wrong key must fail verification');
  assert.equal(verifyHmac(secretKey, 'tampered-nonce', hmac), false, 'Tampered nonce must fail');
});

test('Topology: oppositeEdge and parseEdge', () => {
  assert.equal(oppositeEdge('right'), 'left');
  assert.equal(oppositeEdge('left'), 'right');
  assert.equal(oppositeEdge('top'), 'bottom');
  assert.equal(oppositeEdge('bottom'), 'top');

  assert.equal(parseEdge('top', 'right'), 'top');
  assert.equal(parseEdge('BOTTOM', 'right'), 'bottom');
  assert.equal(parseEdge('invalid', 'left'), 'left');
  assert.equal(parseEdge(undefined, 'right'), 'right');
});
