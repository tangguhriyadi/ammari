# syntax=docker/dockerfile:1
#
# The migrator image: runs packages/db/src/migrate.ts as a one-off container BEFORE the
# admin/web containers start on each deploy (docs/deploy.md), and doubles — only ever invoked
# by hand, never by the automated deploy path — as the one-time super-admin bootstrap runner
# (`tsx src/seed.ts`, see packages/db/src/seed.ts's `seedStaffUserFromEnv`).
#
# Deliberately separate from apps/admin's/apps/web's own images (docs/plans/deploy-dev.md,
# open question 7): only rebuilds when @ammari/db itself changes, and never carries a Next.js
# server bundle it has no use for. `drizzle-kit`/`typescript`/`vitest` are devDependencies of
# @ammari/db — real build/dev tools this image's CMD never invokes (migrate.ts calls
# drizzle-orm's migrator directly, not the `drizzle-kit` CLI — see migrate.ts's own comment) —
# so `pnpm install --prod` below excludes them entirely. `tsx`, by contrast, IS invoked directly
# at runtime (this file's own CMD, and the seed bootstrap command in docs/deploy.md §7), so it's
# a real `dependencies` entry in packages/db/package.json, not a devDependency: reclassified
# specifically so `--prod` still installs it. Before this split, a plain `pnpm install` (no
# `--prod`, needed only because `tsx` used to be a devDependency) pulled in the WHOLE monorepo's
# devDependencies too — drizzle-kit, typescript, vitest/jsdom/lightningcss, and even the root
# workspace's own `turbo` (with its native binary) — ballooning this image to ~1GB for a
# container that only ever runs two small scripts.
FROM node:24.21.0-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
WORKDIR /app

FROM base AS pruner
COPY . .
RUN npx turbo prune @ammari/db --docker

# --- install (discarded stage) ------------------------------------------------------------------
# Kept separate from the final `runner` stage — not folded into it like an earlier version of
# this file did — because a `RUN pnpm install` followed by a later `RUN chown -R` of the SAME
# layer's output doubles that content in the exported image: a chown-only change still rewrites
# full file bytes into a new layer under Docker's tar-based layer export, it's not a cheap
# metadata-only diff. Isolating the install here and copying the result into `runner` with a
# single `COPY --chown` (same pattern apps/admin's/apps/web's own Dockerfiles already use for
# their own builder→runner handoff) sets ownership at copy time instead, with no second full-tree
# rewrite. Confirmed directly (`docker images`, same installed dependency set both times): this
# change alone took the exported image from 592MB to 397MB.
FROM base AS builder
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
# --prod: see the file-level comment above — this is the whole point of reclassifying `tsx`.
RUN pnpm install --frozen-lockfile --prod
COPY --from=pruner /app/out/full/ .

FROM base AS runner
# --create-home: cheap insurance in case tsx/esbuild ever want a writable $HOME at runtime —
# no longer strictly required now that the CMD below invokes tsx directly instead of through
# `pnpm` (see that CMD's own comment for why that change was needed).
RUN groupadd --system --gid 1001 nodejs && useradd --system --create-home --uid 1001 --gid nodejs migrator
COPY --from=builder --chown=migrator:nodejs /app/ .
WORKDIR /app/packages/db
ENV NODE_ENV=production
# Runs as non-root even though this container is only ever a short-lived, operator-triggered
# one-off (`docker run --rm`), never network-reachable: it runs drizzle-orm's migrator (arbitrary
# SQL from migration files) and, by hand, `tsx src/seed.ts`, against real database credentials —
# if a future migration or a compromised dependency in the tsx/esbuild/drizzle-orm chain ever
# achieves code execution in here, root-in-container is a meaningfully larger blast radius than non-root
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
# is the same path whether the final command is this CMD's own `tsx src/migrate.ts` or the
# bootstrap's `tsx src/seed.ts` override (see docs/deploy.md), so both work with this one fix.
CMD ["node_modules/.bin/tsx", "src/migrate.ts"]
