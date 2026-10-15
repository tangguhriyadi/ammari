# Plan: Dev Deployment Pipeline (GitHub Actions → GHCR → VPS)

**Status:** Approved 2026-10-15 (with changes below). Implementing this session.

## Summary

A CI/CD pipeline that builds Docker images for `apps/admin` and `apps/web` in GitHub Actions,
pushes them to GHCR tagged with the commit SHA, runs database migrations as a separate pre-start
step, and deploys to a single Ubuntu VPS running Docker Compose + Caddy. Scoped to the **dev**
environment only; the same images/workflow are designed to be promoted to prod later (a separate
VPS — see Facts below), not rebuilt from scratch.

## Facts (confirmed by the owner)

- VPS: Ubuntu 24.04, 2 vCPU / 2GB RAM, `ubuntu` user, Docker installed, IP `43.129.55.61`,
  **architecture `x86_64` → build/target `linux/amd64`** (no QEMU cross-build needed).
- DNS (Cloudflare, proxied): `ammari.my.id` + `www` → web, `admin.ammari.my.id` → admin.
- Database (dev): **Sumopod shared Postgres 16.13**, direct connection (not PgBouncer):
  `host=pgsql-dbas-jkt1-003.sumobase.my.id port=65434`, username **without** the `.jkt1_003`
  suffix, `sslmode=disable` (dev only — prod will be a different DB with TLS). No IP allowlist,
  no SSL on any port. `vector` extension already installed; `citext`/`pgcrypto` can be created by
  the app user. Ports 6432/6433 are PgBouncer — never used by the apps or the migrator (session/
  transaction pooling breaks Drizzle's assumptions about advisory locks and prepared statements).
  Database is currently empty (first migration run creates everything).
- Object storage: Cloudeka S3, `dev/` prefix (existing `S3_*` env vars already cover this).
- Branch mapping: `dev` → this pipeline. `main` → prod, later, **on a separate VPS** — so the
  server-side layout is `/opt/ammari/` directly (no `dev/`/`prod/` subfolders on this box).
- Repo: `github.com/tangguhriyadi/ammari`.

## Decisions from the review round (supersede the original draft)

1. **ufw does NOT protect Docker-published ports.** Docker inserts its own iptables rules ahead
   of ufw's chain, so "ufw allow 80/443 from Cloudflare only" would be a no-op — Caddy stays
   reachable from anywhere, and `cf-connecting-ip` stays spoofable by anyone hitting the VPS IP
   directly. The Cloudflare trust boundary is enforced **in Caddy**, not ufw:
   - **Cloudflare Authenticated Origin Pulls** (zone-level, Cloudflare dashboard): Caddy's site
     blocks require the Cloudflare origin-pull client certificate (`tls { client_auth { mode
     require_and_verify trusted_ca_cert_file ... } }`). A request without that client cert is
     rejected at the TLS handshake, before any application code runs.
   - **Defense in depth**: Caddy also matches `remote_ip` against Cloudflare's published ranges
     (`deploy/cloudflare-ips.txt`, refreshed via `deploy/update-cloudflare-ips.sh`) and aborts
     anything outside them, and sets `trusted_proxies` so access logs show the real client IP
     rather than Cloudflare's edge IP.
   - ufw stays simple: SSH only, restrict to the operator's own IP if practical; 80/443 open to
     the world (Caddy is now the actual gate).
   - **Runbook verification step**: `curl https://43.129.55.61 -H "Host: ammari.my.id" -k` (direct
     to the VPS IP, bypassing Cloudflare) **must fail** — proves the origin-pull requirement is
     actually enforced, not just configured.
   - The Cloudflare origin-pull CA certificate's exact bytes are **not hand-transcribed into this
     repo** — getting a TLS trust anchor subtly wrong is worse than not automating it at all. It's
     a fixed file Cloudflare publishes directly (NOT the "Origin CA Root Certificate" the
     dashboard offers on the same Authenticated-Origin-Pulls page — that one verifies origin
     certs, the opposite direction; a wrong first draft of this plan conflated the two), fetched
     with a one-line `curl` straight to the server; `deploy/cloudflare/README.md` and
     `docs/deploy.md` §2 have the exact command.
2. **Images are environment-agnostic.** No `NEXT_PUBLIC_*` vars exist in either app today
   (verified by grep) and nothing else is baked in per-environment at build time. The only
   values set during the Docker `build` stage are harmless, identical-across-environments
   placeholders needed to get past two **eager, build-time** `requiredEnv()` calls (confirmed by
   actually running `pnpm build` locally with real env vars removed — see Verification):
   `BETTER_AUTH_URL` (both apps) and `DATABASE_URL` (both apps, via `packages/db/src/client.ts`'s
   top-level throw). Neither is reachable or real at build time, and standalone output tracing
   doesn't bake live data into static HTML (every route in both apps built dynamic, `ƒ`, during
   verification) — the same SHA-tagged image is valid for dev or prod; only the **runtime** env
   file supplied via `docker compose`'s `env_file` differs per environment.
3. **Dev must not be indexed.**
   - Caddy adds `X-Robots-Tag: noindex, nofollow` on every dev host (both admin and web — admin
     is always behind login anyway, but web/main-site is public even in dev).
   - `apps/web` gets a new `app/robots.ts` gated on a new runtime env var, `DEPLOY_ENV`: only
     `DEPLOY_ENV=production` serves `allow: /`; anything else (unset, `dev`, a typo) fails safe to
     a disallow-all. This is the one and only env var that differs between the dev and prod env
     files for an otherwise-identical image.
4. **Rollback rule.** Added to `CLAUDE.md`: schema migrations must stay backward-compatible with
   the previously-deployed release for at least one deploy (expand/contract), because rollback
   intentionally never re-runs or reverses a migration — it only redeploys an older image against
   the schema as it currently stands.
5. **Rebuild triggers beyond `turbo --affected`.** `turbo run build --affected` already marks
   both app images affected whenever `packages/db` (or any workspace dep) changes, via the
   dependency graph — but it has no idea that `apps/admin/Dockerfile`, `apps/web/Dockerfile`,
   `packages/db/Dockerfile`, anything under `deploy/`, or the workflow file itself are also
   inputs that should force a rebuild even when no app *source* changed. The CI "plan" job unions
   turbo's affected-package output with a plain `git diff --name-only` check against those paths.
6. **`/api/health`**: no auth, a short-timeout (2s) `SELECT 1`, response body is only
   `{ "ok": true }` / `{ "ok": false }` (200/503) — never error details, stack traces, or env
   var names, so it's safe to leave unauthenticated and world-reachable (behind Caddy).

## Open questions — resolved

| # | Question | Decision |
|---|---|---|
| 1 | Same VPS for prod later? | No — separate VPS. Layout is `/opt/ammari/` (no env subfolders). |
| 2 | SSH key restriction | A dedicated `deploy` user, normal non-sudo shell (not forced-command). |
| 3 | GHCR image visibility | Private; a `read:packages`-scoped PAT logged in once on the server. |
| 4 | Zero-downtime strategy | Accept the brief (~1–2s) blip from `docker compose up -d --no-deps`. |
| 5 | Sumopod IP allowlist | None exists — direct connection, no allowlisting needed. |
| 6 | Google OAuth redirect URIs | Reuse existing clients — dev callback URLs already registered. |
| 7 | Migrator image | Separate, minimal image (`packages/db/Dockerfile`) — confirmed. |

## Architecture

**Docker images** — `apps/admin/Dockerfile`, `apps/web/Dockerfile`, `packages/db/Dockerfile`
(migrator), each multi-stage (`pruner` → `installer`/`builder` → `runner`), using
`turbo prune --docker` to build from a minimal monorepo subset. Base image
`node:24.21.0-bookworm-slim` (glibc, not Alpine — SPEC §11's sharp-binary checklist item is best
served by the well-trodden glibc path, not musl). Runner stage copies
`.next/standalone` + `.next/static` + `public` (Next's monorepo-aware standalone layout nests
these under `apps/<app>/` inside the standalone tree — confirmed by inspecting a real local
build), runs as non-root, `node apps/<app>/server.js`, `PORT=3000`.

**Migrator** — `packages/db/Dockerfile`: just `@ammari/db`'s deps + `drizzle-kit` (promoted to a
real dependency in this image only) + the `./drizzle` folder. `docker run --rm --env-file ...
ammari-migrator:<sha> pnpm db:migrate` runs before the app containers start; non-zero exit aborts
the deploy. The same image is reused, on demand only, for the one-time super-admin bootstrap:
`docker run --rm --env-file ... -e SEED_SUPER_ADMIN_EMAIL=... -e SEED_SUPER_ADMIN_NAME=...
ammari-migrator:<sha> pnpm db:seed` (idempotent, never part of the automated deploy path).

**VPS runtime** — one `docker compose` stack at `/opt/ammari/` (`caddy`, `admin`, `web`; only
Caddy publishes 80/443; apps on an internal-only network). `restart: unless-stopped`. Docker's
`json-file` log driver with `max-size`/`max-file` set directly in `deploy/docker-compose.yml`
(an `x-logging` anchor reused by every service) rather than a separate, easy-to-forget VPS
`/etc/docker/daemon.json` edit — versioned in the repo instead. Image tags live in
`/opt/ammari/.env` (`ADMIN_IMAGE_TAG=<sha>`, `WEB_IMAGE_TAG=<sha>`), rewritten by
`deploy/remote-deploy.sh` — rollback is rewriting that file to an older SHA and re-running
compose.

**CI workflow** (`.github/workflows/deploy-dev.yml`) — triggers on push to `dev` and
`workflow_dispatch` (manual run / rollback via a `sha` input). `plan` job decides which images
need rebuilding via a plain path-prefix check over the git diff (`apps/admin/`/`apps/web/`/
`packages/db/` + the shared infra paths — `packages/`, lockfile, `turbo.json`, `.dockerignore`,
the workflow file itself — any of which marks every image affected), not a literal
`turbo run build --affected` invocation: for this repo's shape (every app transpiles every
package under `packages/*`) the two are exactly equivalent, and the plain diff is simpler to
audit than parsing turbo's dry-run output. Falls back to "build everything" whenever the diff
can't be computed (first push, a force-push). `build` job builds+pushes only the affected
image(s) for `linux/amd64`; `deploy` job rsyncs `deploy/` onto the server (explicitly excluding
`env/`, `caddy/certs/`, and `cloudflare/origin-pull-ca.pem` — those exist only on the server,
never in this repo, and a sync must never risk deleting them) and runs
`deploy/remote-deploy.sh` over SSH, which pulls the images, runs the migrator (aborting the
whole deploy on failure), flips the image tags, `docker compose up -d`, reloads Caddy's config
(a bind-mounted file change isn't itself enough to make compose recreate a container), and
polls `/api/health` on both apps via `docker compose exec` before declaring success.

**SSH + GHCR auth** — dedicated `deploy` system user (not `ubuntu`), `docker` group, no sudo. A
fresh ed25519 keypair generated once, private half as a GitHub secret, VPS host key pinned as a
secret too (not trust-on-first-connect). GHCR pulls on the server via a `read:packages`-only PAT,
logged in once. CI pushes using the built-in `GITHUB_TOKEN` (needs `packages: write`).

## Files

| File | Purpose |
|---|---|
| `apps/admin/Dockerfile`, `apps/web/Dockerfile` | app images |
| `packages/db/Dockerfile` | migrator image |
| `.dockerignore` (root) | keeps real `.env*` files and other local-only state out of the build context entirely |
| `apps/admin/src/app/api/health/route.ts`, `apps/web/src/app/api/health/route.ts` | liveness probe |
| `apps/web/src/app/robots.ts` | `DEPLOY_ENV`-gated disallow-all |
| `.github/workflows/deploy-dev.yml` | build/push/migrate/deploy |
| `deploy/docker-compose.yml`, `deploy/Caddyfile` | server-side stack, synced from the repo each deploy |
| `deploy/remote-deploy.sh` | runs ON the server: pull → migrate (abort on failure) → flip tags → compose up → reload Caddy → health poll |
| `deploy/cloudflare-ips.txt`, `deploy/update-cloudflare-ips.sh`, `deploy/cloudflare/*.caddy` (generated) | defense-in-depth IP matcher + `trusted_proxies`, refreshed from Cloudflare's own published lists |
| `deploy/cloudflare/README.md` | manual steps for the origin cert + origin-pull CA (not committed as bytes) |
| `deploy/env/admin.env.example`, `deploy/env/web.env.example` | server-side runtime env templates |
| `packages/storage/bucket-policy.prod.json` | template, mirrors the dev bucket policy |
| `apps/admin/src/proxy.ts` | `/api/health` added to the unauthenticated bypass list |
| `apps/web/public/.gitkeep` | apps/web had no `public/` dir at all — needed for the Dockerfile's `COPY` |
| `turbo.json` | `BETTER_AUTH_URL`/`STAFF_BETTER_AUTH_SECRET`/`CUSTOMER_BETTER_AUTH_SECRET` added to the `build` task's `env` allowlist (see Discoveries below) |
| `docs/SPEC.md` §11 | updated pre-deploy checklist |
| `docs/deploy.md` | the runbook |
| `CLAUDE.md` | new migration backward-compatibility rule |

## Discoveries made while actually building and running this (not just reasoning about it)

- **`sharp` is silently dropped from `.next/standalone` by this Next 16/Turbopack build** — even
  though `sharp` is on Next's own built-in `serverExternalPackages` auto-list. Confirmed
  empirically: `require("sharp")` works fine in the Docker builder stage (pnpm resolved the
  correct `linux-x64` binaries there) but throws `Cannot find module 'sharp'` in the copied
  runtime image. `apps/admin/Dockerfile` works around it by flattening pnpm's real install (the
  package, its sibling regular dependencies — pnpm resolves those as siblings in the same
  `.pnpm` store entry, not nested inside the package's own folder, which a first attempt at this
  fix missed — and its platform-specific native binaries) into a fixed location the runtime
  stage copies directly, bypassing tracing entirely. Verified end-to-end: built the real image,
  ran `sharp()` inside it at the exact module-resolution path the app actually uses, got a real
  JPEG buffer back.
- **`turbo.json`'s `envMode: "strict"` silently drops env vars a Docker `ENV` instruction sets**
  unless they're declared in a task's `env` list — `BETTER_AUTH_URL`/`STAFF_BETTER_AUTH_SECRET`/
  `CUSTOMER_BETTER_AUTH_SECRET` are read eagerly at module load (reachable from every page/route)
  and `next build` always runs with `NODE_ENV=production` (Next sets this itself), so these
  checks always fire during a build — previously masked locally because `next build` loads
  `.env` files straight from disk, independent of what turbo passes through. Added all three to
  `turbo.json`'s `build` task's `env` list (a real, repo-wide correctness fix, not Docker-only).
- **`robots.ts` would have baked a single environment's `DEPLOY_ENV` answer into the image
  forever** — Next treats it as a static metadata route and prerenders it once at build time
  unless told otherwise, which would have defeated the entire "one runtime-only env difference"
  design. Fixed with `export const dynamic = "force-dynamic"`; confirmed in the build output
  (`○ /robots.txt` → `ƒ /robots.txt`) and by running the same image twice with different
  `DEPLOY_ENV` values and seeing different `robots.txt` output both times.
- **`turbo prune` doesn't copy `tsconfig.base.json`** (a root file outside any workspace
  package) — both Dockerfiles copy it explicitly from the build context; without it the build
  fails outright (`tsconfig.json ... extends ../../tsconfig.base.json doesn't resolve`).
- **`apps/web` had no `public/` directory at all** — added `apps/web/public/.gitkeep` so the
  Dockerfile's `COPY --from=builder .../public` has something to copy.
- **Cloudflare's own `ips-v4` file has no trailing newline** — `deploy/update-cloudflare-ips.sh`'s
  first draft concatenated the last v4 range directly onto the first v6 range with no separator
  (`131.0.72.0/222400:cb00::/32`, caught by actually running the script against the real,
  network-fetched files, not sample data).
- **`trusted_ca_cert_file` is deprecated** in the pinned `caddy:2.10.2` — switched to the
  current `trust_pool file { pem_file ... }` form (discovered via the real binary's own
  deprecation warning during `caddy validate`, not assumed from memory).

## Verification run this session

- Built all three images locally with `docker buildx build --platform linux/amd64` (VPS
  architecture is `x86_64`, owner-confirmed) — all three succeed from a clean build.
- Ran the built admin/web images directly (`docker run`, real env vars, no compose): `/api/health`
  returns `503` against an unreachable DB and `200` against a real local Postgres; `sharp`
  processes a real image inside the admin container; `/robots.txt` on the web container flips
  between disallow-all and allow-all purely by changing `DEPLOY_ENV` at `docker run` time, on the
  identical image — the core "environment-agnostic image" property, proven, not assumed.
- Validated `deploy/Caddyfile` against the real, pinned `caddy:2.10.2` binary (`caddy validate`,
  `caddy fmt`) — syntactically valid, and the Cloudflare-trust design actually works: ran a real
  Caddy instance with the full config (reverse-proxying to the real web/admin containers on a
  Docker network) and confirmed (a) a TLS connection with no client certificate is rejected
  outright (curl exit 56, connection reset — Authenticated Origin Pulls enforced) and (b) a
  connection presenting a *valid* client cert but from a non-Cloudflare source IP still gets a
  `403` from the defense-in-depth `remote_ip` check. Both layers independently verified working,
  not just configured.
- `shellcheck` clean on both `deploy/remote-deploy.sh` and `deploy/update-cloudflare-ips.sh`.
- `actionlint` clean on `.github/workflows/deploy-dev.yml`; YAML parses.
- `pnpm typecheck && pnpm lint && pnpm build` (workspace-wide) and existing unit test suites —
  see the session report for exact results.
- `security-reviewer` only (per scope); CRITICAL/HIGH fixed, findings below.
- **Not done this session, by instruction**: no deploy to the real VPS, no GitHub secrets
  configured, no Cloudflare dashboard changes, nothing committed — `docs/deploy.md` is a runbook
  for the owner to execute by hand.

## Security review results

`security-reviewer` ran against the full diff. CRITICAL/HIGH fixed:

- **CRITICAL**: `inputs.sha` (the manual-rollback workflow input) was template-substituted
  directly into a `run:` shell script (`${{ inputs.sha }}` inside the script body) — the classic
  GitHub Actions script-injection sink — AND flowed, unvalidated, into the SSH command string
  `remote-deploy.sh` is invoked with on the VPS, where a shell-metacharacter-laden value could
  inject arbitrary commands into that remote command line. Fixed in two parts: the `resolve`
  step now receives the raw input only via `env:` (never directly in script text) and rejects
  anything that isn't `^[0-9a-f]{7,40}$` before it's ever used; every later use of the resolved
  SHA (build tags, the SSH command) only ever sees that validated value. A collaborator with
  `workflow_dispatch` access was the only one who could reach this, but it turned "can push to
  dev" into "root RCE on the VPS, every secret in `env/*.env`, and GHCR image poisoning" — worth
  closing regardless of who currently has that access.
- **HIGH (defense-in-depth, not directly exploitable today)**: `packages/db/Dockerfile`'s
  migrator ran as root with no `USER` — reasonable for a short-lived, never-network-reachable,
  operator-triggered container in isolation, but it's also the one container with direct DB
  access running arbitrary SQL (migrations) and, by hand, `tsx src/seed.ts`; a future compromised
  migration or a compromised `drizzle-kit`/`tsx` dependency would have root-in-container instead
  of a constrained user. Fixed to match `apps/admin`'s/`apps/web`'s own non-root posture — needed
  `--create-home` (unlike those two images) because this one's CMD invokes `pnpm` itself, which
  is corepack-shimmed and writes a cache dir under `$HOME`; without a real home directory that
  write failed outright (caught by actually running the rebuilt image, not assumed). Verified
  both the default `drizzle-kit migrate` action and the overridden `tsx src/seed.ts` bootstrap
  command still work end-to-end as the new non-root user.

MEDIUM/LOW, left unfixed per scope (documented for later, not blocking):
- No automatic rollback/revert if a deploy's post-deploy health check fails after `docker
  compose up -d` already replaced the old containers — matches the accepted design (open
  question 4: no auto-rollback, manual redeploy of an older SHA instead), and the failure mode is
  "stays down until a manual rollback," not "silently serves broken new containers."
- `docs/deploy.md` commits the VPS's real public IP in plaintext — not a secret (discoverable via
  DNS/certificate-transparency regardless), and the Cloudflare-layer enforcement already assumes
  the IP is knowable, so this doesn't weaken the actual trust boundary.
- `deploy/update-cloudflare-ips.sh` doesn't verify Cloudflare's response against a checksum —
  impact is limited to the defense-in-depth IP allowlist, not the primary Authenticated-Origin-
  Pulls boundary, per the layering this session already established.

Everything else the reviewer checked (the rsync excludes' anchoring, the Caddy `client_auth`/
`trust_pool`/`trusted_proxies` directives, `docker-compose.yml`'s network isolation, both
`/api/health` route handlers, the Dockerfiles' build-stage placeholder secrets never reaching the
runtime image) came back clean — no flaws found.

## Post-review owner corrections

Two fixes caught by the owner before the first real deploy, neither surfaced by the automated
reviews above:

1. **GitHub Environments, not repository secrets.** The four `DEPLOY_SSH_*` secrets belong on a
   GitHub **Environment** named `dev` (Settings → Environments → Environment secrets), not the
   repository-level secrets page — so prod can later reuse the same four secret names under its
   own `production` environment, gated by required reviewers (a plain repository secret can't
   express that approval gate). Added `environment: dev` to the workflow's `deploy` job (the only
   job that reads those secrets — `build` only uses the built-in `GITHUB_TOKEN`); this covers the
   rollback path too, since rollback runs the same `deploy` job with `build` skipped. Updated
   `docs/deploy.md` §3 to describe the Environment setup instead of the repository secrets page.
2. **Wrong Cloudflare certificate named for Authenticated Origin Pulls.** The original runbook/
   README told the owner to download the "Cloudflare Origin CA Root Certificate" from the
   dashboard for this — that cert verifies *origin* certificates (the other direction); it's not
   what Cloudflare's own client certificate on an origin pull is signed by. The correct CA is a
   separate, fixed file Cloudflare publishes directly at
   `https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem` — confirmed by
   actually fetching it and checking its subject (`CN=origin-pull.cloudflare.net, OU=Origin
   Pull`, valid to 2029). Fixed `docs/deploy.md` §2 and `deploy/cloudflare/README.md` to fetch it
   with a one-line `curl` instead of a dashboard download; `deploy/Caddyfile`'s own
   `trust_pool file { pem_file ... }` path was already correct and needed no change. Also
   confirmed (by actually running `caddy:2.10.2` and checking) that Caddy's official image runs
   as root in-container, so a `chmod 600` file owned by `deploy` is readable by it as-is — no
   permission adjustment needed, documented in both files so this isn't re-litigated later.

## First real dev deploy — failures diagnosed on the VPS, fixed and re-verified

The first actual deploy failed. Four real bugs, each diagnosed by the owner on the VPS, fixed
here and re-verified locally with real containers (not just re-read):

1. **Both apps "unhealthy."** Next's standalone `server.js` binds to `$HOSTNAME`, which Docker
   exports as the container ID unless the image overrides it — so the server ended up listening
   on an address tied to the container's own hostname/eth0, not loopback. External traffic via
   a published port still reached it (exactly how this session's own earlier smoke tests missed
   it — they curled from outside via `-p`, never checked `docker inspect .State.Health`), but
   Docker Compose's `HEALTHCHECK`, which curls `127.0.0.1` from *inside* the container, got
   connection-refused every time. Fixed with `ENV HOSTNAME=0.0.0.0` in both
   `apps/admin/Dockerfile`'s and `apps/web/Dockerfile`'s runner stage (not
   `deploy/docker-compose.yml` — this is a property of how the standalone server itself behaves,
   independent of how it's ever run). Re-verified properly this time: ran each container with no
   published port and read `docker inspect --format='{{json .State.Health}}'` directly —
   `"Status": "healthy"`, not just "an external curl worked."
2. **`drizzle-kit migrate` swallowed the real error.** On the actual failure it printed only
   "applying migrations..." then exited 1 — the real cause was invisible even attached to a TTY.
   Replaced with `packages/db/src/migrate.ts`, calling `drizzle-orm/postgres-js/migrator`'s
   `migrate()` directly (`max: 1`) and printing every relevant field from both the error AND its
   `.cause` (confirmed empirically that drizzle wraps the real Postgres/connection error one
   level down, under `.cause` — the first version of this script, which only looked at the
   top-level error, printed a useless "Failed query: ..." with no actual reason) — Postgres
   `code`/`detail`/`hint`/`severity`/etc. when it's a real migration SQL error (verified against
   a real foreign-key-to-a-nonexistent-table failure, run against a throwaway `ammari_scratch`
   database, then dropped), or `code`/`address`/`port`/`syscall`/`errno` when it's a connection
   failure (verified against an unreachable port) — **never** the connection string either way
   (grepped the output for a planted fake password; clean). `packages/db/package.json`'s
   `db:migrate` script now runs this file via `tsx`, so local `pnpm db:migrate` behavior is
   unchanged in shape, just a different (and now actually informative) implementation underneath.
3. **The migrator container hung on a corepack download prompt.** Its `CMD` called
   `pnpm exec ...` — but `pnpm` is a corepack shim, and corepack's "is this version prepared for
   the current user" cache is per-`$HOME`. The `base` stage's own `corepack prepare` (needed so
   the *build* steps work) only primed **root's** cache; the non-root `migrator` user added for
   the earlier security fix has a different `$HOME`, so its very first `pnpm` invocation tried to
   download pnpm fresh — and attached to a TTY/stdin (exactly how the real SSH-driven deploy
   runs it), that blocked on corepack's Y/n confirmation prompt instead of erroring. Fixed by
   never invoking `pnpm` at runtime at all: `CMD` now calls `node_modules/.bin/tsx` directly.
   Re-verified with `docker run -i ... < /dev/null` (stdin attached, the exact failure
   condition) for both the default migrate command and the seed-bootstrap override — both fail
   instantly and cleanly on a missing `DATABASE_URL` with no corepack message at all, and both
   succeed end-to-end against the real local database.
4. **No visibility into *why* a health check failed, from CI.** `deploy/remote-deploy.sh`'s
   `poll_health` now prints the failing container's last 80 log lines and Docker's own
   `.State.Health.Log` before returning failure — re-verified with a scratch `docker compose`
   stack running a deliberately misconfigured copy of the real admin image (BETTER_AUTH_URL
   omitted): the diagnostic output correctly surfaced "Error: BETTER_AUTH_URL is not set"
   straight from the container's own logs, which is exactly the class of failure that otherwise
   requires SSHing in by hand to discover.

Files touched by this round: `apps/admin/Dockerfile`, `apps/web/Dockerfile` (HOSTNAME),
`packages/db/Dockerfile` (CMD, comment updates), `packages/db/src/migrate.ts` (new),
`packages/db/package.json` (`db:migrate` script), `deploy/remote-deploy.sh` (migrator
invocation + failure diagnostics), `docs/deploy.md` (§0, §6, §7).
