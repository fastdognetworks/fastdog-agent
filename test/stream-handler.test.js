import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createStreamHandler, STREAM_WINDOW_BYTES, ORIGIN_IDLE_MS, ORIGIN_HEADER_WAIT_MS } from '../src/index.js';

test('agent answers abort instead of throwing on a req_start it cannot issue', () => {
  const sent = [];
  const handler = createStreamHandler({ readyState: 1, send: s => sent.push(JSON.parse(s)) }, 'http://127.0.0.1:9');
  assert.doesNotThrow(() => handler.onMessage(null, false, { type: 'req_start', sid: 7, method: 'BAD METHOD', path: '/' }));
  assert.deepEqual(sent, [{ type: 'abort', sid: 7 }]); assert.equal(handler.streams.size, 0);
});

function fixture(t) {
  const requests = [], sent = [];
  t.mock.method(http, 'request', (options, respond) => {
    const req = Object.assign(new EventEmitter(), { timeout: options.timeout, setTimeout(ms) { this.timeout = ms; }, end() { this.writableFinished = true; }, destroy() { this.destroyed = true; }, write(data, cb) { this.body = data; cb(); } });
    requests.push({ req, respond }); return req;
  });
  const handler = createStreamHandler({ readyState: 1, send: data => sent.push(Buffer.isBuffer(data) ? data : JSON.parse(data)) }, 'http://127.0.0.1:9');
  t.after(() => handler.closeAll());
  const send = msg => handler.onMessage(null, false, msg);
  send({ type: 'req_start', sid: 1, method: 'POST', path: '/' });
  const res = Object.assign(new EventEmitter(), { headers: {}, statusCode: 200, pause() { this.paused = true; }, resume() { this.paused = false; }, destroy() { this.destroyed = true; } });
  return { handler, send, sent, res, ...requests[0] };
}
test('header wait extends after upload and idle timeout resumes after response headers', t => {
  const f = fixture(t); assert.equal(f.req.timeout, ORIGIN_IDLE_MS);
  f.send({ type: 'req_end', sid: 1 }); assert.equal(f.req.timeout, ORIGIN_HEADER_WAIT_MS);
  f.respond(f.res); assert.equal(f.req.timeout, ORIGIN_IDLE_MS);
  f.res.emit('end'); assert.equal(f.handler.streams.size, 0);
});
test('silent origin header expiry aborts with timeout reason', t => {
  const f = fixture(t); f.send({ type: 'req_end', sid: 1 }); f.req.emit('timeout');
  assert.deepEqual(f.sent, [{ type: 'abort', sid: 1, reason: 'timeout' }]); assert.equal(f.req.destroyed, true);
});
test('stream credit pauses and resumes response; upload returns ack; abort cleans up', t => {
  const f = fixture(t); const frame = Buffer.alloc(8); frame[0] = 1; frame.writeUInt32BE(1, 1);
  f.handler.onMessage(frame, true); assert.equal(f.req.body.length, 3);
  assert.deepEqual(f.sent[0], { type: 'ack', sid: 1, bytes: 3 });
  f.respond(f.res); f.res.emit('data', Buffer.alloc(STREAM_WINDOW_BYTES)); assert.equal(f.res.paused, true);
  assert.ok(f.sent.filter(Buffer.isBuffer).every(b => b.length <= 65541));
  f.send({ type: 'ack', sid: 1, bytes: STREAM_WINDOW_BYTES }); assert.equal(f.res.paused, false);
  f.send({ type: 'abort', sid: 1 }); assert.equal(f.req.destroyed, true); assert.equal(f.res.destroyed, true); assert.equal(f.handler.streams.size, 0);
});
test('origin failure aborts and cleans up', t => {
  const f = fixture(t); f.req.emit('error', new Error('fixture failure'));
  assert.deepEqual(f.sent, [{ type: 'abort', sid: 1, closeCode: 1011 }]); assert.equal(f.handler.streams.size, 0);
});
test('early response completes while upload is unfinished', t => {
  const f = fixture(t); f.respond(f.res); f.res.emit('end');
  assert.equal(f.req.destroyed, true); assert.equal(f.sent.at(-1).type, 'res_end');
});

test('incomplete response aborts and destroys origin resources', t => {
  const f = fixture(t); f.respond(f.res); f.res.emit('close');
  assert.equal(f.sent.at(-1).type, 'abort'); assert.equal(f.handler.streams.size, 0);
  assert.equal(f.req.destroyed, true); assert.equal(f.res.destroyed, true);
});
