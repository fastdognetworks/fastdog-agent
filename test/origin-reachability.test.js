import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startHeartbeat } from '../src/heartbeat.js';

process.env.FASTDOG_AGENT_NO_MAIN = '1';
const { probeOrigin } = await import('../src/index.js');

test('agent probe reports a listening app as reachable and a closed port as not', async (t) => {
  let bodySeen = false;
  const server = http.createServer((req, res) => { res.end('private app content'); bodySeen = true; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal(await probeOrigin(`http://127.0.0.1:${port}`), true);
  assert.equal(bodySeen, true);
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  assert.equal(await probeOrigin(`http://127.0.0.1:${closedPort}`, { timeoutMs: 500 }), false);
  assert.equal(await probeOrigin('not a url'), false);
});

test('heartbeat pings carry only the origin status fields', async () => {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(data)); }, terminate() {} });
  const stop = startHeartbeat(ws, { intervalMs: 5, status: () => ({ origin_reachable: false, origin_checked_at: '2026-01-01T00:00:00.000Z', type: 'spoof' }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  assert.deepEqual(ws.sent[0], { origin_reachable: false, origin_checked_at: '2026-01-01T00:00:00.000Z', type: 'ping' });
});

