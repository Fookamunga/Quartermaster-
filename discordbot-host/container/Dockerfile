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

# Sources the filtered Claude-auth env vars from the mounted /workspace/env-dir
# (written by containerRunner.ts's buildVolumeMounts) into the process
# environment before running node -- without this, CLAUDE_CODE_OAUTH_TOKEN/
# ANTHROPIC_API_KEY are mounted as a file but never actually reach the
# process, and Claude Code fails with "Not logged in".
RUN printf '#!/bin/bash\nset -e\n[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)\nexec node /app/dist/index.js\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh \
    && chown node:node /app/entrypoint.sh

USER node
WORKDIR /workspace/group

ENTRYPOINT ["/app/entrypoint.sh"]
