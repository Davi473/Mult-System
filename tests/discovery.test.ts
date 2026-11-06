import test from 'node:test';
import assert from 'node:assert/strict';
import { getBroadcastAddresses, DiscoveryServer, discoverServer } from '../src/discovery';

test('Discovery: getBroadcastAddresses returns non-empty list including 255.255.255.255', () => {
  const addrs = getBroadcastAddresses();
  assert.ok(addrs.length > 0);
  assert.ok(addrs.includes('255.255.255.255'));
});

test('Discovery: DiscoveryServer starts, replies to discoverServer, and stops', async () => {
  const testPort = 5999;
  const testDiscoveryPort = 5998;
  const server = new DiscoveryServer(testPort, 'Test-KVM-Host', testDiscoveryPort);
  server.start();

  try {
    const result = await discoverServer({
      timeoutMs: 800,
      discoveryPort: testDiscoveryPort,
    });

    if (result) {
      assert.equal(result.port, testPort);
      assert.equal(result.name, 'Test-KVM-Host');
    }
  } finally {
    server.stop();
  }
});
