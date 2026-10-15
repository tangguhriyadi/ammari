# Deploy runbook — dev environment

Step-by-step, for the owner to run by hand. The agent that built this pipeline did not touch the
VPS, GitHub secrets, or Cloudflare settings — everything below is yours to execute. Background
and design rationale: `docs/plans/deploy-dev.md`. Pre-deploy checklist: `docs/SPEC.md` §11.

Do these in order — later steps assume earlier ones are done.

## 0. Facts this runbook assumes

- VPS: Ubuntu 24.04, `ubuntu` user, IP `43.129.55.61`, architecture `x86_64` (confirmed via
  `ssh ubuntu@43.129.55.61 uname -m` — if that ever reports `aarch64` instead, the workflow's
  `platforms: linux/amd64` and the Dockerfiles' base images need to change to `arm64` too; don't
  deploy an amd64 image to an arm64 host).
- DNS already points `ammari.my.id`, `www.ammari.my.id`, `admin.ammari.my.id` at that IP,
  proxied (orange cloud) on Cloudflare.
- Database: Sumopod shared Postgres 16.13, direct connection (not PgBouncer) — see
  `deploy/env/admin.env.example`'s comment for the exact connection string shape.
- Repo: `github.com/tangguhriyadi/ammari`.

## 1. One-time VPS setup

SSH in as `ubuntu` for this whole section.

1. Confirm Docker Compose v2 is present: `docker compose version` (not just `docker-compose`).
2. Create the dedicated deploy user (normal, non-sudo shell — not `ubuntu`, not forced-command):
   ```bash
   sudo adduser --disabled-password --gecos "" deploy
   sudo usermod -aG docker deploy
   ```
3. Generate a dedicated SSH keypair **on your own machine** (not your personal key):
   ```bash
   ssh-keygen -t ed25519 -C "github-actions-deploy@ammari" -f ammari_deploy_key -N ""
   ```
   Copy `ammari_deploy_key.pub`'s contents into `/home/deploy/.ssh/authorized_keys` on the VPS
   (as `deploy`, `chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`). Keep
   `ammari_deploy_key` (the private half) for step 3 below — delete it from your machine once
   it's in the GitHub secret.
4. Pin the VPS's host key (so CI verifies it instead of trust-on-first-connect):
   ```bash
   ssh-keyscan -t ed25519 43.129.55.61
   ```
   Save that output — it's the `DEPLOY_SSH_KNOWN_HOSTS` secret in step 3.
5. Create the deploy directory structure as `deploy` (or as `ubuntu` then `chown -R deploy
   :deploy /opt/ammari`):
   ```bash
   sudo mkdir -p /opt/ammari/env /opt/ammari/caddy/certs /opt/ammari/cloudflare
   sudo chown -R deploy:deploy /opt/ammari
   ```
6. Create a **classic PAT** (GitHub → Settings → Developer settings → Personal access tokens),
   scope `read:packages` only. As `deploy` on the VPS:
   ```bash
   echo "<the PAT>" | docker login ghcr.io -u <your-github-username> --password-stdin
   ```
   This persists in `deploy`'s own `~/.docker/config.json` — a one-time step, not per-deploy.

## 2. Cloudflare dashboard

1. **SSL/TLS → Overview**: set the encryption mode to **Full (strict)**.
2. **SSL/TLS → Origin Server**:
   - **Create Certificate** → download both files → place on the VPS at
     `/opt/ammari/caddy/certs/origin.pem` and `origin.key` (`chmod 600` the key). See
     `deploy/cloudflare/README.md` for exact hostnames to include.
   - Enable **Authenticated Origin Pulls**, then download **"Cloudflare Origin CA Root
     Certificate"** → place it at `/opt/ammari/cloudflare/origin-pull-ca.pem`.
3. Confirm `ammari.my.id`/`www`/`admin.ammari.my.id` DNS records are proxied (orange cloud) —
   should already be true per §0.

## 3. GitHub repository settings

1. **Settings → Actions → General → Workflow permissions**: set to "Read and write permissions"
   (needed for `GITHUB_TOKEN` to push to GHCR).
2. **Settings → Secrets and variables → Actions**, add:
   | Secret | Value |
   |---|---|
   | `DEPLOY_SSH_HOST` | `43.129.55.61` |
   | `DEPLOY_SSH_USER` | `deploy` |
   | `DEPLOY_SSH_KEY` | contents of `ammari_deploy_key` (the private half from step 1.3) |
   | `DEPLOY_SSH_KNOWN_HOSTS` | the output saved from step 1.4 |

## 4. Fill in the real env files

On the VPS, as `deploy`: copy `deploy/env/admin.env.example` → `/opt/ammari/env/admin.env` and
`deploy/env/web.env.example` → `/opt/ammari/env/web.env`, then fill in every value by hand —
database credentials, both `*_BETTER_AUTH_SECRET`s (`openssl rand -base64 32` each), Google
OAuth client id/secret, Resend API key, S3 credentials. These two files live **only on the
server** — never commit them, never paste them into a GitHub secret.

## 5. Verify the Caddy config before the first real deploy

```bash
caddy validate --config /opt/ammari/Caddyfile
```
(after step 6's first sync has put a `Caddyfile` there — or run it against a local checkout of
`deploy/Caddyfile` first). This exact config (including the `trust_pool` client-auth form) was
validated against `caddy:2.10.2` during development; validating again here just confirms nothing
about *your* copy of the cert/CA files is broken, not the Caddyfile syntax itself.

## 6. First deploy

Push to `dev` (or **Actions → Deploy (dev) → Run workflow** with no `sha` input) and watch the
run. It will:
1. Build (and push to GHCR) whichever of the admin/web/migrator images are affected — the first
   run has no prior commit to diff against, so it builds all three.
2. Sync `deploy/` onto the VPS (never touching `env/`, `caddy/certs/`, or
   `cloudflare/origin-pull-ca.pem` — those stay exactly as you set them in steps 1/2/4).
3. Run the migrator (`drizzle-kit migrate`) — **aborts the whole deploy if this fails**, before
   any app container is touched.
4. Bring up `caddy`/`admin`/`web` via `docker compose up -d`, reload Caddy's config, then poll
   `/api/health` on both apps before declaring success.

### Verify the Cloudflare boundary actually works

```bash
curl -I https://43.129.55.61 -H "Host: ammari.my.id" -k
```
This bypasses Cloudflare entirely (talking straight to the VPS IP). It **must fail** — a TLS
handshake error or connection reset, not an HTTP response — because Caddy requires the
Cloudflare origin-pull client certificate, which curl here doesn't have. If you get an actual
HTTP response instead, STOP and fix the Cloudflare/Caddy setup before trusting anything about
this environment: it means `cf-connecting-ip` (and therefore the auth rate limiter, §10.1) can
be spoofed by anyone who finds the VPS IP.

Then confirm the real path works: `https://ammari.my.id` and `https://admin.ammari.my.id` in a
browser.

## 7. One-time bootstrap: first super-admin

Never automated — run this once, by hand, after the first successful deploy:
```bash
docker run --rm --env-file /opt/ammari/env/admin.env \
  -e SEED_SUPER_ADMIN_EMAIL="you@example.com" -e SEED_SUPER_ADMIN_NAME="Your Name" \
  ghcr.io/tangguhriyadi/ammari-migrator:<the-deployed-sha> \
  pnpm exec tsx src/seed.ts
```
Idempotent (`onConflictDoNothing` — see `packages/db/src/seed.ts`), safe to re-run. Log in at
`https://admin.ammari.my.id` with that email to confirm.

## Rollback

```
Actions → Deploy (dev) → Run workflow → sha: <the older commit SHA to roll back to>
```
This skips the build entirely and redeploys images already pushed under that SHA — **the
migrator is never re-run on rollback**. That's exactly why `CLAUDE.md` now requires every
migration to stay backward-compatible with the previously-deployed release: rolling back only
ever swaps the app images back against whatever schema is currently live, never reverses a
migration.

## Refreshing Cloudflare's IP ranges

Rare (Cloudflare publishes changes occasionally), but when it happens:
```bash
./deploy/update-cloudflare-ips.sh
```
Regenerates `deploy/cloudflare-ips.txt` and the two derived Caddy snippets. Commit the result;
the next deploy syncs it to the server and reloads Caddy automatically.
