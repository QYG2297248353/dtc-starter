# syntax=docker/dockerfile:1

# ============================================================
# Medusa backend (@dtc/backend) production image
#
# Monorepo-aware build: only the backend workspace is installed
# and built. The storefront is NOT part of this image.
#
# Build context must be the repository root:
#   docker build -t qyg2297248353/medusa .
# ============================================================

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.11.1 --activate

# ------------------------------------------------------------
# builder: install backend workspace deps and run `medusa build`
# Output: apps/backend/.medusa/server (self-contained server)
# ------------------------------------------------------------
FROM base AS builder
WORKDIR /app

# Workspace manifests first for better layer caching.
# The storefront manifest is intentionally NOT copied: the install
# is filtered to the backend, and pnpm tolerates the missing importer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/backend/package.json apps/backend/package.json

# Install only the backend workspace (and its workspace deps, if any)
RUN pnpm install --frozen-lockfile --filter @dtc/backend...

# Copy backend sources and build
COPY apps/backend ./apps/backend
RUN pnpm --filter @dtc/backend build

# ------------------------------------------------------------
# runner: lean production image
# ------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /server

RUN addgroup -S medusa && adduser -S medusa -G medusa

# `medusa build` emits a self-contained server under .medusa/server
# (compiled app + admin dashboard under public/ + package.json).
COPY --from=builder --chown=medusa:medusa /app/apps/backend/.medusa/server ./

# Standalone production install. pnpm's symlinked workspace
# node_modules cannot be copied between stages, so dependencies are
# re-resolved here from the (exact-pinned) package.json.
#   --prod                        skip devDependencies (jest, ts-node, ...)
#   --ignore-scripts              skip optional postinstalls
#                                 (@medusajs/telemetry, esbuild, ...)
#   --config.auto-install-peers   match the repo's .npmrc behavior for
#                                 @medusajs/draft-order's peer on @medusajs/ui
RUN pnpm install --prod --ignore-scripts --config.auto-install-peers=true \
    && pnpm store prune \
    && chown -R medusa:medusa /server

USER medusa

EXPOSE 9000

# Runtime config (DATABASE_URL, REDIS_URL, JWT_SECRET, ...) is passed
# exclusively via environment variables — see docker-compose.yml and
# docs/DEPLOYMENT.md.
#
# Migrations are NOT run automatically; run them as a one-shot step
# before starting (docker-compose wires a `migrate` service):
#   ./node_modules/.bin/medusa db:migrate
CMD ["npm", "run", "start"]
