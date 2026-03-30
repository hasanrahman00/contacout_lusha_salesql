# ═══════════════════════════════════════════════════════════════════════════════
# VikiLeads v3.6.0 — Protected Docker Build
# ═══════════════════════════════════════════════════════════════════════════════

# ── STAGE 1: Build + Obfuscate ──────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /build

RUN npm install -g javascript-obfuscator@4.1.1

COPY package.json package-lock.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

COPY server.js config.js job-runner.js ./
COPY routes/ ./routes/
COPY jobs/ ./jobs/
COPY tasks/ ./tasks/
COPY public/ ./public/

RUN find . -name '*.js' -not -path './node_modules/*' -not -path './public/*' | while read f; do \
      echo "  Obfuscating: $f"; \
      javascript-obfuscator "$f" \
        --output "$f" \
        --compact true \
        --control-flow-flattening true \
        --control-flow-flattening-threshold 0.75 \
        --dead-code-injection true \
        --dead-code-injection-threshold 0.4 \
        --identifier-names-generator hexadecimal \
        --rename-globals false \
        --self-defending true \
        --string-array true \
        --string-array-encoding rc4 \
        --string-array-threshold 0.75 \
        --transform-object-keys true \
        --unicode-escape-sequence true; \
    done && echo "All files obfuscated"


# ── STAGE 2: Locked-Down Runtime ─────────────────────────────────────────────
FROM node:20-slim AS runtime
LABEL maintainer="VikiLeads" version="3.6.0"
WORKDIR /app

COPY --from=builder /build/node_modules  ./node_modules
COPY --from=builder /build/server.js     ./server.js
COPY --from=builder /build/config.js     ./config.js
COPY --from=builder /build/job-runner.js ./job-runner.js
COPY --from=builder /build/package.json  ./package.json
COPY --from=builder /build/routes/       ./routes/
COPY --from=builder /build/jobs/         ./jobs/
COPY --from=builder /build/tasks/        ./tasks/
COPY --from=builder /build/public/       ./public/

RUN mkdir -p /app/data

RUN rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -rf /usr/local/lib/node_modules/corepack \
    && rm -rf /tmp/* /var/tmp/* /root/.npm

RUN groupadd -r vikileads && useradd -r -g vikileads -s /bin/false vikileads \
    && chown -R vikileads:vikileads /app
USER vikileads

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const h=require('http');h.get('http://localhost:3002/api/jobs',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]