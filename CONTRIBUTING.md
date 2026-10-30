# Contributing

Use Node.js 20 or later. Run npm ci --ignore-scripts, npm test and npm run scan:names.
Tests use loopback fixtures and require permission to bind local sockets. Avoid
external services and use example.com and RFC 5737 addresses for fixtures.

The committed scanner checks only generic patterns (non-loopback, non-RFC 5737
IPv4 addresses, common secret formats, sensitive files). Maintainers may also set
NAME_SCAN_DENYLIST to an untracked file of private words, one per line (`#` for
comments, matched case-insensitively as substrings). Keep that file outside the
repository or name it `.name-scan-denylist`, which is gitignored; it is skipped
when absent.

Keep changes focused, describe behavior and validation, and retain dependency
integrity hashes. Do not submit credentials, environment files or identifying
customer information. Report security issues using SECURITY.md.

Contributions are under Apache-2.0.

CI runs `npm test` and `npm run scan:names` on Node 20 and 22.
