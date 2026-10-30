import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const token = 'synthetic-agent-credential';
// A cold child `node` start costs ~0.2 s idle but was measured at 1-9 s while the whole root suite runs
// concurrently, so startup and module loading get a generous bound. Shutdown keeps its own tight bound,
// measured from the signal, so "exits promptly" is asserted independently of how slow startup was.
const STARTUP_MS = 30000;
const SHUTDOWN_MS = 5000;
async function within(ms, step, promise) {
  let timer;
  const expired = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${step} did not happen within ${ms} ms`)), ms); });
  try { return await Promise.race([promise, expired]); } finally { clearTimeout(timer); }
}
function launch(extra = {}) {
  const child = spawn(process.execPath, ['src/index.js'], { env: { ...process.env, FASTDOG_AGENT_NO_MAIN: '0', AGENT_TOKEN: token, AGENT_HOSTNAME: 'app.example.com', NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${process.cwd()}/test/helpers/no-agent-listener.cjs`, ...extra } });
  child.output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { child.output += data; });
  return child;
}

test('missing, empty and whitespace tokens refuse startup; NO_MAIN stays importable', () => {
  for (const value of [undefined, '', '   ']) {
    const env = { ...process.env, FASTDOG_AGENT_NO_MAIN: '0' };
    if (value === undefined) delete env.AGENT_TOKEN;
    else env.AGENT_TOKEN = value;
    const result = spawnSync(process.execPath, ['src/index.js'], { env, encoding: 'utf8', timeout: STARTUP_MS });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AGENT_TOKEN is required/);
  }
  const result = spawnSync(process.execPath, ['src/index.js'], { env: { ...process.env, AGENT_TOKEN: '', FASTDOG_AGENT_NO_MAIN: '1' }, timeout: STARTUP_MS });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`agent uses headers only and exits promptly on ${signal}`, { timeout: STARTUP_MS + 2 * SHUTDOWN_MS }, async (t) => {
    let registration;
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const data of req) body += data;
      registration = { headers: req.headers, url: req.url, body: JSON.parse(body) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'synthetic-id' }));
    });
    const wss = new WebSocketServer({ server });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { for (const ws of wss.clients) ws.terminate(); server.closeAllConnections(); server.close(); });
    const base = `127.0.0.1:${server.address().port}`;
    const connected = once(wss, 'connection');
    const child = launch({ EDGE_HTTP_URL: `http://${base}`, EDGE_WS_URL: `ws://${base}/_fastdog/tunnel?token=obsolete` });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const [ws, req] = await within(STARTUP_MS, 'agent tunnel connection', connected);
    assert.equal(registration.headers.authorization, `Bearer ${token}`);
    assert.equal(registration.headers['x-fastdog-token'], undefined);
    assert.equal(registration.body.token, undefined);
    assert.equal(registration.body.name, '');
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(new URL(req.url, 'http://example.com').searchParams.has('token'), false);
    assert.equal(registration.url.includes(token), false);
    const closed = once(ws, 'close');
    const exited = once(child, 'exit');
    child.kill(signal);
    assert.deepEqual(await within(SHUTDOWN_MS, `agent exit after ${signal}`, exited), [0, null]);
    await within(SHUTDOWN_MS, 'tunnel close after agent exit', closed);
    assert.equal(child.output.includes(token), false);
  });
}

test('agent never logs reflected registration errors or socket close reasons', { timeout: STARTUP_MS + 2 * SHUTDOWN_MS }, async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.statusCode = ++requests === 1 ? 401 : 200;
    res.end(JSON.stringify(requests === 1 ? { error: token } : { id: 'synthetic-id', route: token }));
  });
  const wss = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const ws of wss.clients) ws.terminate(); server.closeAllConnections(); server.close(); });
  const base = `127.0.0.1:${server.address().port}`;
  const connected = once(wss, 'connection');
  const child = launch({ EDGE_HTTP_URL: `http://${base}`, EDGE_WS_URL: `ws://${base}/_fastdog/tunnel` });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const [ws] = await within(STARTUP_MS, 'agent tunnel connection', connected);
  ws.close(4401, token);
  await within(SHUTDOWN_MS, 'agent close handshake', once(ws, 'close'));
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await within(SHUTDOWN_MS, 'agent exit after SIGTERM', exited);
  assert.equal(child.output.includes(token), false);
});

