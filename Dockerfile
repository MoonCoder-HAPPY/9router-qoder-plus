# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS builder

# Use Alibaba Cloud Alpine mirror for faster builds on China VPS hosts.
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.aliyun.com#g' /etc/apk/repositories

RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm config set registry https://registry.npmmirror.com && \
  npm install

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"
LABEL org.opencontainers.image.description="9router + Qoder queue-aware retry, quota, model catalog, and DingTalk idle alerts"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

ENV QODER_QUEUE_MAX_ATTEMPTS=15
ENV QODER_QUEUE_BASE_DELAY_MS=5000
ENV QODER_QUEUE_MAX_DELAY_MS=60000
ENV QODER_STREAM_TIMEOUT_MS=600000
ENV QODER_STALL_TIMEOUT_MS=600000

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Fix permissions at runtime (handles mounted volumes)
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.aliyun.com#g' /etc/apk/repositories && \
  apk --no-cache upgrade && apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
