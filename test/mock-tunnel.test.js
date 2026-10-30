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

test('negotiated v1 WebSocket upgrade relays messages both ways', { timeout: 15000 }, async t => {
  const { WebSocketServer } = await import('ws');
  const origin = http.createServer((_req, res) => res.end());
  const wss = new WebSocketServer({ server: origin });
  const received = new Promise(resolve => wss.on('connection', (ws, req) => {
    ws.on('message', data => {
      resolve({ text: data.toString(), path: req.url, host: req.headers.host });
      ws.send('reply');
    });
  }));
  t.after(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close(); origin.closeAllConnections(); origin.close();
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const credential = randomBytes(16).toString('hex');
  const edge = await mockEdge({ credential, websocket: true });
  t.after(() => edge.close());
  const settings = {
    EDGE_HTTP_URL: edge.url, EDGE_WS_URL: edge.url.replace('http:', 'ws:') + '/_fastdog/tunnel',
    AGENT_TOKEN: credential, AGENT_LOCAL_UPSTREAM: `http://127.0.0.1:${origin.address().port}`,
  };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const agent = await import('../src/index.js?websocket');
  const reg = await agent.register();
  const closed = agent.connectWs(reg.id, () => {});
  const tunnel = await edge.connected;
  const hello = await edge.waitForFrame(msg => msg.type === 'hello');
  assert.deepEqual(hello.caps, ['stream', 'ws']);
  edge.send({ type: 'req_start', sid: 1, websocket: true, method: 'GET', path: '/socket?x=1', headers: {
    host: 'example.com', upgrade: 'websocket', connection: 'Upgrade',
    'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'),
  } });
  edge.send({ type: 'req_end', sid: 1 });
  const response = await edge.waitForFrame(msg => msg.type === 'res_start' && msg.sid === 1);
  assert.equal(response.status, 101);
  assert.equal(response.headers.upgrade.toLowerCase(), 'websocket');
  const mask = Buffer.from([1, 2, 3, 4]);
  const payload = Buffer.from('hello');
  edge.sendData(1, Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask,
    Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))]));
  const reply = Buffer.from([0x81, 5, ...Buffer.from('reply')]);
  await edge.waitForFrame(() => Buffer.concat(edge.frames.filter(f => f.type === 'data' && f.sid === 1).map(f => f.body)).length >= reply.length);
  assert.deepEqual(await received, { text: 'hello', path: '/socket?x=1', host: 'example.com' });
  assert.deepEqual(Buffer.concat(edge.frames.filter(f => f.type === 'data' && f.sid === 1).map(f => f.body)), reply);
  edge.send({ type: 'ack', sid: 1, bytes: reply.length });
  edge.send({ type: 'abort', sid: 1, closeCode: 1001 });
  tunnel.close(); await closed;
});
