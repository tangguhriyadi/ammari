# syntax=docker/dockerfile:1
#
# Builds the @ammari/admin standalone Next.js server. Built ONLY in GitHub Actions
# (.github/workflows/deploy-dev.yml) — never on the 2GB RAM VPS (docs/SPEC.md §2.3).
#
# Pinned base image, glibc not musl (docs/plans/deploy-dev.md): sharp (packages/admin's own
# image-processing dependency) ships prebuilt native binaries, and the glibc/Debian path is the
# well-tested one — Alpine's musl libc is a common, harder-to-debug source of
# "Could not load the sharp module" failures that only show up at container start, not at build
# time (docs/SPEC.md §11's pre-deploy checklist already flags this as something to verify in the
# real image, not assume from a local Mac build).
FROM node:24.21.0-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
WORKDIR /app

# --- prune: reduce the monorepo to just what @ammari/admin actually depends on -------------
FROM base AS pruner
COPY . .
RUN npx turbo prune @ammari/admin --docker

# --- install + build ------------------------------------------------------------------------
FROM base AS builder
# Only package.json files first (turbo prune's `out/json`) so `pnpm install` is its own cached
# layer and doesn't re-run just because application source changed.
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# apps/admin/tsconfig.json extends this by relative path ("../../tsconfig.base.json") — it's a
# root-level file outside any workspace package, so `turbo prune` (which only copies the
# selected package(s) plus a short, fixed list of root files: package.json, pnpm-workspace.yaml,
# turbo.json, .gitignore, the lockfile) doesn't bring it along on its own. Confirmed by an actual
# failed build without this line: "tsconfig.json ... extends ../../tsconfig.base.json doesn't
# resolve correctly".
COPY tsconfig.base.json ./tsconfig.base.json

# BETTER_AUTH_URL and DATABASE_URL are read eagerly at module load (packages/auth's
# create-{staff,customer}-auth.ts, packages/db/src/client.ts) by code that's reachable from
# every page/route, so `next build`'s page-data-collection step throws without them being SET —
# confirmed by actually running the build locally with both removed. Neither value is ever
# connected to or rendered into static output (verified: every route in this app builds dynamic,
# "ƒ", not statically prerendered with baked data) — these are placeholders that exist ONLY in
# this discarded build stage, identical for every environment, so the resulting image stays
# environment-agnostic. The real values come from the runtime env file (deploy/env/admin.env).
ENV NODE_ENV=production \
    DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
    BETTER_AUTH_URL="http://localhost:3000" \
    STAFF_BETTER_AUTH_SECRET="build-time-placeholder-not-a-real-secret"
RUN pnpm turbo run build --filter=@ammari/admin

# sharp is NOT carried into .next/standalone by Next's own output-file-tracing on this Next 16 /
# Turbopack build — confirmed empirically: `require("sharp")` works fine right here in this
# stage (pnpm resolved the correct linux-x64 binaries), but it's silently absent from the
# traced standalone output, exactly the class of failure docs/SPEC.md §11 warns about ("fails
# at require-time, not build time"; "a green pnpm build locally proves nothing about the
# deployed image"). Rather than trust tracing a second time, flatten pnpm's already-resolved
# sharp install into a fixed, self-contained location (dereferencing every `.pnpm` store
# symlink with `cp -L`, so nothing points back into a store path that won't exist in the runner
# stage) that the runner stage can COPY --from directly. Copying each store entry's WHOLE
# `node_modules/` directory, not just the one package folder inside it, matters: pnpm resolves a
# package's own regular dependencies (sharp's `detect-libc`, `semver`, ...) as SIBLINGS in that
# same store entry, not nested inside the package's own folder — confirmed by an earlier attempt
# that copied only the `sharp` folder itself still failing at runtime with "Cannot find module
# 'detect-libc'". `find` tolerates the pnpm store's version-suffixed directory names drifting
# (e.g. a future @types/node bump) without this going stale.
RUN set -eu; \
    mkdir -p /sharp-runtime/@img; \
    sharp_dir=$(find node_modules/.pnpm -maxdepth 1 -iname 'sharp@*' | head -1); \
    cp -RL "$sharp_dir/node_modules/." /sharp-runtime/; \
    linux_x64_dir=$(find node_modules/.pnpm -maxdepth 1 -iname '@img+sharp-linux-x64@*' | head -1); \
    libvips_dir=$(find node_modules/.pnpm -maxdepth 1 -iname '@img+sharp-libvips-linux-x64@*' | head -1); \
    cp -RL "$linux_x64_dir/node_modules/@img/." /sharp-runtime/@img/; \
    cp -RL "$libvips_dir/node_modules/@img/." /sharp-runtime/@img/

# --- runtime ----------------------------------------------------------------------------------
FROM node:24.21.0-bookworm-slim AS runner
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=builder --chown=nextjs:nodejs /app/apps/admin/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/admin/public ./apps/admin/public
# See the builder stage's own comment above this image's /sharp-runtime step — Next's standalone
# tracing misses sharp entirely; these are the flattened, self-contained real directories built
# there, landing directly under apps/admin/node_modules so Node's normal ancestor lookup from
# apps/admin/.next/server/... finds them exactly as it would a real `pnpm install` on Linux.
COPY --from=builder --chown=nextjs:nodejs /sharp-runtime/ ./apps/admin/node_modules/
USER nextjs
EXPOSE 3000
# No curl/wget in this minimal image — this HEALTHCHECK (inherited automatically by
# deploy/docker-compose.yml's `admin` service; not re-declared there) calls /api/health via
# Node's own http module instead of installing an extra package.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/api/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "apps/admin/server.js"]
