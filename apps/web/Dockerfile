# syntax=docker/dockerfile:1
#
# Builds the @ammari/web standalone Next.js server. Built ONLY in GitHub Actions
# (.github/workflows/deploy-dev.yml) — never on the 2GB RAM VPS (docs/SPEC.md §2.3).
#
# Same base image choice as apps/admin/Dockerfile (glibc, not Alpine) — this app has no sharp
# dependency today, but keeping both apps on the identical base avoids a second set of platform
# assumptions to verify.
FROM node:24.21.0-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
WORKDIR /app

# --- prune: reduce the monorepo to just what @ammari/web actually depends on ---------------
FROM base AS pruner
COPY . .
RUN npx turbo prune @ammari/web --docker

# --- install + build ------------------------------------------------------------------------
FROM base AS builder
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# See apps/admin/Dockerfile's identical comment: tsconfig.base.json lives outside any workspace
# package, so `turbo prune` doesn't bring it along — copied directly from the build context.
COPY tsconfig.base.json ./tsconfig.base.json

# See apps/admin/Dockerfile's identical comment: these two vars are read eagerly at module load
# by code reachable from every page, but are never connected to or baked into static output
# (every route here also builds dynamic) — placeholders only, discarded with this build stage.
ENV NODE_ENV=production \
    DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
    BETTER_AUTH_URL="http://localhost:3000" \
    CUSTOMER_BETTER_AUTH_SECRET="build-time-placeholder-not-a-real-secret"
RUN pnpm turbo run build --filter=@ammari/web

# --- runtime ----------------------------------------------------------------------------------
FROM node:24.21.0-bookworm-slim AS runner
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/api/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
