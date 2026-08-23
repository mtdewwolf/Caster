# ==========================================
# Caster Personal Media Server for TrueNAS SCALE
# Hardware-accelerated (Intel QSV / VAAPI / NVIDIA NVENC)
# ==========================================

# Stage 1: Build Frontend Web Player
FROM node:20-slim AS web-builder
WORKDIR /app

# Copy web app source
COPY apps/web ./apps/web
WORKDIR /app/apps/web
RUN npm install
RUN npm run build

# Stage 2: Runtime Container with Hardware Accelerated FFmpeg
FROM oven/bun:1-debian AS runner

# Install FFmpeg, VAAPI, Intel Media Drivers, and utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    vainfo \
    intel-media-va-driver-non-free \
    mesa-va-drivers \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy server package and dependencies
COPY apps/server/package.json ./apps/server/
WORKDIR /app/apps/server
RUN bun install --production

# Copy server source
COPY apps/server/src ./src
COPY apps/server/tsconfig.json ./

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

EXPOSE 3001

VOLUME ["/app/data", "/media"]

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

CMD ["bun", "run", "src/index.ts"]
