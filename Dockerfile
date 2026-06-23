# ─── Stage 1: Base with FFmpeg ────────────────────────────────────────────────
FROM node:20-slim AS base

# Install FFmpeg and required system packages
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installation
RUN ffmpeg -version

WORKDIR /app

# ─── Stage 2: Install backend deps ────────────────────────────────────────────
FROM base AS deps

COPY backend/package.json ./backend/
RUN cd backend && npm install --omit=dev

# ─── Stage 3: Production image ────────────────────────────────────────────────
FROM base AS production

WORKDIR /app

# Copy backend
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend/ ./backend/

# Copy frontend static files
COPY frontend/public/ ./frontend/public/

# Create uploads directory
RUN mkdir -p ./backend/uploads/clips

# Set environment
ENV NODE_ENV=production
ENV PORT=8000

# Expose port (Koyeb uses 8000 by default)
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8000/api/auth/me', (r) => { process.exit(r.statusCode < 500 ? 0 : 1); }).on('error', () => process.exit(1));"

# Start server
WORKDIR /app/backend
CMD ["node", "server.js"]
