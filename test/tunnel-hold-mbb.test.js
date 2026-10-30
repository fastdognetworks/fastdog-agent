import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandoff, parseStreamDrainMs } from '../src/heartbeat.js';
// Deterministic timers, including cancellation/rearming within a callback (Node 18's
// experimental MockTimers can skip neighboring timers in that case).
const clocks = new WeakMap();
function fakeTimers(t) {
  let now = 0, next = 0;
  const pending = new Map();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    const timer = { id: ++next, unref() {} };
    pending.set(timer, { fn, at: now + ms }); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => pending.delete(timer));
  clocks.set(t, ms => {
    const end = now + ms;
    for (;;) {
      const entry = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > end) break;
      now = entry[1].at; pending.delete(entry[0]); entry[1].fn();
    }
    now = end;
  });
}
function tick(t, ms) { if (clocks.has(t)) clocks.get(t)(ms); else t.mock.timers.tick(ms); }
class Socket extends EventEmitter {
  readyState = 1; frames = []; count = 0;
  send(frame) { this.frames.push(JSON.parse(frame)); }
  close(code) { this.code = code; this.readyState = 3; this.emit('close'); }
  busy() { return this.count; }
}
test('agent standby opens first, swaps on welcome and drains with normal close', async t => {
  fakeTimers(t); const opened = [];
  const h = createHandoff({ register: async () => ({ id: 'next' }), open(id, hooks) { const s = new Socket(); s.hooks = hooks; s.on('close', hooks.closed); opened.push(s); return s; } });
  t.after(h.stop); h.start('first'); const old = opened[0]; old.hooks.ready(); old.count = 1;
  old.hooks.missed(); old.hooks.missed(); await Promise.resolve();
  assert.equal(opened.length, 2); assert.equal(old.readyState, 1);
  opened[1].hooks.ready(); assert.equal(old.readyState, 1);
  old.count = 0; tick(t, 250); assert.equal(old.code, 1000);
});
test('agent old dies while registration pending returns to reconnect loop', async () => {
  let resolveRegister; let old; let opens = 0;
  const h = createHandoff({ register: () => new Promise(resolve => { resolveRegister = resolve; }), open(id, hooks) { opens++; old = new Socket(); old.hooks = hooks; old.on('close', hooks.closed); return old; } });
  const done = h.start('first'); old.hooks.ready(); old.hooks.missed(); old.close(1006);
  await done; resolveRegister({ id: 'late' }); await Promise.resolve(); assert.equal(opens, 1);
});
test('agent repeated welcome cannot close active or rearm welcome timeout', t => {
  fakeTimers(t); const opened = [];
  const h = createHandoff({ register: async () => ({ id: 'next' }), pendingMs: 15, drainMs: 30, open(id, hooks) { const s = new Socket(); s.hooks = hooks; s.on('close', hooks.closed); opened.push(s); return s; } });
  t.after(h.stop); h.start('first'); opened[0].hooks.ready(); opened[0].hooks.ready();
  assert.equal(opened[0].readyState, 1);
  tick(t, 15); assert.equal(opened[0].readyState, 1);
});
test('first missed pong starts standby before heartbeat termination', async t => {
  const { startHeartbeat } = await import('../src/heartbeat.js');
  t.mock.timers.enable(Number(process.versions.node.split('.')[0]) < 20 ? ['setInterval'] : { apis: ['setInterval'] }); const ws = new Socket(); let missed = 0;
  ws.terminate = () => ws.close(1006);
  const stop = startHeartbeat(ws, { intervalMs: 20, onMissed() { missed++; assert.equal(ws.readyState, 1); } });
  t.after(stop);
  tick(t, 20); assert.equal(missed, 0);
  tick(t, 20); assert.equal(missed, 1); assert.equal(ws.readyState, 1);
  tick(t, 20); assert.equal(ws.readyState, 3);
});
test('agent unwelcomed standby expires while active survives', async t => {
  fakeTimers(t); const opened = [];
  const h = createHandoff({ register: async () => ({ id: 'next' }), pendingMs: 15, open(id, hooks) { const s = new Socket(); s.hooks = hooks; s.on('close', hooks.closed); opened.push(s); return s; } });
  t.after(h.stop); h.start('first'); opened[0].hooks.ready(); h.replace(); await Promise.resolve();
  tick(t, 15); assert.equal(opened[0].readyState, 1); assert.equal(opened[1].code, 1000);
});
test('agent forcibly finishes a busy drain at the bound', async t => {
  fakeTimers(t); let now = 0; t.mock.method(Date, 'now', () => now);
  const opened = [];
  const h = createHandoff({ register: async () => ({ id: 'next' }), drainMs: 30, open(id, hooks) { const s = new Socket(); s.hooks = hooks; s.on('close', hooks.closed); opened.push(s); return s; } });
  t.after(h.stop); h.start('first'); opened[0].hooks.ready(); opened[0].count = 1;
  h.replace(); await Promise.resolve(); opened[1].hooks.ready();
  now = 31; tick(t, 31); assert.equal(opened[0].code, 1000); assert.equal(opened[1].readyState, 1);
});
test('agent separate drain caps preserve long work, close on completion without polling', async t => {
  fakeTimers(t); const opened = [];
  const h = createHandoff({ register: async () => ({ id: 'next' }), drainMs: 30, streamDrainMs: 100,
    open(id, hooks) {
      const s = new Socket(); s.hooks = hooks; s.ordinary = 0; s.long = 0;
      s.busy = () => s.ordinary + s.long; s.longBusy = () => s.long;
      s.expireOrdinary = () => { s.ordinary = 0; };
      s.expireStreams = () => { s.long = 0; };
      s.onDrainChange = fn => { s.changed = fn; };
      s.onDrainClose = fn => s.once('close', fn);
      s.on('close', hooks.closed); opened.push(s); return s;
    } });
  t.after(h.stop); h.start('first'); const old = opened[0]; old.hooks.ready(); old.ordinary = 1; old.long = 2;
  h.replace(); await Promise.resolve(); opened[1].hooks.ready();
  tick(t, 30); assert.equal(old.ordinary, 0); assert.equal(old.long, 2); assert.equal(old.readyState, 1);
  tick(t, 69); assert.equal(old.readyState, 1);
  tick(t, 1); assert.equal(old.code, 1000);
  const second = opened[1]; second.long = 1;
  h.replace(); await Promise.resolve(); opened[2].hooks.ready();
  second.long = 0; second.changed(); assert.equal(second.code, 1000);
});
test('agent real stream handler separates header waits, response streams and uploads', async t => {
  fakeTimers(t);
  const http = (await import('node:http')).default;
  const { createStreamHandler } = await import('../src/index.js');
  const origins = [];
  t.mock.method(http, 'request', (_options, respond) => {
    const req = Object.assign(new EventEmitter(), {
      setTimeout() {}, end() { this.writableFinished = true; },
      destroy() { this.destroyed = true; }, write(_data, cb) { cb?.(); },
    });
    origins.push({ req, respond }); return req;
  });
  const ws = new Socket(); let changes = 0;
  const handler = createStreamHandler(ws, 'http://127.0.0.1:9', { changed() { changes++; } });
  const send = msg => handler.onMessage(null, false, msg);
  for (const sid of [1, 2, 3]) send({ type: 'req_start', sid, method: 'POST', path: '/' });
  send({ type: 'req_end', sid: 1 }); send({ type: 'req_end', sid: 2 });
  const res = Object.assign(new EventEmitter(), { headers: { 'transfer-encoding': 'chunked' }, destroy() { this.destroyed = true; } });
  origins[1].respond(res);
  setTimeout(() => handler.expire(false), 30000);
  tick(t, 31000);
  assert.deepEqual([...handler.streams.keys()], [2, 3]);
  assert.equal(origins[0].req.destroyed, true);
  assert.equal(origins[1].req.destroyed, undefined); assert.equal(origins[2].req.destroyed, undefined);
  assert.equal(handler.longBusy(), true);
  assert.ok(ws.frames.some(f => f.sid === 1 && f.reason === 'tunnel_disconnected'));
  const before = changes;
  res.emit('end'); assert.ok(changes > before);
  assert.deepEqual([...handler.streams.keys()], [3]);
  send({ type: 'req_end', sid: 3 });
  handler.expire(false); // ordinary cap has already elapsed; completion triggers another check
  assert.equal(handler.streams.has(3), true);
  assert.equal(handler.longBusy(), true);
  assert.equal(origins[2].req.destroyed, undefined);
  origins[2].req.emit('timeout');
  assert.equal(handler.streams.size, 0); assert.equal(origins[2].req.destroyed, true);
  assert.ok(ws.frames.some(f => f.sid === 3 && f.reason === 'timeout'));
});
test('agent shorter stream cap leaves ordinary work until its own deadline', async t => {
  fakeTimers(t); const opened = [];
  const h = createHandoff({ register: async () => ({ id: 'next' }), drainMs: 100, streamDrainMs: 30,
    open(id, hooks) {
      const s = new Socket(); s.hooks = hooks; s.ordinary = 1; s.long = 1;
      s.busy = () => s.ordinary + s.long; s.longBusy = () => s.long;
      s.expireOrdinary = () => { s.ordinary = 0; }; s.expireStreams = () => { s.long = 0; };
      s.onDrainChange = () => {}; s.onDrainClose = fn => s.once('close', fn);
      s.on('close', hooks.closed); opened.push(s); return s;
    } });
  t.after(h.stop); h.start('first'); opened[0].hooks.ready();
  h.replace(); await Promise.resolve(); opened[1].hooks.ready();
  tick(t, 30); assert.equal(opened[0].long, 0); assert.equal(opened[0].ordinary, 1); assert.equal(opened[0].readyState, 1);
  tick(t, 70); assert.equal(opened[0].code, 1000);
});
test('agent drain env is parsed only when creating a handoff', async t => {
  const previous = process.env.AGENT_MBB_STREAM_DRAIN_MS;
  process.env.AGENT_MBB_STREAM_DRAIN_MS = 'invalid';
  const warnings = []; t.mock.method(console, 'warn', message => warnings.push(message));
  try {
    const module = await import('../src/heartbeat.js?lazy-drain');
    assert.deepEqual(warnings, []);
    const handoff = module.createHandoff({});
    assert.deepEqual(warnings, ['invalid AGENT_MBB_STREAM_DRAIN_MS; using default']);
    handoff.stop();
  } finally {
    if (previous === undefined) delete process.env.AGENT_MBB_STREAM_DRAIN_MS;
    else process.env.AGENT_MBB_STREAM_DRAIN_MS = previous;
  }
});
test('connector stream drain parser validates bounds without exposing input', () => {
  const warnings = [];
  for (const [value, expected] of [[undefined, 600000], ['1000', 1000], ['3600000', 3600000], ['999', 600000], ['3600001', 600000], ['0', 600000], ['1.5', 600000], ['private-input', 600000]]) {
    assert.equal(parseStreamDrainMs(value, message => warnings.push(message)), expected);
  }
  assert.equal(warnings.length, 5); assert.ok(warnings.every(message => !message.includes('private-input')));
});
