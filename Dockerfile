# Base image pinned by digest (node:20-bookworm-slim, checked 2026-10-29).
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
LABEL org.opencontainers.image.title="fastdog-agent" \
      org.opencontainers.image.version="0.2.1" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/SoupNChill/fastdog-agent"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src/ ./src/
COPY LICENSE NOTICE ./
USER node
CMD ["node", "src/index.js"]
