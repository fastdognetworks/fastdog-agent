import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchLocal, createStreamHandler } from '../src/index.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
test('agent v0 and v1 pin upstream for absolute, network-path and backslash targets', { timeout: 10000 }, async t => {
  let escaped = 0;
  const seen = [];
  const other = http.createServer((req, res) => { escaped++; res.end('wrong'); });
  const origin = http.createServer((req, res) => { seen.push({ url: req.url, host: req.headers.host }); res.end('pinned'); });
  const [port, otherPort] = await Promise.all([listen(origin), listen(other)]);
  t.after(() => { for (const server of [origin, other]) { server.closeAllConnections(); server.close(); } });
  const upstream = `http://127.0.0.1:${port}`;
  const authority = `127.0.0.1:${otherPort}`;
  const paths = [`http://${authority}/escape?q=1`, `//${authority}/escape`, `\\\\${authority}/escape`, `/\\${authority}/escape`, `/example%2Ftest?q=1`];
  for (const path of paths) {
    const result = await fetchLocal('GET', path, { host: 'app.example.com' }, null, upstream);
    assert.equal(result.body.toString(), 'pinned');
    await new Promise((resolve, reject) => {
      const handler = createStreamHandler({ readyState: 1, send(data) {
        if (Buffer.isBuffer(data)) return;
        const frame = JSON.parse(data);
        if (frame.type === 'abort') reject(new Error('unexpected abort'));
        if (frame.type === 'res_end') resolve();
      } }, upstream);
      t.after(() => handler.closeAll());
      handler.onMessage(null, false, { type: 'req_start', sid: 1, method: 'GET', path, headers: { host: 'app.example.com' } });
      handler.onMessage(null, false, { type: 'req_end', sid: 1 });
    });
  }
  assert.equal(escaped, 0);
  assert.equal(seen.length, paths.length * 2);
  assert.ok(seen.every(req => req.host === 'app.example.com'));
  assert.equal(seen.at(-1).url, '/example%2Ftest?q=1');
});
