# FastDog Agent

An outbound connector that registers with the FastDog edge and keeps a WebSocket tunnel open.
It forwards HTTP and WebSocket requests to one local application.

## Release 0.2.3

```
ghcr.io/fastdognetworks/fastdog-agent:0.2.3@sha256:4346a2cf39fe14e511351d7bc9f48bee2a820865de2e3b48ef66bbd8f06e2100
```

The files in `src/` are the same as `/app/agent` in that image. The only difference is
the descriptive comment in the first nine lines of `src/index.js`. `package.json` and
`package-lock.json` differ only in metadata: they add license, engines, scripts and files
fields and drop the private flag. The `ws` dependency (8.21.3) is the same.

Pull by digest so you get exactly this build.

## What it does / what it can see

This section describes the code in `src/` at this release. Each point can be checked against it.

### What it does

- **Outbound connections only.** On start it registers with the edge over HTTPS
  (`POST /_fastdog/agents/register`), then keeps a WebSocket tunnel open to the edge
  (`/_fastdog/tunnel`). It never opens a listening port, so you don't forward any
  inbound port to it.
- **Carries HTTP and WebSocket traffic for your hostname.** The edge sends it HTTP
  requests for the hostname you registered. It forwards each one to your local
  application and sends the response back. It also carries WebSocket connections:
  `GET` requests with `Upgrade: websocket`. It does not carry raw TCP, UDP or
  `CONNECT` tunnels.
- **Talks to one local address.** Every request goes to the single address in
  `AGENT_LOCAL_UPSTREAM`. Only the path and query of an incoming request are used, so
  a request can't point the connector at a different host. The client's `Host`
  header is passed through to your application. Redirects from the edge are not
  followed.
- **Reports health.** Every 20 seconds it sends the edge a heartbeat. The heartbeat
  says whether your application answered a `HEAD` probe, when that probe ran, and
  the connector version. The probe skips certificate checks. Forwarded HTTPS requests
  do verify certificates.
- **Reconnects.** If the tunnel drops, it reconnects with backoff of up to 30 seconds.

### Where encryption starts and stops

- **Visitor to edge:** TLS for your public hostname terminates at the FastDog edge.
  The edge decrypts each request, so it handles your traffic as plain HTTP: method,
  path, headers (including cookies and authorization headers) and body. The same
  goes for your application's responses.
- **Edge to connector:** the registration call and the tunnel use TLS (`https://`
  and `wss://`). Plaintext edge URLs are refused unless they point at loopback or you
  set `FASTDOG_ALLOW_INSECURE_EDGE=1`, which is for local development only.
- **Connector to your application:** this uses the scheme in `AGENT_LOCAL_UPSTREAM`
  (`http://` or `https://`).

### What the connector can see

- The full requests it forwards to your application and the full responses it gets
  back, including headers and bodies, plus the messages on any WebSocket connection
  it carries. Buffered (v0) requests are held in memory whole. Streaming (v1)
  requests pass through in chunks.
- Its own settings: the token, name, hostname, local application URL and edge URLs.
  It sends the name, hostname and local application URL to the edge when it
  registers.
- If your application can't be reached, the connection error message is returned
  to the edge in a 502 response.

### What it stores

- **Nothing on disk.** It reads the token from the `AGENT_TOKEN` environment variable
  and keeps it in memory. It sends the token only in an `Authorization: Bearer`
  header, never in a URL.
- **Where the token lives is up to you.** With Docker, it's in the environment you
  pass to the container. The FastDog install script saves it in
  `/etc/fastdog-agent/<name>.env` with mode `600`. Anyone with the token can connect
  as this connector, so protect that file and rotate the token if it leaks.
- **Logs** are short status lines on stdout and stderr, such as connected, registered,
  reconnect attempts and configuration errors. They don't include request contents
  or the token.

### What it does not do

- It doesn't listen for inbound connections. The only messages it acts on from the
  edge are requests to forward and the tunnel's own control messages (welcome,
  heartbeat replies, stream data, flow control and abort).
- It doesn't run programs, read or write your files (it only reads its own
  `package.json` to report its version), update itself, or send telemetry beyond the
  heartbeat described above.
- It doesn't connect anywhere except the edge URLs and the local application you
  configure.

## Run it

Get the edge URLs and token from your FastDog portal. Set the variables in your
shell environment, then pass them by name so the token is never a command argument:

```sh
docker run --rm \
  -e AGENT_TOKEN -e AGENT_NAME -e AGENT_HOSTNAME -e AGENT_LOCAL_UPSTREAM \
  -e EDGE_HTTP_URL -e EDGE_WS_URL \
  ghcr.io/fastdognetworks/fastdog-agent:0.2.3@sha256:4346a2cf39fe14e511351d7bc9f48bee2a820865de2e3b48ef66bbd8f06e2100
```

Loopback inside a container is the container itself. Set `AGENT_LOCAL_UPSTREAM`
to an address reachable from the container. No inbound port mapping is needed.

### Run from source

```sh
npm ci --ignore-scripts
node src/index.js
```

### Build locally

```sh
docker build -t fastdog-agent:local .
```

## Configuration

| Variable | Meaning |
| --- | --- |
| `AGENT_TOKEN` | Required for startup; empty or whitespace-only values are rejected. |
| `AGENT_NAME` | Name sent at registration; defaults to an empty string. |
| `AGENT_HOSTNAME` | Hostname sent at registration; defaults to an empty string. |
| `AGENT_LOCAL_UPSTREAM` | Local application URL; defaults to `http://127.0.0.1:9999`. |
| `EDGE_HTTP_URL` | Registration edge URL; defaults to the development value `http://127.0.0.1:8787`. |
| `EDGE_WS_URL` | Tunnel edge URL; defaults to the development value `ws://127.0.0.1:8787/_fastdog/tunnel`. Set both edge URLs for your deployment. |
| `FASTDOG_ALLOW_INSECURE_EDGE` | Exactly `1` permits plaintext connections to a non-loopback edge. Local development only. |
| `AGENT_MAKE_BEFORE_BREAK` | Exactly `1` opens the new tunnel before closing the old one on reconnect; off by default. |
| `AGENT_MBB_STREAM_DRAIN_MS` | Stream drain timeout during make-before-break, in milliseconds. Defaults to `600000`; accepts integers from `1000` to `3600000`. Invalid values warn and use the default. |
| `FASTDOG_AGENT_NO_MAIN` | Set to `1` to suppress startup when executing the module for tests. Importing the module does not start the main loop. |

## Development

Use Node 20 or later.

```sh
npm ci --ignore-scripts
npm test
npm run scan:names
```

See [security reporting](SECURITY.md), [testing](TESTING.md), and
[contributing](CONTRIBUTING.md). Licensed under [Apache-2.0](LICENSE);
see [NOTICE](NOTICE).
