#!/usr/bin/env bash
# W4 — Build a LiveKit-Cloud-deployable artifact for voice-agent.
#
# Pivot rationale (2026-05-17):
#   - LK CLI excludes `node_modules` from the upload tarball
#     (cloudagents/tar.go:98). Pre-resolving workspace deps via `pnpm deploy`
#     is therefore impossible — the deps just get stripped on upload.
#   - The container MUST `npm/pnpm install` for itself. But voice-agent's
#     workspace deps (`@pa/agent-runtime`, `@pa/core-types`,
#     `@wekruit/shared-tags`) are not publishable.
#   - Solution: bundle the workspace code into `dist/cli.bundle.js` (esbuild
#     inlines `@pa/*` and `@wekruit/*`; LK SDK + openai + zod stay external)
#     and ship a `package.json` that lists ONLY the registry deps. The
#     container then runs `npm install --omit=dev`, which can resolve every
#     declared dep from npmjs.
#
# Output: $OUT_DIR (default /tmp/lk-deploy-voice-agent)
#   - dist/cli.bundle.js          — esbuild output (workspace code inlined)
#   - package.json                — registry-only deps (from build:bundle)
#   - Dockerfile                  — slim, runs `npm install --omit=dev`
#   - livekit.toml                — agent binding (CA_CyhBjJioxJR9)
#   - bin/ scripts/               — CLI entry helpers
#   - .dockerignore               — keep upload small
#
# Usage:
#   bash apps/voice-agent/scripts/build-lk-deploy.sh
#   cd /tmp/lk-deploy-voice-agent
#   lk agent deploy --project wekruit --silent --secrets-file <secrets-file>

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="${LK_DEPLOY_OUT_DIR:-/tmp/lk-deploy-voice-agent}"

echo "[lk-deploy] repo=$REPO_ROOT  out=$OUT_DIR"

# Step 1: clean prior artifact.
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/dist" "$OUT_DIR/bin" "$OUT_DIR/scripts"

# Step 2: bundle. Compiles TS + inlines @pa/* and @wekruit/* workspace deps.
cd "$REPO_ROOT"
pnpm --filter voice-agent build
pnpm --filter voice-agent build:bundle

# Step 3: copy artifacts. Both cli.bundle.js (entrypoint) and
# agent.bundle.js (LK child IPC default-export target) must ship together;
# cli.bundle.js dynamic-imports ./agent.bundle.js at runtime.
cp "$REPO_ROOT/apps/voice-agent/dist/cli.bundle.js" "$OUT_DIR/dist/cli.bundle.js"
cp "$REPO_ROOT/apps/voice-agent/dist/agent.bundle.js" "$OUT_DIR/dist/agent.bundle.js"
cp "$REPO_ROOT/apps/voice-agent/dist/deploy-package.json" "$OUT_DIR/package.json"
cp "$REPO_ROOT/apps/voice-agent/livekit.toml" "$OUT_DIR/livekit.toml"
cp "$REPO_ROOT/apps/voice-agent/bin/cli.mjs" "$OUT_DIR/bin/cli.mjs" 2>/dev/null || true

# Step 4: slim Dockerfile — runs npm install for the registry-only deps.
cat > "$OUT_DIR/Dockerfile" <<'EOF'
# W4 slim image. The bundle (dist/cli.bundle.js) carries all workspace code
# (@pa/agent-runtime, @pa/core-types, @wekruit/shared-tags) inlined; the
# Docker layer only npm-installs the external LK SDK + openai + zod + plugins.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

ENV NODE_ENV=production
ENV NPM_CONFIG_PRODUCTION=true

RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm handles peer-dep mismatches more gracefully than npm
# (the openai@4 / zod@4 / @openai/agents@0.8.5 triangle has peer conflicts
# that ERESOLVE in npm but resolve cleanly in pnpm with auto-install-peers).
RUN npm install -g pnpm@10

WORKDIR /app

# Install registry deps first for cache efficiency.
COPY package.json /app/
RUN pnpm install --prod

# Copy the bundle + any CLI helpers.
COPY dist /app/dist
COPY bin /app/bin

# The CLI uses `import.meta.url` regex to detect "invoked as main". The bundle
# filename (cli.bundle.js) doesn't match the cli.ts regex, so we set the
# explicit override env var. Same effect as `node bin/cli.mjs start` but
# avoids an extra hop.
ENV VOICE_AGENT_RUN_MAIN=1
CMD ["node", "dist/cli.bundle.js", "start"]
EOF

# Step 5: minimal .dockerignore.
cat > "$OUT_DIR/.dockerignore" <<'EOF'
.git
.gitignore
*.log
.env*
EOF

echo "[lk-deploy] artifact ready: $OUT_DIR"
echo "[lk-deploy] bundle size: $(du -h "$OUT_DIR/dist/cli.bundle.js" | cut -f1)"
echo "[lk-deploy] next: cd $OUT_DIR && lk agent deploy --project wekruit --silent --secrets-file <secrets-file>"
