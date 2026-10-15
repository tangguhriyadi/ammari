# syntax=docker/dockerfile:1
#
# The migrator image: runs packages/db/src/migrate.ts as a one-off container BEFORE the
# admin/web containers start on each deploy (docs/deploy.md), and doubles — only ever invoked
# by hand, never by the automated deploy path — as the one-time super-admin bootstrap runner
# (`tsx src/seed.ts`, see packages/db/src/seed.ts's `seedStaffUserFromEnv`).
#
# Deliberately separate from apps/admin's/apps/web's own images (docs/plans/deploy-dev.md,
# open question 7): only rebuilds when @ammari/db itself changes, and never carries a Next.js
# server bundle it has no use for. `drizzle-kit`/`tsx` are devDependencies of @ammari/db in the
# workspace (they're real build/dev tools, not something every consumer of @ammari/db should
# pull in) — a plain `pnpm install` (no `--prod`) installs devDependencies too, so nothing needs
# to be reclassified in the real package.json just for this image.
FROM node:24.21.0-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
WORKDIR /app

FROM base AS pruner
COPY . .
RUN npx turbo prune @ammari/db --docker

FROM base AS runner
# --create-home: cheap insurance in case tsx/esbuild ever want a writable $HOME at runtime —
# no longer strictly required now that the CMD below invokes tsx directly instead of through
# `pnpm` (see that CMD's own comment for why that change was needed).
RUN groupadd --system --gid 1001 nodejs && useradd --system --create-home --uid 1001 --gid nodejs migrator
COPY --from=pruner --chown=migrator:nodejs /app/out/json/ .
COPY --from=pruner --chown=migrator:nodejs /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner --chown=migrator:nodejs /app/out/full/ .
# `pnpm install` above ran as root (before USER migrator is set below) and created
# node_modules directly in this stage rather than via a `--chown`'d COPY like the other two
# Dockerfiles use — chown it explicitly so nothing in there ends up unreadable/unexecutable to
# the non-root user this stage switches to.
RUN chown -R migrator:nodejs /app
WORKDIR /app/packages/db
ENV NODE_ENV=production
# Runs as non-root even though this container is only ever a short-lived, operator-triggered
# one-off (`docker run --rm`), never network-reachable: it runs `drizzle-kit migrate` (arbitrary
# SQL from migration files) and, by hand, `tsx src/seed.ts`, against real database credentials —
# if a future migration or a compromised dependency in the drizzle-kit/tsx chain ever achieves
# code execution in here, root-in-container is a meaningfully larger blast radius than non-root
# (container-breakout primitives generally need root inside the container first). Matches
# apps/admin's/apps/web's own non-root posture (security-reviewer finding, docs/plans/deploy-dev.md).
USER migrator
# Invokes tsx's binary directly — NOT `pnpm exec tsx ...` — because `pnpm` itself is a corepack
# shim: the first time it runs as a given $HOME, corepack checks whether that exact pnpm
# version is "prepared" for that user and, if not, tries to download it — which, attached to a
# TTY/stdin (exactly how the real deploy pipeline's SSH session runs this), blocks on a Y/n
# confirmation prompt instead of just working. Confirmed on the real first dev deploy: the
# container hung showing "Corepack is about to download pnpm-12.8.1" and never produced an
# error either way. `corepack prepare` in the `base` stage above only primed root's own cache
# (`/root/.cache/node/corepack`) — invisible to this stage's own non-root `migrator` user, whose
# $HOME is a different directory entirely, so the fix isn't "prepare it for migrator too" but
# "never go through the corepack-shimmed `pnpm` command at runtime at all". `node_modules/.bin`
# is the same path whether the final command is `drizzle-kit migrate` or the bootstrap's
# `tsx src/seed.ts` override (see docs/deploy.md), so both work with this one fix.
CMD ["node_modules/.bin/tsx", "src/migrate.ts"]
