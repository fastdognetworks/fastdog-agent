import { existsSync, readdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Generic secret shapes only. Private words never live in this repository: maintainers list them in an
// untracked file named by NAME_SCAN_DENYLIST (one case-insensitive entry per line, # comments).
export const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

export function loadDenylist(file = process.env.NAME_SCAN_DENYLIST) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim().toLowerCase())
    .filter(line => line && !line.startsWith('#'));
}

// Loopback and RFC 5737 documentation ranges are the only IPv4 literals allowed.
function unsafeIp(ip) {
  const [a, b, c, d] = ip.split('.').map(Number);
  if ([a, b, c, d].some(n => n > 255)) return false;
  return !(a === 127 || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}

export function scanText(path, source, denylist = []) {
  const hits = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const lowered = line.toLowerCase();
    const ips = line.match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g) || [];
    if (denylist.some(entry => lowered.includes(entry)) || ips.some(unsafeIp) || secretPatterns.some(re => re.test(line))) {
      hits.push({ path, line: index + 1 });
    }
  });
  return hits;
}

// The denylist file is a local input and is never published.
export function scanRepository(root, denylist = loadDenylist(), skip = process.env.NAME_SCAN_DENYLIST) {
  const hits = [];
  const skipPath = skip && existsSync(skip) ? realpathSync(resolve(skip)) : null;
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (['node_modules', '.git'].includes(name)) continue;
      const full = join(dir,name), path = relative(root,full), stat = lstatSync(full);
      if (skipPath && !stat.isSymbolicLink() && realpathSync(full) === skipPath) continue;
      if (stat.isSymbolicLink() || /^\.env(?:\.|$)|\.(pem|key|p12|pfx)$/i.test(name)) { hits.push({ path, reason: 'sensitive file or symlink' }); continue; }
      hits.push(...scanText(path, path, denylist));
      if (stat.isDirectory()) walk(full);
      else {
        try {
          const bytes = readFileSync(full);
          if (bytes.includes(0)) throw new Error('binary');
          hits.push(...scanText(path, new TextDecoder('utf-8', { fatal: true }).decode(bytes), denylist));
        } catch { hits.push({ path, reason: 'unscannable' }); }
      }
    }
  }
  walk(root); return hits;
}
if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const denylist = loadDenylist();
  if (!denylist.length) console.error('NAME_SCAN_DENYLIST not set or empty; running generic checks only.');
  const hits = scanRepository(fileURLToPath(new URL('../../', import.meta.url)), denylist);
  console.log(JSON.stringify(hits, null, 2)); process.exitCode = hits.length ? 1 : 0;
}
