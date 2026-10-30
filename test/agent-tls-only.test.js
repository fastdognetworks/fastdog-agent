import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { validateEdgeUrl } from '../src/index.js';

function run(code, extra = {}) {
  const result = spawnSync(process.execPath, code ? ['--input-type=module', '-e', code] : ['src/index.js'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, AGENT_TOKEN: 'synthetic-private-token', FASTDOG_AGENT_NO_MAIN: '0',
      FASTDOG_ALLOW_INSECURE_EDGE: '', EDGE_HTTP_URL: 'https://edge.example.com',
      EDGE_WS_URL: 'wss://edge.example.com/tunnel',
      NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require=' + process.cwd() + '/test/helpers/no-agent-network.cjs',
      ...extra },
  });
  assert.ifError(result.error);
  return result;
}

test('plaintext edge startup refuses before any fetch, socket or credential transmission', () => {
  for (const flag of ['', '0', 'true', '01', ' 1', '1 ']) {
    for (const setting of ['EDGE_HTTP_URL', 'EDGE_WS_URL']) {
      const scheme = setting === 'EDGE_HTTP_URL' ? 'http' : 'ws';
      const result = run(null, { [setting]: scheme + '://user:synthetic-password@edge.example.com', FASTDOG_ALLOW_INSECURE_EDGE: flag });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /refuses plaintext.*FASTDOG_ALLOW_INSECURE_EDGE=1/);
      assert.doesNotMatch(result.stderr + result.stdout, /UNEXPECTED_AGENT|synthetic-private-token|synthetic-password|user:/);
    }
  }
});

test('TLS and only literal loopback hosts pass transport validation', () => {
  for (const host of ['localhost', '127.0.0.1', '127.0.0.1', '[::1]']) {
    for (const [kind, scheme] of [['ws', 'ws'], ['http', 'http']]) {
      assert.equal(validateEdgeUrl(scheme + '://' + host, kind, '').protocol, scheme + ':');
    }
  }
  for (const host of ['sub.localhost', 'localhost.', 'localhost.example.com', '192.0.2.1', '[::ffff:127.0.0.1]']) {
    assert.throws(() => validateEdgeUrl('ws://' + host, 'ws', ''), /refuses plaintext/);
  }
  for (const [kind, scheme] of [['ws', 'wss'], ['http', 'https']]) {
    assert.equal(validateEdgeUrl(scheme + '://edge.example.com', kind, '').protocol, scheme + ':');
  }
  assert.throws(() => validateEdgeUrl('file:///example', 'ws', '1'), /must use/);
  assert.throws(() => validateEdgeUrl('invalid', 'http', ''), /valid edge URL/);
});

test('exact opt-out allows plaintext and warns once across repeated validation', () => {
  const result = run("const {validateEdgeConfig} = await import('./src/index.js'); validateEdgeConfig(); validateEdgeConfig();", {
    EDGE_HTTP_URL: 'http://edge.example.com', EDGE_WS_URL: 'ws://edge.example.com',
    FASTDOG_ALLOW_INSECURE_EDGE: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stderr.match(/WARNING/g) || []).length, 1);
  assert.match(result.stderr, /credentials and traffic may be exposed/);
});

test('direct registration and reconnect entry points validate both URLs before work', () => {
  for (const call of ['await register()', "await reconnectLoop({registerAgent: () => { throw new Error('unexpected registration'); }})", "connectWs('synthetic-id', () => {})"]) {
    const result = run("const {register, reconnectLoop, connectWs} = await import('./src/index.js'); " + call, { EDGE_WS_URL: 'ws://edge.example.com' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refuses plaintext/);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_AGENT|unexpected registration/);
  }
});

test('registration disables redirects and ignores response edge URLs', () => {
  const result = run(`
    const {register} = await import('./src/index.js');
    globalThis['fetch'] = async (url, options) => {
      if (options['redirect'] !== 'error') throw new Error('redirects enabled');
      return {ok: true, json: async () => ({id: 'synthetic-id', url: 'ws://other.example.com'})};
    };
    await register();
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('HTTP and WebSocket redirects never reach the redirect destination', { timeout: 15000 }, async (t) => {
  let destinationRequests = 0;
  const destination = http.createServer((_req, res) => { destinationRequests++; res.end(); });
  const source = http.createServer((_req, res) => {
    res.writeHead(307, { location: 'http://127.0.0.1:' + destination.address().port + '/redirected' });
    res.end();
  });
  for (const server of [source, destination]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
  }
  const base = '127.0.0.1:' + source.address().port;
  for (const code of [
    "const {register} = await import('./src/index.js'); try { await register(); process['exitCode'] = 2; } catch {}",
    "const {connectWs} = await import('./src/index.js'); await connectWs('synthetic-id', () => { process['exitCode'] = 2; });",
  ]) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, FASTDOG_AGENT_NO_MAIN: '1', FASTDOG_ALLOW_INSECURE_EDGE: '',
        AGENT_TOKEN: 'synthetic-private-token', EDGE_HTTP_URL: 'http://' + base, EDGE_WS_URL: 'ws://' + base },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    assert.deepEqual(await once(child, 'exit'), [0, null], output);
    assert.doesNotMatch(output, /synthetic-private-token/);
  }
  assert.equal(destinationRequests, 0);
});
