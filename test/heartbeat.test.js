import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startHeartbeat } from '../src/heartbeat.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  terminate() { this.readyState = 3; this.emit('close'); }
}

it('agent terminates a connection after missed pongs', async (t) => {
  const ws = new FakeSocket();
  const stop = startHeartbeat(ws, { intervalMs: 5, maxMissed: 2 });
  t.after(stop);
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('heartbeat did not close the socket')), 2000);
    t.after(() => clearTimeout(deadline));
    ws.once('close', resolve);
  });
  assert.equal(ws.readyState, 3);
  assert.equal(ws.sent.length, 2);
  stop();
});
