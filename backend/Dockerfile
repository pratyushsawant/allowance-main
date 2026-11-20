# Allowance backend: ONE long-running Node 22 process (API, x402 sellers, reconciler, odds recorder,
# Quicknode Streams webhook). SQLite lives on the /data volume, so run exactly one instance.
#   docker build -t allowance-backend .          (from backend/)
#   docker run --env-file .env -p 8787:8787 -v allowance-data:/data allowance-backend
# Secrets come from the environment at runtime; .env is never copied into the image (.dockerignore).

FROM node:22.23.5-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 ships prebuilt binaries; the toolchain is only a fallback if none matches the platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22.23.5-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/allowance.db \
    RECORDER_ENABLED=1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
# No VOLUME instruction: Railway rejects it (it attaches its own volume at /data). With plain Docker,
# mount one explicitly: -v allowance-data:/data. Railway mounts volumes as root, so the service there
# sets RAILWAY_RUN_UID=0 (Railway volumes docs).
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Node 22.18+ runs the TypeScript sources directly (type stripping); no build step.
CMD ["node", "src/server.ts"]
