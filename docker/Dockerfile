# ==========================================
# Caster Personal Media Server for TrueNAS SCALE
# Hardware-accelerated (Intel QSV / VAAPI / NVIDIA NVENC)
# ==========================================

# Keep the build and runtime on the same pinned Bun release used by CI.
FROM oven/bun:1.3.10-debian AS base
WORKDIR /app

# Install the exact dependency graph recorded in bun.lock. Both workspace
# manifests must be present for Bun to validate the monorepo lockfile.
FROM base AS development-dependencies
COPY package.json bun.lock ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN bun install --frozen-lockfile

FROM base AS production-dependencies
COPY package.json bun.lock ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN bun install --frozen-lockfile --production

# Stage 1: Build the frontend from the same locked graph tested in CI.
FROM development-dependencies AS web-builder
COPY apps/web ./apps/web
RUN bun run --filter '@caster/web' build

# Stage 2: Runtime container with hardware-accelerated FFmpeg.
FROM base AS runner

# Install FFmpeg, VAAPI, Intel Media Drivers, and utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    vainfo \
    intel-media-va-driver \
    mesa-va-drivers \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only production dependencies and the workspace manifests they resolve
# against. Frontend source and build tooling stay in the builder stage.
COPY package.json ./package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/server/node_modules ./apps/server/node_modules

# Copy server source
COPY apps/server/src ./apps/server/src
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json

# Copy built frontend assets from stage 1
COPY --from=web-builder /app/apps/web/dist /app/apps/web/dist

# Set up environment and persistent data directories
ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
ENV MEDIA_DATA_DIR=/app/data
ENV THUMBNAILS_DIR=/app/data/thumbnails
ENV TRANSCODE_CACHE_DIR=/app/data/transcode_cache

RUN mkdir -p /app/data /media

WORKDIR /app/apps/server

EXPOSE 3001

VOLUME ["/app/data", "/media"]

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

CMD ["bun", "run", "src/index.ts"]
