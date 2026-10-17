# Deploy runbook — production

Step-by-step, for the owner to run by hand, written for 2am-during-an-incident use. Background
and design rationale: `docs/plans/prod-deploy.md` (read that first if something here seems
surprising — it explains *why*, this file only tells you *what to run*). The dev equivalent is
`docs/deploy.md` — read that too if a prod command here looks unfamiliar; this file only spells
out what differs for prod (self-hosted DB, blue-green, zone-level Authenticated Origin Pulls,
`workflow_dispatch`-only deploys, nightly backups, email alerting).

No agent session has touched the real VPS, GitHub secrets, or Cloudflare settings. Every command
below is yours to run.

**Status as of 2026-10-17** (`docs/plans/prod-deploy.md` §4): the app is live, the first deploy
succeeded, the first `super_admin` is seeded, and the bucket policy is applied and verified. The
nightly backup timer and the three monitoring timers are **scripts that exist in this repo but
have not yet been installed on the VPS** (§4 step 17), and UptimeRobot has not yet been set up
(§4 step 18) — §6 and §8 of this file describe the install procedure, not a "this is already
running" claim. If you're reading this after those steps are done, ignore this paragraph.

---

## Cheat sheet

The handful of things you'll actually reach for at 2am.

```bash
# SSH in as `deploy` (routine ops, no sudo) and go to the stack's directory
ssh -i ~/ammari-secrets/ammari_prod_deploy_key deploy@43.173.52.121
cd /opt/ammari-prod

# What's running, what's active
docker compose ps
cat active-slot-admin active-slot-web          # which slot is live for each app

# Logs for one service
docker compose logs --tail 100 admin-blue      # or admin-green / web-blue / web-green / caddy / db

# Disk / backup status
df -h /
cat backup/last-backup-status.json

# Run a backup right now (not on the nightly schedule)
cd /opt/ammari-prod/backup && ./pg-backup.sh

# Confirm alert email delivery works at all
cd /opt/ammari-prod/monitoring && ./send-test-alert.sh

# External health check (no SSH needed)
curl -I https://ammari.id/api/health
curl -I https://admin.ammari.id/api/health

# Rollback: GitHub → Actions → "Deploy (prod)" → Run workflow
#   branch: main   sha: <older commit sha>   skip_migrate: checked
```

For `sudo`-requiring tasks (installing/changing systemd timers, `ufw`, first-time setup), SSH in
as `ubuntu` instead — see §0 below. If SSH is completely unreachable, Sumopod's own web console
(provider dashboard) is the emergency fallback.

---

## 0. Facts this runbook assumes

| Fact | Value |
|---|---|
| Provider / region | Sumopod, Jakarta region |
| VPS IP | `43.173.52.121` |
| OS | Ubuntu 24.04, `x86_64` |
| Specs | 2 vCPU / 3.6 GiB RAM / 60 GB SSD |
| Timezone | `Asia/Jakarta` (confirmed on the box — all timers below schedule in this zone explicitly, so this doesn't matter for correctness, only for reading `date`/log output sanely) |
| SSH — `ubuntu` | Admin account, **has sudo**. Separate key from `deploy`'s (§4 step 3). Use for anything needing root: installing/changing systemd units, `ufw`, package installs. |
| SSH — `deploy` | Automation account, **no sudo**, in the `docker` group, owns `/opt/ammari-prod`. Key: `~/ammari-secrets/ammari_prod_deploy_key` on your Mac — the same key GitHub Actions uses (`DEPLOY_SSH_KEY` environment secret). Use for routine ops: `docker compose ps/logs`, running a backup by hand, `send-test-alert.sh`. |
| SSH hardening | Password authentication and root login are both disabled. Only the two keys above work. |
| Emergency access | Sumopod's own web console (provider dashboard) if SSH is unreachable for any reason. |
| Directory layout | `/opt/ammari-prod/` — `docker-compose.yml`, `remote-deploy.sh`, `active-slot-{admin,web}`, `deployed-sha-{admin,web}`, `deploy-history.log`, `.env` (per-slot image tags), `.caddy-config-hash` (hash of the last Caddyfile/cloudflare-snippet content `remote-deploy.sh` reloaded — see §1) all at the root; `env/` (real secrets, never in git), `caddy/` — mounted WHOLE into the caddy container as one directory, not individual file mounts (see §1.6) — holding `Caddyfile`, `certs/` (origin cert), `active-upstream.caddy` (generated, see §1); `cloudflare/` (AOP CA root + IP-range snippets, a separate directory mount); `backup/`, `monitoring/` as subdirectories. |
| Env files — source of truth | **Your Mac**, `~/ammari-secrets/prod-{admin,web,db,backup}.env`. The VPS's own `/opt/ammari-prod/env/*.env` are copies pushed there by `upload-prod-env.sh` — never edit them directly on the VPS (§3). |
| Cloudflare | `ammari.id` zone, SSL/TLS mode **Full (strict)**. **Zone-level** Authenticated Origin Pulls (not Global) — our own CA, leaf cert valid to **2036**. Separate Cloudflare **origin certificate** (Caddy's TLS identity, 15-year validity, valid to **~2041**) — two unrelated cert pairs, see `deploy-prod/cloudflare/README.md`. `www.ammari.id` 301-redirects to the apex. |
| Bucket | `ammariprod-cdy2yf`, Cloudeka, endpoint `https://kencana.basic.box.cloudeka.id`, region `kencana`. Public-read: `products/*`, `content/*`, `healthcheck/*`. Private (no policy statement — default-deny): `backups/daily/*`, `backups/weekly/*`. One bucket, one S3 access key for both the app and backups (`docs/plans/prod-deploy.md` §9 "Later" list — a deliberate, accepted scope-down, not an oversight). |
| Resend | Separate prod API key, named `ammari-prod`, sending access restricted to the `mail.ammari.id` domain. |
| Google OAuth | Same OAuth client ("Ammari") as dev, with `https://ammari.id/api/auth/callback/google` and `https://admin.ammari.id/api/auth/callback/google` added as redirect URIs; consent screen is "In production." |
| GHCR access token | Classic PAT, scope `read:packages` only, used for `docker login ghcr.io` as `deploy` on the VPS (one-time, persists in `deploy`'s own `~/.docker/config.json`). **1-year expiry** — see §9's renewals calendar. |
| GitHub environment | Named exactly **`production`** (case-sensitive, exact match — `.github/workflows/deploy-prod.yml`'s `deploy` job references it literally). Deployment branch rule restricts it to `main`. Holds `DEPLOY_SSH_HOST`/`DEPLOY_SSH_USER`/`DEPLOY_SSH_KEY`/`DEPLOY_SSH_KNOWN_HOSTS` as environment secrets. |
| Repo | `github.com/tangguhriyadi/ammari` |

---

## 1. Routine deploy

Prod deploys are deliberate: `.github/workflows/deploy-prod.yml` has **no push trigger at all** —
it only runs via `workflow_dispatch`, and only against `main`.

### 1.1 Fast-forward `main` from `dev`

On your Mac, in the repo:

```bash
git fetch origin
git checkout dev && git pull --ff-only origin dev
git checkout main
git merge --ff-only dev
git push origin main
```

`--ff-only` is deliberate — it refuses rather than creating a merge commit if `main` has somehow
diverged. If GitHub's branch protection rejects even a clean fast-forward push, use a PR instead:

```bash
gh pr create --base main --head dev
# merge it with "Rebase and merge" (not a merge commit) to keep linear history
```

### 1.2 Run the workflow

GitHub → **Actions → Deploy (prod) → Run workflow**:
- **Use workflow from:** `main` (the workflow itself refuses to run against anything else)
- **sha:** leave empty to deploy `main`'s current HEAD, or set a specific commit SHA
- **skip_migrate:** leave **unchecked** — this is rollback-only (§2)
- Click **Run workflow**.

### 1.3 What the job summary shows

At the end of the run, the GitHub Actions job summary reports:
- The deployed SHA
- Which of admin/web/migrator images were built this run vs. reused from GHCR (prod normally
  reuses dev's own already-pushed images — it only builds something GHCR is missing)
- Each app's active slot (blue/green) after the run
- Whether migrations ran

### 1.4 Verify after deploy

```bash
curl -I https://ammari.id/api/health
curl -I https://admin.ammari.id/api/health
```
Both must return `200`. If you want to see which container actually served that:

```bash
ssh -i ~/ammari-secrets/ammari_prod_deploy_key deploy@43.173.52.121 \
  'cat /opt/ammari-prod/active-slot-admin /opt/ammari-prod/active-slot-web'
```

A deploy is **blue-green and sequential**: admin's old/new slots briefly overlap, flip, and the
old one stops — fully — before web's flip starts. At most one app ever runs two slots at once;
there's no visible downtime for either app during a routine deploy.

### 1.5 Caddyfile/cloudflare-snippet-only changes (no admin/web image change)

`remote-deploy.sh` reloads Caddy as a side effect of a slot flip, but if this deploy's
`caddy/Caddyfile` or `cloudflare/*.caddy` content changed while neither app's image did (e.g. a
security-header tweak with no code change), there's no flip to trigger that reload from. The
script handles this itself: it hashes those files on every run and, if the hash differs from the
last run it recorded (`.caddy-config-hash`), validates and reloads (or recreates — see §1.6)
before touching either app — so the normal "Deploy (prod)" workflow is always enough, even for a
Caddyfile-only change. If you ever need to force it by hand instead:
```bash
ssh -i ~/ammari-secrets/ammari_prod_deploy_key deploy@43.173.52.121
cd /opt/ammari-prod
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
# If that doesn't actually take effect (§1.6), recreate instead:
docker compose up -d --force-recreate caddy
```

### 1.6 Why Caddy's config is mounted as a directory, not individual files

`deploy-prod/caddy/` (Caddyfile, certs/, the generated active-upstream snippet) is mounted into
the caddy container as ONE directory (`./caddy:/etc/caddy:ro` in `docker-compose.yml`), not as
separate single-file mounts. This isn't cosmetic — **Session 10 found this broken for real on
dev**: after a deploy, the host's `/opt/ammari/Caddyfile` had the new content and `caddy reload`
reported success, but the caddy *container's own* `/etc/caddy/Caddyfile` still had the old
content. A single-file bind mount binds to that file's specific **inode**, not its path; `rsync`
(no `--inplace`) replaces a file by writing a new one and renaming it over the old name — which
changes the inode at that path — and a container holding a single-file mount never re-resolves
to the new one, no matter how many times you `reload`. Only recreating the container (which
re-establishes the bind mount from scratch) fixed it. A directory mount doesn't have this
problem: the container always resolves a path by walking the mounted directory fresh, so it sees
whatever the host currently has there. Reproduced and confirmed on real Linux bind-mount
semantics (a Docker-in-Docker Linux container, not a macOS bind mount, which uses a different
mechanism — virtiofs/gRPC-FUSE — that may not even exhibit this the same way) during Session 10.

This is why `remote-deploy.sh`'s Caddyfile-reload step (§1.5) doesn't just trust `caddy reload`:
it first compares the *container's own* sha256 of these files against the host's. If they
already match, a plain reload is trusted. If they don't — which should never happen now that the
mount is directory-based, but costs nothing to keep checking — it recreates the `caddy`
container instead of reloading (confirmed locally: a reload against a genuinely stale mount
changes nothing; `docker compose up -d --force-recreate caddy` does). Either way it then
re-verifies the hash again, and finally curls the internal `:8080` listener to confirm a security
header is actually present on a live response — not just that the file on disk looks right.
Recreating Caddy is a brief restart (stop + start): measured locally at well under 2 seconds of
actual downtime for the `caddy` service itself (no slow init — it just needs to parse a small
Caddyfile), not the whole stack.

The blue/green flip's own `active-upstream.caddy` rewrite (`write_snippet()`, a
truncate-and-write into the SAME file via `cat > ... <<EOF`, never a rename) was never at risk of
this bug in the first place, single-file-mounted or not — confirmed with the same real
Linux-bind-mount test. It's also already inside the same directory mount as everything else.

**The very first deploy after this mount-layout change needs Caddy recreated once** — handled
automatically: `docker compose up -d caddy` (which `remote-deploy.sh` already runs on every
deploy) detects the service's volume definition itself changed and recreates the container on
its own, before this script's own verify-and-reload logic even runs. No separate manual step.

---

## 2. Rollback

App-layer rollback (bad admin/web release) — same workflow, older SHA, **`skip_migrate` ticked**:

```
GitHub → Actions → Deploy (prod) → Run workflow
  branch: main
  sha: <the older commit SHA to roll back to>
  skip_migrate: ✓ checked
```

This skips `build`/`retag` and redeploys whatever was already pushed under that SHA via the same
blue-green script — **the migrator never runs on a rollback**.

**Why `skip_migrate` matters:** dispatching an older `sha` *without* ticking it would still run
that older image's migrator against whatever schema is currently live. Drizzle's migrator
normally no-ops on already-applied migrations, so this is usually harmless — but it isn't the
guarantee a rollback is supposed to give. Ticking `skip_migrate` is what actually guarantees the
migrator never touches the database on rollback.

This is exactly why **every migration must stay backward-compatible with the previously-deployed
release** (`CLAUDE.md`'s database rule) — a rollback redeploys an older app image against
whatever schema the *newer* release already migrated to, and that older code must still work
against it.

For a DB-layer disaster (corruption, bad manual change — not a bad app release), see §6's "Real
disaster restore," not this section.

---

## 3. Changing an env value

Env files on the VPS are copies, not the source of truth — always edit on your Mac and
re-upload.

### 3.1 Edit, then upload

```bash
# On your Mac — edit whichever file needs the change (admin/web/db/backup):
$EDITOR ~/ammari-secrets/prod-admin.env

# Push all four files to the VPS (scp + chmod 600, overwrites what's there):
deploy-prod/upload-prod-env.sh
```

`upload-prod-env.sh` only prints file names and permissions — it never prints a value.

### 3.2 Recreate the ACTIVE slot container

**Redeploying the same SHA through the GitHub workflow does *not* restart anything** —
`remote-deploy.sh` checks `deployed-sha-<app>` and skips an app entirely if the target SHA
already matches. An env-file change needs an explicit, manual recreate of whichever slot is
currently active:

```bash
ssh -i ~/ammari-secrets/ammari_prod_deploy_key deploy@43.173.52.121
cd /opt/ammari-prod
docker compose up -d --force-recreate "admin-$(cat active-slot-admin)"
docker compose up -d --force-recreate "web-$(cat active-slot-web)"
```

Run only the one(s) whose env file actually changed. **This is a brief, single-slot restart, not
a blue-green flip** — there's a short gap (a few seconds, while the container restarts) during
which that one app is unavailable, unlike a routine deploy. Fine for a planned env change; don't
reach for it as a substitute for the real deploy workflow.

### 3.3 Adding a brand-new secret, without ever displaying it

```bash
# On your Mac — add the new KEY=value line with your editor (never `echo`/`cat` it to a terminal):
$EDITOR ~/ammari-secrets/prod-admin.env
# then upload + recreate as above
deploy-prod/upload-prod-env.sh
ssh -i ~/ammari-secrets/ammari_prod_deploy_key deploy@43.173.52.121 \
  'cd /opt/ammari-prod && docker compose up -d --force-recreate "admin-$(cat active-slot-admin)"'
```

---

## 4. Secrets backup

`~/ammari-secrets` on your Mac is the **only** copy of every prod secret (env files, the AOP
CA/leaf, the backup encryption key). Losing this directory with no other copy means regenerating
every secret from scratch and re-deploying — and **permanently losing every existing encrypted
Postgres backup**, since `PG_BACKUP_ENCRYPTION_KEY` has no recovery path.

### 4.1 Create the encrypted archive

```bash
cd ~
tar czf - ammari-secrets | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 \
  -out "ammari-secrets-backup-$(date +%Y%m%d).tar.gz.enc"
```
You'll be prompted for a passphrase (twice) — pick a strong one and store it in your password
manager, **separately** from the archive itself. Move the resulting `.tar.gz.enc` file off this
machine (a password manager's own file-attachment feature, encrypted cloud storage, or an
external drive) — never only on the Mac, never in this repo.

### 4.2 When to regenerate

Any time a file under `~/ammari-secrets` changes: after `make-prod-env.sh --force`, after
`upload-prod-env.sh` following a manual edit, after renewing the AOP leaf or origin certificate
(§9), after adding a brand-new secret (§3.3). Also periodically (e.g. quarterly) even with no
changes, just to confirm the backup medium itself is still readable.

### 4.3 Restore

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in ammari-secrets-backup-YYYYMMDD.tar.gz.enc | tar xzf -
```
Prompts for the same passphrase, extracts `ammari-secrets/` into the current directory.

---

## 5. Backups

### 5.1 Schedule and layout

- **Nightly**, 02:15 Asia/Jakarta, via `pg-backup.timer` → `pg-backup.service` →
  `/opt/ammari-prod/backup/pg-backup.sh`.
- `pg_dump --format=custom` of the running `db` container (over its own unix socket — the
  Postgres password never leaves that container) → piped straight into
  `openssl enc -aes-256-cbc -pbkdf2` (never an unencrypted dump on disk) → uploaded to the prod
  bucket.
- Daily backups go to `backups/daily/<timestamp>.dump.enc`. On Sundays, the same dump is **also**
  uploaded to `backups/weekly/<timestamp>.dump.enc`.
- **Retention:** last 14 daily + last 8 weekly; older objects under those two prefixes are
  pruned on every run. The prune logic only ever touches `backups/daily/`/`backups/weekly/` —
  never `products/*`/`content/*` in the same bucket.

### 5.2 Check the last backup

```bash
# As deploy:
cat /opt/ammari-prod/backup/last-backup-status.json
# {"timestamp": "...", "size_bytes": ..., "daily_key": "...", "weekly_key": ... }

# What actually happened on the last scheduled run:
journalctl -u pg-backup.service -n 100
systemctl list-timers pg-backup.timer --no-pager
```
(`backup-check.sh`, §6, does this same comparison automatically every morning and emails you if
either source is missing, stale, or the two disagree.)

### 5.3 Run one now

```bash
ssh -i ~/ammari-secrets/ammari_prod_deploy_key deploy@43.173.52.121
cd /opt/ammari-prod/backup
./pg-backup.sh
```
Safe to run any time — read-only against the real `db`, writes only to the bucket's `backups/`
prefix and the local status file.

### 5.4 Restore drill (routine, disposable DB)

```bash
# On your Mac, with Docker Desktop running:
deploy-prod/restore-drill-local.sh
```

Automates `docs/runbooks/restore-drill.md`'s "Drill: restore into a disposable local Postgres"
section: reads `PG_BACKUP_ENCRYPTION_KEY` from `~/ammari-secrets/prod-backup.env` and the S3
credentials from `~/ammari-secrets/prod-admin.env` (never printed), downloads the newest
`backups/daily/` object, decrypts it, restores it into a **throwaway** Postgres container
published on a random local port, prints row counts for `staff_auth_users`/`products`/
`product_variants`/`storefront_homepage_sections`/`info_pages`/`store_settings`, then removes the
container and every temp file — never touches the real `ammari` database (it never even reads a
prod `DATABASE_URL`). Pass `--object backups/daily/<key>` to restore a specific object instead of
the newest one. Run this periodically, and after any change to `pg-backup.sh`'s own dump/encrypt
format. See `docs/runbooks/restore-drill.md` for the manual step-by-step this automates, and
§11 below for the first-real-backup drill this is also used for (§4 step 20).

Waits for the disposable Postgres by polling a real query against `ammari_scratch` itself, not
`pg_isready` — the postgres/pgvector entrypoint's temporary init server can make `pg_isready`
report "ready" up to a second or so before the target database is actually guaranteed queryable
(confirmed with a real timing run during Session 9); racing `pg_restore` into that window is what
"database `ammari_scratch` does not exist" right after a successful decrypt actually means.

### 5.5 Real disaster restore (manual, owner only)

For an actual incident — data corruption, a bad manual change — **not** a normal deploy rollback
(that's §2) and never scripted into the deploy pipeline. Full procedure in
`docs/runbooks/restore-drill.md`'s "Real disaster restore" section: stop the app containers,
take a fresh backup of the current (possibly-corrupt) state first, download + decrypt the backup
you actually want, `pg_restore --clean --if-exists` into the real `db` container's volume,
confirm row counts, restart only the slots that were actually active.

---

## 6. Monitoring

Four checks: UptimeRobot (external, SaaS) plus three VPS-local scripts alerting by email via the
prod Resend key, de-duplicated to at most one alert per 12h per condition, plus exactly one
`RECOVERED:` email once a condition clears.

### 6.1 What each alert means

| Email subject | What it means | First commands to run |
|---|---|---|
| `VPS disk usage high (N% used)` | `/` is at or above 80% used. | `docker system df -v` (the email already includes a summary), then `docker image prune -a` to reclaim old image layers. **Never** `docker system prune --volumes` or anything volume-scoped — that risks the Postgres data volume. If it's genuine data growth, not Docker cruft, plan a disk upsize. |
| `Nightly backup check FAILED` | The local status file and/or the newest `backups/daily/` object is missing, stale (>26h), or the two disagree. | `journalctl -u pg-backup.service -n 100`, `docker compose exec db pg_isready`. A single missed night self-heals the next run; a **disagreement** (status file claims success, bucket doesn't show it) needs a human look. |
| `db container is not healthy` | `db` isn't running or isn't passing `pg_isready`. | Most serious of the four — the app is almost certainly down. `docker compose logs db`, `docker compose up -d db`. |
| `caddy container is not running` | The only container publishing 80/443 is down — site likely fully unreachable. | `docker compose logs caddy`, `docker compose up -d caddy`. Usually arrives with the two `/api/health` alerts below. |
| `active admin slot (admin-X) is not running` / `active web slot (web-X) is not running` | Whatever `active-slot-admin`/`active-slot-web` names isn't running. | Likely a crash outside a deploy. `docker compose logs admin-X`/`web-X`, `docker compose up -d admin-X`/`web-X`. |
| `admin /api/health failed through Caddy` / `web /api/health failed through Caddy` | A request through Caddy's internal `:8081`/`:8080` listener to `/api/health` didn't return 200. | Check that app's own container logs, or `caddy/active-upstream.caddy` points at a running container. If this fires **alone** (no container alert), the container is up but the app inside is unhealthy. |
| `RECOVERED: ...` | The named condition has cleared. | Nothing required. If one never arrives after a fix, re-run that check by hand (below) to confirm it now passes. |

### 6.2 `send-test-alert.sh`

Confirms the Resend email leg works at all — does **not** run any real check or touch dedup
state:

```bash
ssh -i ~/ammari-secrets/ammari_prod_deploy_key deploy@43.173.52.121
cd /opt/ammari-prod/monitoring
./send-test-alert.sh
```
Confirm the email arrives at both `ammariofc@gmail.com` and your own address. If it doesn't,
check `ALERT_EMAIL_TO`/`RESEND_API_KEY`/`EMAIL_FROM` in `env/{backup,admin}.env`.

### 6.3 Timer status and logs

```bash
systemctl list-timers 'disk-alert.timer' 'backup-check.timer' 'health-check.timer' 'pg-backup.timer' --no-pager

journalctl -u disk-alert.service -n 50
journalctl -u backup-check.service -n 50
journalctl -u health-check.service -n 50
```
Schedules: disk hourly, backup-check daily 09:00 Asia/Jakarta, health every 10 minutes.

To re-run any one check by hand (e.g. to confirm a `RECOVERED` after a manual fix):
```bash
cd /opt/ammari-prod/monitoring && ./disk-alert.sh    # or ./backup-check.sh / ./health-check.sh
```

### 6.4 Installing these for the first time (or after a script/unit change)

See §8 below — `backup/` and `monitoring/` are both excluded from the routine deploy sync, so
they only ever reach the VPS via a manual `scp` + install script.

### 6.5 UptimeRobot

Free tier, external to this repo entirely — set up directly in UptimeRobot's own dashboard:
- Monitor 1: HTTP(s), `https://ammari.id/api/health`, 5-minute interval.
- Monitor 2: HTTP(s), `https://admin.ammari.id/api/health`, 5-minute interval.
- Alert contact: your signup email, checked on both monitors.

This is a separate alert channel from the Resend-based emails in §6.1 — it's the one that still
works if the VPS itself is completely unreachable (the three local scripts can't alert about
their own host being down).

---

## 7. Troubleshooting

- **502 / 520 / 521 from Cloudflare.** Usually means Caddy (or an app behind it) isn't
  responding at all. `ssh` in as `deploy`, `docker compose ps` — is `caddy` running? Is the
  active admin/web slot running? `docker compose logs caddy`. A **520 specifically**, with no
  useful Caddy-side log line, often means the zone-level Authenticated Origin Pulls toggle and
  the actual cert state have drifted apart — see the next item.
- **AOP / TLS errors** (handshake failures reaching the site at all, or Cloudflare error 520
  with nothing in Caddy's own logs). Confirm the boundary is configured consistently:
  ```bash
  caddy validate --config /opt/ammari-prod/Caddyfile
  curl --resolve ammari.id:443:43.173.52.121 https://ammari.id/ -v
  ```
  The `curl` **must** fail with a TLS handshake error (`certificate_required`, curl exit 35/56) —
  never a normal HTTP response, never a 403. If it returns an actual page, the Zone-level AOP
  toggle is off while Caddy still expects a client cert, or `trust_pool` points at the wrong CA —
  stop and fix this before anything else; it means Cloudflare's reverse-proxy protections
  (including `cf-connecting-ip`-based rate limiting) can be bypassed by anyone hitting the VPS IP
  directly. Full background: `deploy-prod/cloudflare/README.md`.
- **A container reports "unhealthy" or won't start.**
  ```bash
  docker compose logs --tail 100 <service>
  docker inspect --format '{{json .State.Health}}' $(docker compose ps -q <service>) | python3 -m json.tool
  ```
- **Out of memory.** `docker stats --no-stream` to see current RSS per container. The
  blue-green flip is sequential by design specifically so at most one app ever runs two slots at
  once (peak ≈2.2 GiB against ~3.0 GiB usable) — if you see 4 app containers running
  simultaneously, something didn't stop an old slot; check `active-slot-admin`/`active-slot-web`
  against what `docker compose ps` actually shows running.
- **Disk full.**
  ```bash
  docker system df -v
  docker image prune -a      # safe — dangling/old tagged images only, per remote-deploy.sh's own retention
  ```
  **Never** `docker system prune --volumes` or `docker volume prune` — both can remove
  `caddy_data`/`caddy_config` or the Postgres data volume.
- **Migrator fails during a deploy.** The whole deploy aborts before any app container is
  touched — the old slot keeps serving. Check the GitHub Actions log for the migrator's own
  output (it prints the real Postgres error, not just "applying migrations..."), or run it by
  hand:
  ```bash
  docker run --rm --network ammari-prod_internal --env-file env/admin.env \
    ghcr.io/tangguhriyadi/ammari-migrator:<sha>
  ```
- **"Deploy (prod)" workflow isn't visible in the Actions tab.** The workflow file must exist on
  `main` — GitHub only lists `workflow_dispatch` workflows that exist on the branch you're trying
  to dispatch against (and generally on the default branch to show up in the dropdown at all).
  If you just merged the workflow into `dev`, you still need to fast-forward `main` (§1.1) before
  it appears.
- **Secrets are empty / the deploy job can't read `DEPLOY_SSH_*`.** The GitHub **environment**
  name must be **exactly** `production` (case-sensitive) — the `deploy` job's
  `environment: production` key only picks up that environment's secrets on an exact match. Also
  confirm the environment's deployment-branch rule allows `main` (it's the actual protection
  here, since required-reviewer rules aren't offered on a private repo).
- **An S3 upload (admin image upload, nightly backup, restore drill) takes 20s-2min instead of
  failing or finishing quickly.** Confirmed against Cloudeka: a 7.6KB admin image upload PUT took
  113s, a 176KB backup upload took ~23s — not a network issue (IPv4 connects in ~5ms, TLS in
  ~30ms from both VPSes; the host has no AAAA record, so IPv6 isn't involved either). Cause: the
  AWS SDK for JS v3 (`@aws-sdk/client-s3`, pinned `3.1144.0`) and aws-cli v2 (pinned `2.27.49`)
  at these versions both default to computing/validating a flexible checksum (CRC32, streamed as
  an `aws-chunked` trailer) on every S3 request — Cloudeka doesn't handle that trailer correctly
  and stalls instead of rejecting it outright, until the client's own timeout (previously: none,
  for the JS SDK — a request could hang indefinitely) finally gives up. Fixed by forcing
  `WHEN_REQUIRED` checksum calculation/validation (`packages/storage/src/s3-client.ts` for the
  admin app's uploads; `AWS_REQUEST_CHECKSUM_CALCULATION`/`AWS_RESPONSE_CHECKSUM_VALIDATION=
  when_required` in the env file passed to the throwaway aws-cli container for
  `backup/pg-backup.sh`, `monitoring/backup-check.sh`, and `restore-drill-local.sh`) plus a 5s
  connect / 30s request timeout and `maxAttempts: 3` on the JS SDK client, so a provider-side
  stall now fails fast with the existing Indonesian "Gagal mengunggah ... Coba lagi." error
  instead of hanging. If uploads are STILL slow after this, check the `[upload-timing]` log line
  each admin upload now prints (`sharp=`/`s3=` ms, input/output bytes) to see which stage is
  actually slow before assuming it's the same checksum issue again.

---

## 8. Updating `backup/` or `monitoring/` scripts on the server

Both directories are **excluded from the routine deploy rsync** (`.github/workflows/
deploy-prod.yml`'s excludes) on purpose — so a normal app deploy can never silently overwrite a
check script, `last-backup-status.json`, or the alert-dedup state under `monitoring/state/`. They
only ever reach the VPS via a manual `scp`, run by you.

### 8.1 Copy the files over

From your Mac, as yourself (only needed once, and again any time a script/unit file under either
directory changes):

```bash
scp -i ~/ammari-secrets/ammari_prod_deploy_key -r deploy-prod/backup \
  deploy@43.173.52.121:/opt/ammari-prod/
scp -i ~/ammari-secrets/ammari_prod_deploy_key -r deploy-prod/monitoring \
  deploy@43.173.52.121:/opt/ammari-prod/
```

### 8.2 When an install script must be re-run (as `ubuntu`, with sudo)

If you only changed a `.sh` script's own body, systemd just runs whatever's on disk the next time
its timer fires — nothing else to do. If you changed a `.service`/`.timer` **unit file** (a new
schedule, a new check added), systemd needs to be told about it:

```bash
ssh ubuntu@43.173.52.121
cd /opt/ammari-prod/backup && sudo ./install-backup-timer.sh
cd /opt/ammari-prod/monitoring && sudo ./install-monitoring.sh
```
Each install script runs `systemctl daemon-reload` + `systemctl enable --now` on its own timers
and prints their next scheduled run. `install-monitoring.sh` also (re-)creates
`monitoring/state/`, owned by `deploy`.

After either install, switch back to (or SSH in as) `deploy` (no sudo) and confirm delivery still
works: `cd /opt/ammari-prod/monitoring && ./send-test-alert.sh` (§6.2).

---

## 9. Renewals calendar

| What | Expires | Rotation procedure |
|---|---|---|
| GHCR access token (classic PAT, `read:packages`, used for `docker login ghcr.io` as `deploy`) | **~Oct 2027** (1-year token) | GitHub → Settings → Developer settings → Personal access tokens → generate a new one, same `read:packages` scope. On the VPS, as `deploy`: `echo "<new PAT>" \| docker login ghcr.io -u <github-username> --password-stdin`. |
| Cloudflare zone-level AOP leaf cert (`client.pem`/`client.key`, uploaded to Cloudflare) | **2036** | `deploy-prod/cloudflare/README.md` §3 — reissue a new leaf from the **same CA** (never regenerate the CA itself for a routine renewal), re-upload both halves to Cloudflare's Zone-level AOP slot, re-verify with the §4 `curl --resolve` check. **No Caddy config change needed** — `trust_pool` trusts the CA, not the specific leaf. Cloudflare's own dashboard also emails expiry reminders ahead of this date — don't rely on that being the *only* reminder. |
| Cloudflare origin certificate (`caddy/certs/origin.{pem,key}` — Caddy's TLS identity *to* Cloudflare) | **~2041** (15-year validity) | `ammari.id` zone → SSL/TLS → Origin Server → Create Certificate (same hostnames: `ammari.id`, `www.ammari.id`, `admin.ammari.id`) → replace `/opt/ammari-prod/caddy/certs/origin.{pem,key}` on the VPS (`chmod 600` the key) → `docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile`. |
| Resend API key (`ammari-prod`) | No expiry | Only rotate if leaked: Resend dashboard → create a new key, revoke the old one. Then §3: edit `RESEND_API_KEY` in both `~/ammari-secrets/prod-admin.env` and `prod-web.env`, `upload-prod-env.sh`, force-recreate both active slots. |
| Google OAuth client secret | No expiry | Only rotate if leaked: Google Cloud Console → Credentials → reset secret. Then §3: edit `GOOGLE_CLIENT_SECRET` in both prod env files, upload, force-recreate both active slots. |

---

## 10. Bootstrap/seed of staff accounts

The first `super_admin` is already seeded (`docs/plans/prod-deploy.md` §4 step 15). This section
is for if you ever need to seed another one by hand — e.g. a fresh environment, or recovering
from losing every staff account.

Unlike dev (a direct connection to a managed database), the migrator container here needs to
join the compose network to resolve the `db` hostname inside `admin.env`'s `DATABASE_URL`:

```bash
ssh -i ~/ammari-secrets/ammari_prod_deploy_key deploy@43.173.52.121
cd /opt/ammari-prod
docker run --rm --network ammari-prod_internal --env-file env/admin.env \
  -e SEED_SUPER_ADMIN_EMAIL="you@example.com" -e SEED_SUPER_ADMIN_NAME="Your Name" \
  ghcr.io/tangguhriyadi/ammari-migrator:<the-deployed-sha> \
  node_modules/.bin/tsx src/seed.ts
```

**This inserts, it never updates** — `INSERT ... ON CONFLICT (email) DO NOTHING`, keyed on
`staff_users.email`. Re-running it for an email that's already seeded (even under a different
role env var) is a silent no-op: no new row, no update, and the script prints nothing to flag the
conflict.

**The owner's own personal account** (role `owner`, not `super_admin`) is deliberately **not**
seeded this way — create it later, once logged in as `super_admin`, through the admin UI's
`/roles-staff` page. That's also the right tool for correcting anyone's role/name after the fact
— re-running this seed script with different values for an existing email won't do it (see
above).

---

## 11. Go-live verification

`docs/plans/prod-deploy.md` §7's "Go-live checklist" and "Pre-submission content checklist" are
automated into one script, run by hand from your Mac — no agent session has touched the real
VPS/Cloudflare settings, and this script doesn't either, it only observes:

```bash
deploy-prod/go-live-check.sh
```

Prints one `PASS`/`FAIL`/`SKIP` line per check plus a summary, and exits non-zero if any check
`FAIL`ed. Never prints a secret value. Two groups of checks:

- **External** (curl/nc, no SSH) — against the real `https://ammari.id`/`https://admin.ammari.id`
  and the public S3 endpoint, exactly as a visitor/bot/payment-gateway reviewer or a port scan
  would see them: both hosts return 200 and `/api/health` is ok; direct-to-origin TLS to
  `43.173.52.121` is rejected (Authenticated Origin Pulls); `www.ammari.id` 301s to the apex with
  path+query kept; `/robots.txt` allows indexing; `/api/test/*` 404s on both hosts;
  `/api/revalidate` 404s on the public web host; HSTS/`X-Content-Type-Options`/`Referrer-Policy`/
  frame-protection headers are present with no stray `X-Robots-Tag: noindex`; an anonymous GET of
  a `backups/` object returns 403; the PDP's CTA is WhatsApp (not "Tambah ke keranjang") if at
  least one product is published yet (**`SKIP`**, not `FAIL`, on a brand-new catalog with nothing
  published).

  `:8080`/`:8081`/`:5432` "closed from outside" is also checked via `nc`, but ONLY after a
  **control probe**: `nc -z` against a random, definitely-unused high port on `43.173.52.121`
  first. If even that "connects," this network intercepts/accepts outbound TCP regardless of
  destination port (a captive portal, transparent proxy, or similar — confirmed happening on a
  real run: `nc` reported 8080/8081/5432 all reachable while `ss -tlnp` on the VPS itself showed
  only 22/80/443 public) — in that case all three port checks report **`SKIP`** with that
  explanation instead of a false `FAIL`, and the SSH-side authoritative check below is what
  actually verifies port exposure that run.

- **SSH** (as `deploy`, no sudo, via `~/ammari-secrets/ammari_prod_deploy_key` — skipped, not
  failed, if that key isn't on this machine, or pass `--skip-ssh`): `db`/`caddy`/the active
  admin and web slot containers are running (and `db` passes its healthcheck); the internal
  `:8080`/`:8081` health endpoints respond through Caddy; **an authoritative listening/
  published-port audit** — `ss -tln` (no sudo needed; falls back to parsing `/proc/net/tcp{,6}`
  directly if `ss` isn't installed) must show nothing listening on a non-loopback address except
  22/80/443, and `docker ps` must show no container publishing a host port other than caddy's
  80/443 — this is the ground truth the external nc-based checks above can't always give you;
  `STOREFRONT_CART_ENABLED=false` and `DEPLOY_ENV=production` in `env/web.env` (prints these two
  `key=value` pairs — both are non-secret flags, never a credential); no `NODE_ENV` or
  `E2E_TEST_LOGIN` key exists in any of the four env files (prints only the key **name** if one
  is ever found, never a value); the four monitoring timers (§6) are active, with their next
  scheduled run; the last backup is under 26h old; disk and memory usage (printed as `INFO`, not
  a pass/fail — `disk-alert.timer` is what actually pages on high usage).

  Each of these checks is independent: if the SSH connection drops or the remote script's output
  is incomplete for any reason, every affected check reports its **own** `FAIL` with a specific
  reason ("no data from the VPS for env/web.env (remote output missing — truncated run?)", etc.)
  instead of one opaque "didn't complete" message hiding the rest. This matters because of a bug
  found on a real run (Session 9): the remote script is piped to `bash -s` over SSH's own stdin,
  and `docker compose exec` — even with `-T` — always attaches/forwards the caller's stdin to the
  hijacked exec connection (`-T` only disables the pseudo-TTY), which silently drained the rest
  of the not-yet-executed script text with no error the moment it ran. Fixed by redirecting that
  call's stdin from `/dev/null`; see the comment at the top of the remote script in
  `deploy-prod/go-live-check.sh` for the full explanation.

Run it any time after a deploy, and definitely as part of go-live (`docs/plans/prod-deploy.md`
§4 step 18 onward) and before submitting to the payment gateway. The security headers checked
here (HSTS/`X-Content-Type-Options`/`Referrer-Policy`/`X-Frame-Options`/`Permissions-Policy`) are
set in `deploy-prod/caddy/Caddyfile` (and `deploy/caddy/Caddyfile` for dev) — see §12.

## 12. Security headers

Set in Caddy, not in either app's `next.config.ts` (confirmed neither sets any of these — see
`deploy-prod/caddy/Caddyfile`'s own comment), on every public site block (never the internal-only
`:8080`/`:8081` health listeners, where they'd be meaningless):

| Header | Value | Differs per host? |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | No |
| `X-Content-Type-Options` | `nosniff` | No |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | No |
| `X-Frame-Options` | `SAMEORIGIN` on `ammari.id` (nothing frames web today, but same-origin framing stays available for later), `DENY` on `admin.ammari.id` (admin is never framed, by itself or anyone else) | Yes |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` on both — no map-pin/checkout geolocation feature exists in code or `docs/plans/*.md` yet; flip `geolocation=()` to `geolocation=(self)` on web, and only web, if that ships later | No (for now) |
| `Server` | removed (`-Server` — Caddy sets `Server: Caddy` by default) | No |

No `Content-Security-Policy` yet — deliberately deferred; add it as its own follow-up once the
real set of script/style/image origins is known.

Each of these is defined as a reusable snippet (`web_security_headers`/`admin_security_headers`/
`www_security_headers`) imported **twice** in its site block: once for the normal response path,
and again inside a `handle_errors` block. This isn't redundant — confirmed empirically (local
`caddy run` against a deliberately-unreachable upstream, pinned `caddy:2.10.2`): a plain `header`
directive does **not** reliably survive a reverse_proxy failure (502) on its own — Caddy's
built-in error-response path re-adds `Server: Caddy` and drops the rest on that path specifically
— so without the second import inside `handle_errors`, an upstream outage would serve exactly the
one response a reviewer/scanner is most likely to see without any of these protections.

Reaching the server: see §1.5 for how a Caddyfile-only change (no admin/web image change) still
gets reloaded on the normal deploy workflow, and §1.6 for why that reload is actually trustworthy
(the single-file-bind-mount bug this headers change originally ran into on dev).

## Related docs

- `docs/plans/prod-deploy.md` — full design and the owner's step-by-step setup checklist (§4).
- `docs/deploy.md` — the dev equivalent of this runbook; useful for comparing what's the same.
- `docs/runbooks/restore-drill.md` — full restore procedure (routine drill + real disaster
  restore).
- `deploy-prod/cloudflare/README.md` — the zone-level Authenticated Origin Pulls design in full,
  including the two-cert-pairs distinction §0's Cloudflare row only summarizes.
