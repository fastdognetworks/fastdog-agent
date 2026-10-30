import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { scanRepository, scanText, loadDenylist } from './helpers/name-scanner.js';
test('standalone repository contains no denied names, addresses, secrets or sensitive files', () => {
  assert.deepEqual(scanRepository(fileURLToPath(new URL('../', import.meta.url))), []);
});
test('scanner detects case insensitive denylist entries, unsafe IPv4 and secret shapes', () => {
  assert.equal(scanText('fixture', 'SYNTHETIC-MARKER', ['marker']).length, 1);
  for (const octets of [[10,1,2,3], [172,16,0,1], [172,31,0,1], [192,168,1,1], [8,8,8,8]]) {
    assert.equal(scanText('fixture', octets.join('.')).length, 1);
  }
  for (const ip of ['127.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1']) assert.deepEqual(scanText('fixture', ip), []);
  for (const secret of ['-----BEGIN ' + 'RSA PRIVATE KEY-----', 'AKIA' + 'A'.repeat(16), 'ghp_' + 'a'.repeat(36), 'xoxb-' + '1'.repeat(12)]) {
    assert.equal(scanText('fixture', secret).length, 1, secret);
  }
});
test('denylist is optional, untracked input with comments ignored', t => {
  assert.deepEqual(loadDenylist(''), []);
  assert.deepEqual(loadDenylist(fileURLToPath(new URL('../.scanner-fixture-absent', import.meta.url))), []);
  const file = fileURLToPath(new URL('../.scanner-denylist-fixture', import.meta.url));
  writeFileSync(file, '# comment\n\n  Marker \n'); t.after(() => rmSync(file, { force: true }));
  assert.deepEqual(loadDenylist(file), ['marker']);
});
test('walk includes untracked and hidden files, rejects symlinks and binary files', t => {
  const root = fileURLToPath(new URL('../.scanner-fixture/', import.meta.url));
  mkdirSync(root); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(root + '.hidden', 'marker'); writeFileSync(root + 'binary', Buffer.from([0]));
  writeFileSync(root + 'denylist', 'marker');
  symlinkSync('.hidden', root + 'link');
  for (const dir of ['node_modules', '.git']) { mkdirSync(root + dir); writeFileSync(root + dir + '/ignored', 'marker'); }
  assert.equal(scanRepository(root, ['marker'], root + 'denylist').length, 3);
});
