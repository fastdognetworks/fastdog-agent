import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

// A protocol fixture, not a production edge or authentication implementation.
export async function mockEdge({ credential, streaming = true } = {}) {
  const frames = [], requests = [];
  let socket, next = 0;
  const pending = new Map();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${credential}`) { res.writeHead(401).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'fixture-agent' }));
  });
  const wss = new WebSocketServer({ server });
  const send = msg => socket.send(JSON.stringify(msg));
  const connected = new Promise(resolve => wss.on('connection', (ws, req) => {
    if (req.headers.authorization !== `Bearer ${credential}`) { ws.close(4401); return; }
    socket = ws;
    ws.on('message', (data, binary) => {
      const msg = binary ? { type: 'data', sid: data.readUInt32BE(1), body: data.subarray(5) } : JSON.parse(data);
      frames.push(msg);
      if (msg.type === 'ping') send({ type: 'pong' });
      const p = pending.get(msg.sid ?? msg.id);
      if (!p) return;
      if (msg.type === 'ack') { p.credit += msg.bytes; p.pump(); }
      if (msg.type === 'res_start') Object.assign(p.result, { status: msg.status, headers: msg.headers });
      if (msg.type === 'data') { p.chunks.push(msg.body); send({ type: 'ack', sid: msg.sid, bytes: msg.body.length }); }
      if (msg.type === 'http_res') Object.assign(p.result, { status: msg.status, headers: msg.headers, body: Buffer.from(msg.bodyBase64 || '', 'base64') });
      if (['res_end', 'http_res', 'abort'].includes(msg.type)) {
        clearTimeout(p.timer); pending.delete(msg.sid ?? msg.id);
        if (msg.type === 'abort') p.reject(new Error(msg.reason || 'aborted'));
        else p.resolve({ ...p.result, body: p.result.body ?? Buffer.concat(p.chunks) });
      }
    });
    send({ type: 'welcome', ...(streaming ? { caps: ['stream'] } : {}) });
    resolve(ws);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, connected, frames, requests, send,
    request({ method = 'POST', path = '/', headers = { host: 'app.example.com' }, body = Buffer.alloc(0) } = {}) {
      const sid = ++next;
      return new Promise((resolve, reject) => {
        const p = { resolve, reject, result: {}, chunks: [], credit: 1024 * 1024, offset: 0, ended: false };
        p.timer = setTimeout(() => { pending.delete(sid); reject(new Error('mock request timeout')); }, 5000);
        p.pump = () => {
          while (p.offset < body.length && p.credit > 0) {
            const chunk = body.subarray(p.offset, p.offset + Math.min(p.credit, 65536));
            const head = Buffer.alloc(5); head[0] = 1; head.writeUInt32BE(sid, 1);
            socket.send(Buffer.concat([head, chunk])); p.offset += chunk.length; p.credit -= chunk.length;
          }
          if (p.offset === body.length && !p.ended) { p.ended = true; send({ type: 'req_end', sid }); }
        };
        pending.set(sid, p);
        if (streaming) { send({ type: 'req_start', sid, method, path, headers }); p.pump(); }
        else send({ type: 'http_req', id: sid, method, path, headers, bodyBase64: body.toString('base64') });
      });
    },
    async close() {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('mock closed')); }
      pending.clear(); for (const ws of wss.clients) ws.terminate();
      server.closeAllConnections();
      await Promise.all([new Promise(resolve => wss.close(resolve)), new Promise(resolve => server.close(resolve))]);
    },
  };
}
