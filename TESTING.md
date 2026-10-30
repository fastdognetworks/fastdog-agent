# Testing

Run `npm ci --offline --ignore-scripts` when the npm cache is populated, then
`npm test` and `npm run scan:names`.
No git checkout, edge service, Docker or external network is needed. All actual
socket listeners and connections in tests use 127.0.0.1. Non-loopback examples
are transport-validation inputs only.

Suites cover authentication headers, redacted errors, shutdown, TLS, redirect
refusal, destination pinning, backoff, heartbeat, origin probes and
make-before-break. ws-frames.test.js covers frame boundaries, length encodings,
masking, close tracking and invalid lengths. mock-tunnel.test.js runs a real agent against an in-process
mock edge with buffered (v0) and streaming (v1) framing; it checks a 3 MiB echo
across credit windows in both modes and a negotiated v1 WebSocket upgrade with
messages relayed in both directions. stream-handler.test.js covers connector
header-wait, flow control, abort and early-response behavior. The mock is not a
production edge and does not claim to validate routing or edge policy.
The scanner walks untracked files too, rejects unscannable files, and has no
legacy exemptions. Loopback addresses are the sole non-RFC5737 IPv4 exception.
Private words are read only from the optional untracked NAME_SCAN_DENYLIST file
(see CONTRIBUTING.md); without it the scan runs generic checks only.

## Scope

Edge-side behavior (registration policy, request holding, body limits, ingress
trust, DNS checks) and installer/release tooling live outside this repository
and are not tested here. Connector-side counterparts are covered by the suites
above.

## Validation

The complete suite must pass on Node 20 or later with local sockets and
subprocesses permitted.
