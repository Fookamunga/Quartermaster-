# Cold, one-shot agent container: spawned fresh per Discord message, exits
# after a single query() call. Never kept alive across turns -- see the
# non-negotiable constraint in CLAUDE.md. The Agent SDK bundles its own CLI
# binary via a platform-specific optional dependency (resolved by `npm
# install` below), so no separate @anthropic-ai/claude-code install is needed.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY agent-runner/package.json agent-runner/package-lock.json* ./
RUN npm install
COPY agent-runner/tsconfig.json ./
COPY agent-runner/src ./src
RUN npm run build

RUN mkdir -p /workspace/group && chown -R node:node /workspace
USER node
WORKDIR /workspace/group

ENTRYPOINT ["node", "/app/dist/index.js"]
