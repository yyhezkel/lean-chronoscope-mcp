### Build stage ###
FROM node:22-bookworm-slim AS build
WORKDIR /app

# python3 + build-essential are needed for native modules (better-sqlite3).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# Re-install only production deps to slim the runtime image.
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod


### Runtime stage ###
FROM node:22-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# Install Chrome + minimum deps for headless rendering.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg wget xdg-utils \
    fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libdrm2 libxshmfence1 \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Non-root user.
RUN groupadd -g 1500 mcp && useradd -u 1500 -g 1500 -m -s /bin/bash mcp

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/healthcheck.sh /healthcheck.sh
RUN chmod +x /entrypoint.sh /healthcheck.sh

# Data dirs owned by mcp user.
RUN mkdir -p /var/lib/lean-chronoscope /run/lean-chronoscope /var/log/lean-chronoscope \
 && chown -R mcp:mcp /var/lib/lean-chronoscope /run/lean-chronoscope /var/log/lean-chronoscope /app

USER mcp

ENV CHROME_BIN=/usr/bin/google-chrome \
    LEAN_CHRONOSCOPE_DATA_DIR=/var/lib/lean-chronoscope \
    LEAN_CHRONOSCOPE_SOCKET=/run/lean-chronoscope/daemon.sock \
    LEAN_CHRONOSCOPE_LOG_DIR=/var/log/lean-chronoscope \
    NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD /healthcheck.sh

ENTRYPOINT ["/entrypoint.sh"]
