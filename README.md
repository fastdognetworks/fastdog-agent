# FastDog Agent

An outbound connector that registers with an edge, opens a WebSocket tunnel,
and forwards HTTP requests to a configured local application. Supports buffered
v0 and negotiated streaming v1 with credit flow control and reconnect backoff.

**Release v0.2.2-oss:** based on agent 0.2.1 plus later tunnel-continuity work (optional make-before-break reconnect via AGENT_MAKE_BEFORE_BREAK and AGENT_MBB_STREAM_DRAIN_MS, off by default). The runtime is therefore not identical to the 0.2.1 release; package.json still reports 0.2.1 in heartbeats.

Requires Node.js 20 or later. Configure your environment before starting; obtain
credentials from your edge operator. Never put credentials in command arguments.

```sh
npm ci --ignore-scripts
npm test
node src/index.js
```

Build a local image, then pass configuration from the shell environment:

```sh
docker build -t fastdog-agent:0.2.1 .
docker run --rm --name fastdog-agent \
  -e AGENT_TOKEN -e AGENT_NAME -e AGENT_HOSTNAME -e AGENT_LOCAL_UPSTREAM \
  -e EDGE_HTTP_URL -e EDGE_WS_URL fastdog-agent:0.2.1
```

No published image is implied. The local application must be reachable from the
container; container loopback refers to the container itself. No inbound port
mapping is required. The connector opens outbound connections to the edge and
the configured application; it does not listen for incoming connections.

Configuration names:

- AGENT_TOKEN
- AGENT_NAME
- AGENT_HOSTNAME
- AGENT_LOCAL_UPSTREAM
- EDGE_HTTP_URL
- EDGE_WS_URL
- FASTDOG_ALLOW_INSECURE_EDGE
- AGENT_MAKE_BEFORE_BREAK
- AGENT_MBB_STREAM_DRAIN_MS
- FASTDOG_AGENT_NO_MAIN (test/import use)

The configurable default edge is https://fastdognetworks.com, with its secure
WebSocket tunnel at /_fastdog/tunnel. The local application defaults to
http://127.0.0.1:9999. Example hostnames should use app.example.com.

Edge connections require TLS except literal loopback or an explicit development
opt-out. Credentials travel in Authorization headers; redirects are disabled.
Forwarding pins the destination to the configured application while preserving
client Host. Only expose an application intended for remote access. The edge
can read and send application traffic. Origin reachability uses HEAD and skips
certificate verification for that probe only; forwarded HTTPS verifies certificates.

See SECURITY.md for scope, TESTING.md for coverage and limitations, and
CONTRIBUTING.md for development. Licensed under Apache-2.0; see LICENSE and NOTICE.
