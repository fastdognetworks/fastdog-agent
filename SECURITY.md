# Security

Report vulnerabilities privately to support@fastdognetworks.com. Do not include live
credentials or customer payloads in public issues.

Version 0.2.x is the intended supported series. Earlier versions are unsupported.
No public response-time commitment has been established yet.

Scope includes credential handling, edge transport, destination pinning, stream
lifecycle and dependency security. The edge service, application authorization,
DNS and deployment infrastructure are outside this repository.

The connector handles its connection credential, registration name and hostname,
local application URL, request/response headers and bodies, and origin reachability
metadata. Traffic passes through the edge. Buffered v0 holds payloads in memory;
v1 streams with flow control. The connector has no persistent traffic store.
Protect environment configuration and logs, use a trusted edge and secure local
transport, and apply access controls at the application or edge.
