/**
 * FastDog tunnel agent.
 *
 * Outbound connector: registers with the edge control API, opens a WebSocket tunnel,
 * receives HTTP-over-WS frames, forwards them to AGENT_LOCAL_UPSTREAM and returns the response.
 *
 * It makes outbound connections only; it does not listen for inbound connections.
 * v1 streams support negotiated WebSocket upgrade passthrough; CONNECT is unsupported.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import https from 'node:https';
import { URL } from 'node:url';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { FrameBoundary, WS_WINDOW_BYTES } from './ws-frames.js';
import { computeBackoffMs } from './backoff.js';
import { startHeartbeat, createHandoff } from './heartbeat.js';

/**
 * SV-1: the outbound authority is always the configured upstream. Only the path and query of the
 * client's request target are copied, so absolute-form ("http://other/x"), network-path ("//other/x")
 * and backslash ("/\\other/x") targets cannot retarget the upstream.
 */
export function pinnedTarget(requestTarget, upstreamBase) {
  const target = new URL(upstreamBase);
  let path = requestTarget || '/';
  if (!path.startsWith('/')) {
    // absolute-form or other non-origin-form target: keep only its path + query
    const parsed = new URL(path, 'http://pinned.invalid/');
    path = parsed.pathname + parsed.search;
  }
  const q = path.indexOf('?');
  target.pathname = q < 0 ? path : path.slice(0, q);
  target.search = q < 0 ? '' : path.slice(q);
  target.hash = '';
  return target;
}


function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const EDGE_HTTP = env('EDGE_HTTP_URL', 'http://127.0.0.1:8787');
const EDGE_WS = env('EDGE_WS_URL', 'ws://127.0.0.1:8787/_fastdog/tunnel');
const TOKEN = env('AGENT_TOKEN', '');
const NAME = env('AGENT_NAME', '');
const HOSTNAME = env('AGENT_HOSTNAME', '');
const LOCAL_UPSTREAM = env('AGENT_LOCAL_UPSTREAM', 'http://127.0.0.1:9999').replace(/\/$/, '');

// Validate URL syntax and transport without resolving DNS or exposing URL credentials.
export function validateEdgeUrl(value, kind, allowInsecure = process.env.FASTDOG_ALLOW_INSECURE_EDGE) {
  const setting = kind === 'http' ? 'EDGE_HTTP_URL' : 'EDGE_WS_URL';
  let url;
  try { url = new URL(value); } catch { throw new Error(setting + ' must be a valid edge URL.'); }
  const secure = kind === 'http' ? 'https:' : 'wss:';
  const plain = kind === 'http' ? 'http:' : 'ws:';
  if (url.protocol !== secure && url.protocol !== plain) {
    throw new Error(setting + ' must use ' + secure + ' or ' + plain);
  }
  const host = url.hostname;
  // URL canonicalizes IPv4 literals; do not trust arbitrary DNS names or *.localhost.
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (url.protocol === plain && !loopback && allowInsecure !== '1') {
    throw new Error(setting + ' refuses plaintext to a non-loopback edge. Use ' + secure +
      '// or set FASTDOG_ALLOW_INSECURE_EDGE=1 only for local development.');
  }
  return url;
}

let warnedInsecure = false;
export function validateEdgeConfig() {
  const registration = validateEdgeUrl(EDGE_HTTP, 'http');
  const tunnel = validateEdgeUrl(EDGE_WS, 'ws');
  if (process.env.FASTDOG_ALLOW_INSECURE_EDGE === '1' && !warnedInsecure) {
    warnedInsecure = true;
    console.warn('[agent] WARNING: FASTDOG_ALLOW_INSECURE_EDGE=1 permits plaintext edge connections; credentials and traffic may be exposed. Local development only.');
  }
  return { registration, tunnel };
}

export async function register({ signal } = {}) {
  validateEdgeConfig();
  const res = await fetch(`${EDGE_HTTP.replace(/\/$/, '')}/_fastdog/agents/register`, {
    method: 'POST',
    redirect: 'error',
    ...(signal ? { signal } : {}),
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      name: NAME,
      hostname: HOSTNAME,
      localUpstream: LOCAL_UPSTREAM,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  return res.json();
}

export function fetchLocal(method, path, headers, bodyBuf, upstream = LOCAL_UPSTREAM, work) {
  return new Promise((resolve, reject) => {
    const target = pinnedTarget(path, upstream);
    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;
    // Preserve client Host from the edge (Host-based apps); only use LOCAL_UPSTREAM for TCP.
    const hdrs = { ...headers };
    delete hdrs['transfer-encoding'];
    delete hdrs.connection;
    delete hdrs['content-length'];
    if (!hdrs.host && !hdrs.Host) hdrs.host = target.host;

    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers: hdrs,
        timeout: 25000,
        ...(work ? { signal: work.controller.signal } : {}),
      },
      (res) => {
        if (work) { work.streaming = true; work.changed(); }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    if (work) {
      work.uploading = true;
      req.once('finish', () => { work.uploading = false; work.changed(); });
    }
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('local upstream timeout')));
    if (bodyBuf?.length) req.write(bodyBuf);
    req.end();
  });
}

// Reachability probe of the operator's own local app only. Any HTTP response means the app is listening; the
// result is a boolean and no response content is read. Do not reuse this (TLS checks off) for forwarded traffic.
export function probeOrigin(upstream = LOCAL_UPSTREAM, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(`${upstream}/`); } catch { resolve(false); return; }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: 'HEAD', timeout: timeoutMs, rejectUnauthorized: false }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}
// Reported in heartbeats so the portal can tell which agent version is connected.
const AGENT_VERSION = (() => {
  for (const rel of ['./package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
      if (pkg.name === 'fastdog-agent' && /^\d+\.\d+\.\d+$/.test(pkg.version)) return pkg.version;
    } catch { /* try the next location */ }
  }
  return null;
})();
let originStatus = {};
async function refreshOrigin() {
  originStatus = { origin_reachable: await probeOrigin(), origin_checked_at: new Date().toISOString(),
    ...(AGENT_VERSION ? { agent_version: AGENT_VERSION } : {}) };
}
export const currentOriginStatus = () => originStatus;

async function handleFrame(ws, msg, work) {
  if (msg.type !== 'http_req') return;
  try {
    const bodyBuf = msg.bodyBase64 ? Buffer.from(msg.bodyBase64, 'base64') : null;
    const result = await fetchLocal(msg.method, msg.path, msg.headers || {}, bodyBuf, LOCAL_UPSTREAM, work);
    if (work?.cancelled) return;
    const outHeaders = { ...result.headers };
    delete outHeaders['transfer-encoding'];
    delete outHeaders['content-length'];
    ws.send(
      JSON.stringify({
        type: 'http_res',
        id: msg.id,
        status: result.status,
        headers: outHeaders,
        bodyBase64: result.body.length ? result.body.toString('base64') : undefined,
      }),
    );
  } catch (err) {
    if (work?.cancelled) return;
    ws.send(
      JSON.stringify({
        type: 'http_res',
        id: msg.id,
        status: 502,
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(JSON.stringify({ error: 'agent_upstream_failed', detail: err.message })).toString('base64'),
      }),
    );
  }
}

// Tunnel protocol v1 (streaming), used only after the edge's welcome advertises caps ['stream'] and this agent
// answers with hello. Mirrors src/control/tunnels.js: JSON control frames keyed by sid, binary data frames
// [0x01][sid uint32 BE][payload], and per-stream credit (ack) so at most STREAM_WINDOW_BYTES are unacknowledged.
export const STREAM_CHUNK_BYTES = 64 * 1024;
export const STREAM_WINDOW_BYTES = 1024 * 1024;
// v1 origin socket inactivity timeout, raised to the header wait from req_end until the origin's response headers
// (matches STREAM_HEADER_WAIT_MS in src/control/tunnels.js). The v0 path keeps its own 25 s timeout.
export const ORIGIN_IDLE_MS = 25000;
export const ORIGIN_HEADER_WAIT_MS = 120000;

function dataFrame(sid, payload) {
  const head = Buffer.allocUnsafe(5);
  head[0] = 1;
  head.writeUInt32BE(sid, 1);
  return Buffer.concat([head, payload]);
}

export function createStreamHandler(ws, upstream = LOCAL_UPSTREAM, { idleMs = ORIGIN_IDLE_MS, headerWaitMs = ORIGIN_HEADER_WAIT_MS, changed } = {}) {
  const streams = new Map();
  const sendJson = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  function drop(sid, { notify = false, closeCode = 1011, peerEnded = false } = {}) {
    const s = streams.get(sid);
    if (!s) return;
    streams.delete(sid);
    changed?.();
    if (notify) sendJson({ type: 'abort', sid, closeCode });
    if (s.socket) {
      if (s.socket.destroyed) { s.req.destroy(); return; }
      // Never send new application bytes after the origin has ended its stream.
      // Client-to-origin frames must be masked, including this synthetic close.
      if (!peerEnded && s.boundary.boundary && !s.boundary.closed) {
        const code = closeCode === 1001 ? 1001 : 1011;
        const mask = randomBytes(4);
        s.socket.write(Buffer.from([0x88, 0x82, ...mask, (code >> 8) ^ mask[0], (code & 255) ^ mask[1]]));
      }
      const timer = setTimeout(() => s.socket.destroy(), 1000);
      timer.unref?.();
      s.socket.once('close', () => { clearTimeout(timer); s.req.destroy(); });
      s.socket.end();
      s.socket.destroySoon();
      return;
    }
    s.req.destroy();
    s.res?.destroy();
  }

  function start(msg) {
    const { sid } = msg;
    let target;
    try { target = pinnedTarget(msg.path, upstream); } catch { sendJson({ type: 'abort', sid }); return; }
    const lib = target.protocol === 'https:' ? https : http;
    // Preserve client Host from the edge (Host-based apps); only use the upstream for TCP. Content-Length is kept
    // when the client sent one; otherwise Node sends the streamed body chunked.
    const hdrs = { ...(msg.headers || {}) };
    delete hdrs['transfer-encoding'];
    delete hdrs.connection;
    if (msg.websocket) {
      if (msg.method !== 'GET' || String(hdrs.upgrade).toLowerCase() !== 'websocket') throw new Error('unsupported upgrade');
      hdrs.connection = 'Upgrade';
      delete hdrs['content-length'];
    }
    if (!hdrs.host && !hdrs.Host) hdrs.host = target.host;
    const s = { req: null, res: null, inflight: 0, paused: false, ended: false, websocket: Boolean(msg.websocket), boundary: msg.websocket ? new FrameBoundary() : null, window: msg.websocket ? WS_WINDOW_BYTES : STREAM_WINDOW_BYTES, unflushed: 0 };
    s.req = lib.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search, method: msg.method, headers: hdrs, timeout: idleMs,
    }, (res) => {
      if (!streams.has(sid)) { res.destroy(); return; }
      s.res = res;
      changed?.();
      if (s.ended) s.req.setTimeout(idleMs);
      const headers = { ...res.headers };
      if (s.websocket) {
        for (const name of String(headers.connection || '').toLowerCase().split(',').map(v => v.trim())) delete headers[name];
        for (const name of ['upgrade', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'proxy-connection']) delete headers[name];
      }
      delete headers['transfer-encoding'];
      delete headers.connection;
      sendJson({ type: 'res_start', sid, status: res.statusCode || 502, headers });
      res.on('data', (c) => {
        for (let i = 0; i < c.length; i += STREAM_CHUNK_BYTES) ws.send(dataFrame(sid, c.subarray(i, i + STREAM_CHUNK_BYTES)));
        s.inflight += c.length;
        if (s.inflight >= s.window && !s.paused) { s.paused = true; res.pause(); }
      });
      res.on('end', () => {
        if (streams.delete(sid)) sendJson({ type: 'res_end', sid });
        changed?.();
        // Origin answered before reading the whole upload: release the origin request instead of leaving it open.
        if (!s.req.writableFinished) s.req.destroy();
      });
      res.on('error', () => drop(sid, { notify: true }));
      res.on('close', () => { if (!res.complete) drop(sid, { notify: true }); });
    });
    s.req.on('upgrade', (res, socket, head) => {
      if (!s.websocket || !streams.has(sid) || res.statusCode !== 101
          || String(res.headers.upgrade).toLowerCase() !== 'websocket') {
        socket.destroy(); drop(sid, { notify: true }); return;
      }
      s.socket = socket;
      s.res = socket;
      s.req.setTimeout(0); socket.setTimeout(0);
      sendJson({ type: 'res_start', sid, status: 101, headers: res.headers });
      function relay(c) {
        if (!streams.has(sid)) return;
        s.inflight += c.length;
        if (s.inflight > s.window + STREAM_CHUNK_BYTES) return drop(sid, { notify: true });
        for (let i = 0; i < c.length; i += STREAM_CHUNK_BYTES) ws.send(dataFrame(sid, c.subarray(i, i + STREAM_CHUNK_BYTES)));
        if (s.inflight >= s.window) { s.paused = true; socket.pause(); }
      }
      socket.on('data', relay);
      socket.on('end', () => drop(sid, { notify: true, peerEnded: true }));
      socket.on('close', () => drop(sid, { notify: true }));
      socket.on('error', () => drop(sid, { notify: true }));
      if (head.length) relay(head);
      changed?.();
    });
    // Once the response has started only its own outcome counts: an origin that answers early and closes makes
    // the unfinished upload fail with EPIPE/ECONNRESET, which must not throw away a complete response.
    s.req.on('error', () => { if (!s.res) drop(sid, { notify: true }); });
    s.req.on('timeout', () => {
      // Header-wait expiry: tell the edge it was a timeout so the client gets the same 504 as from the edge's timer.
      if (s.ended && !s.res && streams.delete(sid)) sendJson({ type: 'abort', sid, reason: 'timeout' });
      s.req.destroy(new Error('local upstream timeout'));
      changed?.();
    });
    streams.set(sid, s);
  }

  return {
    streams,
    /** Handle a v1 frame; returns false for frames that are not part of the streaming protocol. */
    onMessage(data, isBinary, msg) {
      if (isBinary) {
        if (data.length < 5 || data[0] !== 1) return true;
        const sid = data.readUInt32BE(1);
        const s = streams.get(sid);
        const payload = data.subarray(5);
        // Credit returns once the bytes are flushed towards the local app.
        if (!s) return true;
        s.unflushed += payload.length;
        if (payload.length > STREAM_CHUNK_BYTES || s.unflushed > s.window + STREAM_CHUNK_BYTES || (s.websocket && !s.socket)) {
          drop(sid, { notify: true }); return true;
        }
        if (s.socket && !s.boundary.push(payload)) { drop(sid, { notify: true }); return true; }
        (s.socket || s.req).write(payload, (err) => {
          s.unflushed -= payload.length;
          if (err) drop(sid, { notify: true });
          else if (streams.has(sid)) sendJson({ type: 'ack', sid, bytes: payload.length });
        });
        return true;
      }
      const s = streams.get(msg.sid);
      switch (msg.type) {
        case 'req_start':
          // A throw (bad method or header from a misbehaving edge) must not escape the ws handler and kill the agent.
          drop(msg.sid);
          try { start(msg); } catch { drop(msg.sid); sendJson({ type: 'abort', sid: msg.sid }); }
          return true;
        case 'req_end':
          if (s && !s.ended) {
            s.ended = true;
            if (!s.res) s.req.setTimeout(headerWaitMs);
            s.req.end();
            changed?.();
          }
          return true;
        case 'abort': drop(msg.sid, { closeCode: msg.closeCode }); return true;
        case 'ack':
          if (s) {
            if (!Number.isSafeInteger(msg.bytes) || msg.bytes <= 0 || msg.bytes > s.inflight) { drop(msg.sid, { notify: true }); return true; }
            s.inflight -= msg.bytes;
            if (s.paused && s.inflight < s.window) { s.paused = false; s.res?.resume(); }
          }
          return true;
        default: return false;
      }
    },
    longBusy() { return [...streams.values()].some(s => s.websocket || s.drainUpload || !s.ended || s.res); },
    expire(long) {
      for (const s of streams.values()) if (!s.ended) s.drainUpload = true;
      for (const [sid, s] of streams) if (Boolean(s.websocket || s.drainUpload || !s.ended || s.res) === long) {
        sendJson({ type: 'abort', sid, reason: 'tunnel_disconnected', closeCode: 1001 });
        drop(sid, { closeCode: 1001 });
      }
    },
    closeAll() { for (const sid of [...streams.keys()]) drop(sid); },
  };
}

let activeSocket;
let activeHandoff;

export function connectWs(agentId, onWelcome, lifecycle) {
  const { tunnel: u } = validateEdgeConfig();
  u.searchParams.set('agentId', agentId);
  u.searchParams.delete('token');

  return new Promise((resolve) => {
    const ws = new WebSocket(u.toString(), { followRedirects: false, headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!lifecycle) activeSocket = ws;
    const buffered = lifecycle ? new Set() : null;
    let drainChange;
    const changed = lifecycle ? () => queueMicrotask(() => drainChange?.()) : undefined;
    const streams = createStreamHandler(ws, LOCAL_UPSTREAM, { changed });
    lifecycle?.opened({
      close: (code, reason) => ws.close(code, reason),
      busy: () => buffered.size + streams.streams.size,
      longBusy: () => streams.longBusy() || [...buffered].some(work => work.drainUpload || work.streaming || work.uploading),
      onDrainChange(fn) { drainChange = fn; },
      onDrainClose(fn) { ws.once('close', fn); },
      expireOrdinary() { this.expire(false); },
      expireStreams() { this.expire(true); },
      expire(long) {
        streams.expire(long);
        for (const work of buffered) if (work.uploading) work.drainUpload = true;
        for (const work of buffered) if (Boolean(work.drainUpload || work.streaming || work.uploading) === long) {
          work.cancelled = true;
          work.controller.abort();
          buffered.delete(work);
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'http_res', id: work.id, status: 502,
            headers: { 'content-type': 'application/json' },
            bodyBase64: Buffer.from(JSON.stringify({ error: 'tunnel_disconnected', id: work.id })).toString('base64') }));
        }
      },
    });
    ws.on('open', () => {
      console.log('[agent] tunnel connected');
      refreshOrigin();
      const probe = setInterval(refreshOrigin, 20000);
      probe.unref?.();
      ws.once('close', () => clearInterval(probe));
      startHeartbeat(ws, { status: currentOriginStatus, onMissed: lifecycle?.missed });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { streams.onMessage(data, true); return; }
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        console.log('[agent] tunnel ready');
        // Opt into streaming only when the edge offers it; older edges keep the v0 framing.
        if (Array.isArray(msg.caps) && msg.caps.includes('stream')) ws.send(JSON.stringify({ type: 'hello', caps: ['stream', ...(msg.caps.includes('ws') ? ['ws'] : [])] }));
        if (lifecycle) activeSocket = ws;
        onWelcome();
        return;
      }
      if (msg.type === 'pong') return;
      if (streams.onMessage(data, false, msg)) return;
      if (!lifecycle) { handleFrame(ws, msg); return; }
      if (msg.type === 'http_req') {
        const work = { id: msg.id, controller: new AbortController(), streaming: false, changed };
        buffered.add(work);
        handleFrame(ws, msg, work).catch(() => {}).finally(() => { buffered.delete(work); changed(); });
      }
    });
    ws.on('close', (code) => {
      for (const work of buffered || []) { work.cancelled = true; work.controller.abort(); }
      streams.closeAll();
      if (activeSocket === ws) activeSocket = undefined;
      console.warn(`[agent] ws closed ${code}`);
      lifecycle?.closed();
      resolve();
    });
    ws.on('error', () => console.error('[agent] connection error'));
  });
}

export async function reconnectLoop({ registerAgent = register, connect = connectWs, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), backoff = computeBackoffMs } = {}) {
  validateEdgeConfig();
  let attempt = 0;
  for (;;) {
    try {
      console.log('[agent] registering');
      const reg = await registerAgent();
      console.log('[agent] registered');
      if (process.env.AGENT_MAKE_BEFORE_BREAK === '1') {
        const handoff = createHandoff({ register: registerAgent, open(id, hooks) {
          let socket;
          const connection = connect(id, () => { attempt = 0; hooks.ready(); }, {
            opened(value) { socket = value; }, missed: hooks.missed, closed: hooks.closed,
          });
          if (!socket) { connection.catch(() => {}); throw new Error('tunnel open failed'); }
          connection.catch(hooks.closed);
          return socket;
        } });
        activeHandoff = handoff;
        await handoff.start(reg.id);
        activeHandoff = undefined;
      } else await connect(reg.id, () => { attempt = 0; });
    } catch (err) {
      console.error('[agent] registration or connection failed. Check the connection settings.');
    }
    const nextDelay = backoff(attempt);
    console.warn(`[agent] reconnect attempt ${attempt + 1}, next delay ${nextDelay}ms`);
    attempt += 1;
    await delay(nextDelay);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.env.FASTDOG_AGENT_NO_MAIN !== '1') {
  if (!TOKEN.trim()) {
    console.error('[agent] AGENT_TOKEN is required. Set the connection token before starting.');
    process.exit(1);
  }
  try { validateEdgeConfig(); } catch (err) {
    console.error('[agent] ' + err.message);
    process.exit(1);
  }
  const stop = () => {
    activeHandoff?.stop();
    if (activeSocket) {
      try { activeSocket.close(1000, 'shutdown'); } catch { /* Already closed. */ }
      setTimeout(() => {
        activeSocket?.terminate();
        process.exit(0);
      }, 100).unref();
      activeSocket.once('close', () => process.exit(0));
    } else {
      process.exit(0);
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  reconnectLoop();
}
