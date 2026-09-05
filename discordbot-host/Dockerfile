# Persistent gateway process. For the default (cold) path on every channel,
# this only spawns sibling containers (container/Dockerfile) that run
# Claude Code, via the mounted Docker socket, and needs no Claude auth
# itself. If a channel's WARM_SESSION_CHANNELS flag (see src/agentDispatch.ts
# / src/warmSession.ts) is turned on, this process runs the Agent SDK
# in-process for that channel instead, and then DOES need
# CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY/CLAUDE_MODEL in its own
# environment (not just filtered into the ephemeral container's env-dir
# mount) -- see DEPLOYMENT.md.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# State (sessions, pending actions, sentry state) lives in a mounted volume.
ENV DATA_DIR=/data
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
