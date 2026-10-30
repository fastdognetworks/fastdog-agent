import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mockEdge } from './helpers/mock-edge.js';
import { startHeartbeat } from '../src/heartbeat.js';

for (const streaming of [false, true]) test(`real agent end to end, streaming ${streaming}`, { timeout: 15000 }, async t => {
  const origin = http.createServer(async (req, res) => {
    if (req.method === 'HEAD') { res.end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    res.writeHead(201, { 'x-path': req.url, 'x-host': req.headers.host }); res.end(Buffer.concat(chunks));
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  t.after(() => { origin.closeAllConnections(); origin.close(); });
  const credential = randomBytes(16).toString('hex');
  const edge = await mockEdge({ credential, streaming }); t.after(() => edge.close());
  Object.assign(process.env, { EDGE_HTTP_URL: edge.url, EDGE_WS_URL: edge.url.replace('http:', 'ws:') + '/_fastdog/tunnel', AGENT_TOKEN: credential, AGENT_LOCAL_UPSTREAM: `http://127.0.0.1:${origin.address().port}` });
  const agent = await import(`../src/index.js?streaming=${streaming}`);
  const reg = await agent.register(); assert.equal(reg.id, 'fixture-agent');
  let ready; const welcomed = new Promise(resolve => { ready = resolve; });
  const closed = agent.connectWs(reg.id, ready);
  const socket = await edge.connected; await welcomed;
  const body = randomBytes(3 * 1024 * 1024);
  const result = await edge.request({ body, path: '/upload?x=1' });
  assert.equal(result.status, 201); assert.deepEqual(result.body, body);
  assert.equal(result.headers['x-path'], '/upload?x=1'); assert.equal(result.headers['x-host'], 'app.example.com');
  assert.equal(edge.frames.some(f => f.type === 'hello'), streaming);
  assert.equal(edge.frames.some(f => f.type === 'data'), streaming);
  assert.equal(edge.frames.some(f => f.type === 'ack'), streaming);
  const parallel = await Promise.all(Array.from({ length: 12 }, (_, i) => edge.request({ body: Buffer.from(String(i)), headers: { host: 'app.example.com', 'content-length': String(Buffer.byteLength(String(i))) } })));
  parallel.forEach((reply, i) => assert.equal(reply.body.toString(), String(i)));
  socket.close(); await closed;
});

test('mock heartbeat replies keep a real WebSocket alive', async t => {
  const { default: WebSocket } = await import('ws');
  const credential = randomBytes(16).toString('hex');
  const edge = await mockEdge({ credential }); t.after(() => edge.close());
  const ws = new WebSocket(edge.url.replace('http:', 'ws:'), { headers: { Authorization: `Bearer ${credential}` } });
  await edge.connected;
  await new Promise(resolve => ws.once('open', resolve));
  const stop = startHeartbeat(ws, { intervalMs: 10, maxMissed: 10 }); t.after(stop);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(ws.readyState, 1); assert.ok(edge.frames.some(f => f.type === 'ping')); ws.terminate();
});
