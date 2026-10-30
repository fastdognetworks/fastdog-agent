# This node:20-bookworm-slim digest has layers matching the published 0.2.3 image.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
LABEL org.opencontainers.image.title="fastdog-agent" \
      org.opencontainers.image.description="Outbound agent for connecting a verified hostname to a local web service" \
      org.opencontainers.image.version="0.2.3" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="FastDog Networks" \
      org.opencontainers.image.source="https://github.com/fastdognetworks/fastdog-agent"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src/index.js src/backoff.js src/heartbeat.js src/ws-frames.js ./agent/
COPY LICENSE NOTICE ./
USER node
ENTRYPOINT ["node", "agent/index.js"]
