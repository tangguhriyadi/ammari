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
- Database: Sumopod shared Postgres 16.13, **direct** connection on port `65434` — **not**
  PgBouncer (ports 6432/6433 break Drizzle's advisory-lock/prepared-statement assumptions). The
  username on that direct port has the `.jkt1_003` suffix **stripped** (confirmed working form
  from Sumopod's dashboard) — see `deploy/env/admin.env.example`'s comment for the exact
  connection string shape.
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
   `ammari_deploy_key` (the private half) for step 3 below, then move it to
   `~/ammari-secrets/ammari_deploy_key` (`chmod 600`) and keep it there: the same key GitHub
   Actions uses from the `DEPLOY_SSH_KEY` secret also lets you `ssh -i
   ~/ammari-secrets/ammari_deploy_key deploy@43.129.55.61` directly for routine ops (reading logs,
   freeing disk space, the dev storage switch-over; see those sections below), the same
   convention prod's own `ammari_prod_deploy_key` already follows (`docs/deploy-prod.md` §0).
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
   - Enable **Authenticated Origin Pulls — the Global toggle specifically**, not Zone-level or
     Per-hostname (three separate toggles on this page — see `deploy/cloudflare/README.md` for
     what each one means and why Zone-level must stay OFF for dev: with it ON and no certificate
     uploaded, Cloudflare presents no client cert at all, and every request fails with a generic
     **Cloudflare error 520**, not an obviously TLS-related error). **Do not** download the
     "Cloudflare Origin CA Root Certificate" shown on this page for this step — that cert
     verifies *origin* certificates (the other direction), not the client certificate Cloudflare
     itself presents on origin pulls. The correct, fixed CA for Global AOP is published directly
     by Cloudflare; fetch it with:
     ```bash
     curl -fsSL https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem \
       -o /opt/ammari/cloudflare/origin-pull-ca.pem
     ```
     (same for every Cloudflare account — see `deploy/cloudflare/README.md` for how this was
     confirmed). This is exactly what `deploy/caddy/Caddyfile`'s `client_auth { trust_pool file {
     pem_file /etc/caddy/cloudflare/origin-pull-ca.pem } }` reads.
3. Confirm `ammari.my.id`/`www`/`admin.ammari.my.id` DNS records are proxied (orange cloud) —
   should already be true per §0.

**File permissions, confirmed:** the official `caddy:2.10.2` image runs its process as root
inside the container (checked directly — `docker run --rm --entrypoint sh caddy:2.10.2 -c
whoami` → `root`), and root bypasses the owner/group permission check on a file — so `chmod 600`
on `origin.key` and `origin-pull-ca.pem`, owned by whichever user fetched them (typically
`deploy`), is fine as-is. No `chown` to a Caddy-specific user, and no looser mode, needed.

## 3. GitHub repository settings

1. **Settings → Actions → General → Workflow permissions**: set to "Read and write permissions"
   (needed for `GITHUB_TOKEN` to push to GHCR).
2. **Settings → Environments → New environment**, name it exactly `dev` (the workflow's `deploy`
   job references `environment: dev`, which must match). Under that environment's own
   **Environment secrets** (not the repository-level **Secrets and variables → Actions** page),
   add:
   | Secret | Value |
   |---|---|
   | `DEPLOY_SSH_HOST` | `43.129.55.61` |
   | `DEPLOY_SSH_USER` | `deploy` |
   | `DEPLOY_SSH_KEY` | contents of `ammari_deploy_key` (the private half from step 1.3) |
   | `DEPLOY_SSH_KNOWN_HOSTS` | the output saved from step 1.4 |

   Environment secrets, not repository secrets, deliberately: prod will get its own
   `production` environment later, reusing these same four secret names with its own values,
   gated by **required reviewers** on that environment — a deploy to prod then needs an explicit
   human approval click in the Actions run, which a plain repository secret can't express.

## 4. Fill in the real env files

On the VPS, as `deploy`: copy `deploy/env/admin.env.example` → `/opt/ammari/env/admin.env` and
`deploy/env/web.env.example` → `/opt/ammari/env/web.env`, then fill in every value by hand —
database credentials, both `*_BETTER_AUTH_SECRET`s (`openssl rand -base64 32` each), Google
OAuth client id/secret, Resend API key, S3 credentials. These two files live **only on the
server** — never commit them, never paste them into a GitHub secret.

## 5. Verify the Caddy config before the first real deploy

```bash
caddy validate --config /opt/ammari/caddy/Caddyfile
```
(after step 6's first sync has put a `Caddyfile` there — or run it against a local checkout of
`deploy/caddy/Caddyfile` first). This exact config (including the `trust_pool` client-auth form)
was validated against `caddy:2.10.2` during development; validating again here just confirms
nothing about *your* copy of the cert/CA files is broken, not the Caddyfile syntax itself.

## 6. First deploy

Push to `dev` (or **Actions → Deploy (dev) → Run workflow** with no `sha` input) and watch the
run. It will:
1. Build (and push to GHCR) whichever of the admin/web/migrator images are affected — the first
   run has no prior commit to diff against, so it builds all three.
2. Sync `deploy/` onto the VPS (never touching `env/`, `caddy/certs/`, or
   `cloudflare/origin-pull-ca.pem` — those stay exactly as you set them in steps 1/2/4).
3. Run the migrator (`packages/db/src/migrate.ts`, via the image's default command) —
   **aborts the whole deploy if this fails**, before any app container is touched. Unlike the
   `drizzle-kit migrate` CLI (which on the first real deploy printed only "applying
   migrations..." then exited 1, with the real Postgres error nowhere in the log, even attached
   to a TTY), this prints the actual error — message, Postgres `code`/`detail`/`hint` when
   present, or the underlying connection error's `code`/`address`/`port` for a connectivity
   failure — and never the connection string.
4. Bring up `caddy`/`admin`/`web` via `docker compose up -d`, reload Caddy's config, then poll
   `/api/health` on both apps before declaring success. On a failure here, the Actions log now
   includes that container's last 80 log lines and Docker's own `HEALTHCHECK` log (`deploy/
   remote-deploy.sh`'s `poll_health`) — no more SSHing in by hand just to see why.

### Verify the Cloudflare boundary actually works

```bash
curl -Ik https://ammari.my.id --resolve ammari.my.id:443:43.129.55.61 --max-time 10
curl -Ik https://admin.ammari.my.id --resolve admin.ammari.my.id:443:43.129.55.61 --max-time 10
```
**Not** `curl -I https://<IP> -H "Host: ..."` — that sets the Host *header*, which is only read
after a TLS handshake has already completed, but says nothing to the handshake itself. Without
matching SNI, Caddy can't pick the right site block at all and curl fails with an unrelated
TLS error (observed: `tlsv1 alert internal error`) that tells you nothing about whether
Authenticated Origin Pulls is actually enforced. `--resolve HOST:PORT:IP` keeps the real
hostname in both the SNI and the Host header while still routing the connection straight to the
VPS IP, bypassing Cloudflare's network — that's the part that actually exercises the thing
you're testing.

Both commands **must fail** with a TLS-layer error, not an HTTP response — Caddy requires the
Cloudflare origin-pull client certificate, which curl here doesn't have. Observed failure:
OpenSSL/LibreSSL `error:...:SSL routines:...:reason(1116)` — TLS alert `certificate_required`,
sent *after* the handshake (TLS 1.3 behavior — see `deploy/cloudflare/README.md` on why the same
underlying issue shows up as Cloudflare error 520 when Cloudflare itself is the one hitting it).
The `-k` matters here too: without it, curl would fail even earlier for an unrelated reason — the
Origin Certificate isn't signed by a publicly-trusted CA (it's only trusted via the special
Cloudflare Full-strict relationship), so a normal cert-verifying curl call never even reaches the
client-auth check. If either command gets an actual HTTP response instead of a TLS error, STOP
and fix the Cloudflare/Caddy setup before trusting anything about this environment: it means
`cf-connecting-ip` (and therefore the auth rate limiter, §10.1) can be spoofed by anyone who
finds the VPS IP.

Then confirm the real path works: `https://ammari.my.id` and `https://admin.ammari.my.id` in a
browser.

## 7. One-time bootstrap: first staff account(s)

Never automated — run this once, by hand, after the first successful deploy. `packages/db/src/
seed.ts` reads up to two independent email/name pairs, each creating at most one `staff_users`
row with a specific role:

| Env vars | Role created | What that role can do (`packages/db/src/rbac/permissions.ts`) |
|---|---|---|
| `SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_NAME` | `super_admin` | **Every** permission in the catalog, including `roles.manage`, `staff.manage`, `audit_log.view`. |
| `SEED_OWNER_EMAIL` / `SEED_OWNER_NAME` | `owner` | Every permission **except** `roles.manage`, `staff.manage`, `audit_log.view` — full business access (orders, stock, products, ...), but can't manage other staff accounts, roles, or view the audit log. |

Set whichever pair(s) you actually want — both in the same invocation if you want two separate
people/accounts, or just one if you only need one account right now:
```bash
docker run --rm --env-file /opt/ammari/env/admin.env \
  -e SEED_SUPER_ADMIN_EMAIL="you@example.com" -e SEED_SUPER_ADMIN_NAME="Your Name" \
  ghcr.io/tangguhriyadi/ammari-migrator:<the-deployed-sha> \
  node_modules/.bin/tsx src/seed.ts
```
(not `pnpm exec tsx ...` — that goes through corepack, which can hang on a download
confirmation prompt the first time it runs as a given user; see `packages/db/Dockerfile`'s own
comment on its `CMD` for why this image never invokes `pnpm` at runtime at all.) Leaving a pair
unset is fine — the script logs `skipping staff user seed: SEED_OWNER_EMAIL / SEED_OWNER_NAME
not set` for whichever pair you didn't provide and moves on; it never fails because one pair is
missing.

**Important — this inserts, it never updates.** Each pair does `INSERT ... ON CONFLICT (email)
DO NOTHING`, keyed on `staff_users.email`. If you run the seed once for an email under
`SEED_SUPER_ADMIN_*`, then later run it again for the **same email** under `SEED_OWNER_*` (or
vice versa, or with a different name), the second run's insert is a **silent no-op**: no new
row (email is unique), no update to the existing row — that person keeps whichever role and name
were set by whichever invocation inserted them **first**, and the script prints nothing to tell
you a conflict happened. Changing an existing staff member's role or name is a job for the admin
UI (`/roles-staff`) once you're logged in, not for re-running this script with different values.

Idempotent in the safe sense (re-running never duplicates a row or crashes), but not a "fix this
person's role" tool. Log in at `https://admin.ammari.my.id` with the email you seeded to confirm.

## Public image access: Cloudflare custom domain (R2)

The storefront renders product and homepage-content images as plain `<img>` URLs
(`STORAGE_PUBLIC_BASE_URL` + `storageKey` + size — `apps/web/src/lib/storage/public-url.ts`).
Object storage is Cloudflare R2 (`docs/plans/storage-r2.md` — migrated off the prior Cloudeka
provider), which has no `PutBucketPolicy`/`GetBucketPolicy` API and no prefix-scoped
public-read concept — there is no `policy:apply`/`policy:show` tooling or
`bucket-policy.{dev,prod}.json` to maintain (both retired in that plan's Session 1). "Public" is
instead a **whole-bucket** property, turned on once per bucket via a Cloudflare custom domain:

- **Dev** — bucket `ammari-dev`: R2 dashboard → the bucket → Settings → Public access → Custom
  Domains → Connect Domain → `img.ammari.my.id`. Cloudflare provisions the DNS record and
  certificate automatically (same account as the `ammari.my.id` zone).
- **Prod** — bucket `ammari-prod`: same steps → `img.ammari.id`.
- Leave the "Public Development URL" (`r2.dev`) toggle **off** on every bucket, including the
  private backups bucket (`ammari-prod-backups`, which gets no custom domain at all — it stays
  reachable only via the S3 API with its own scoped token).

Once connected, every object in the bucket is public at `https://img.ammari.my.id/<key>` (dev) /
`https://img.ammari.id/<key>` (prod) — there is no per-prefix allow-list to keep in sync with
`apps/admin/src/lib/products/image-keys.ts`/`content-image-keys.ts`; the whole-bucket model
means every write path audited in `docs/plans/storage-r2.md` Session 1 is already covered.
Point `STORAGE_PUBLIC_BASE_URL` at that URL in `admin.env`/`web.env` and verify with
`pnpm --filter @ammari/storage storage:check` (prints "Public read works." against a real
healthcheck object).

## Private proof storage (supplier payments)

Payment proofs and supplier notas (`docs/plans/purchase-payments.md` §5) never go into the media
bucket: `ammari-dev` is public as a whole through `img.ammari.my.id`. They go into the private
bucket **`ammari-dev-private`** (no custom domain, R2.dev subdomain disabled, never public) with
its own token, and the admin serves them only through `/api/private-files/<id>`, permission-
checked per request. Until the three vars below are set, dev's admin boots and works as before;
only "Catat pembayaran" / "Lampirkan nota" refuse with "Penyimpanan bukti belum dikonfigurasi."
Local development needs none of this: `PRIVATE_STORAGE_DRIVER=fs` in `apps/admin/.env` keeps
files in the git-ignored `apps/admin/.private-storage/`.

1. **Cloudflare:** create the bucket and an **Object Read & Write** token scoped to
   `ammari-dev-private` only, as in `docs/deploy-prod.md` §14.1 and §14.2.
2. **[Mac]** save the token with the dashboard's Copy button, never typing or echoing it:
   ```bash
   (umask 077 && pbpaste > ~/ammari-secrets/r2-dev-private-access-key) && pbcopy < /dev/null
   (umask 077 && pbpaste > ~/ammari-secrets/r2-dev-private-secret-key) && pbcopy < /dev/null
   wc -c < ~/ammari-secrets/r2-dev-private-access-key   # a length only
   ```
3. **[Mac → dev VPS]** set the env through `set-env-var.sh` on ssh's stdin (it prints the key
   name and a length, never the value; `devssh` as in `docs/launch/checkout-dev.md`):
   ```bash
   devssh() { ssh -i ~/ammari-secrets/ammari_deploy_key deploy@43.129.55.61 "$@"; }
   printf 'ammari-dev-private\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env PRIVATE_S3_BUCKET'
   devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env PRIVATE_S3_ACCESS_KEY_ID' < ~/ammari-secrets/r2-dev-private-access-key
   devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env PRIVATE_S3_SECRET_ACCESS_KEY' < ~/ammari-secrets/r2-dev-private-secret-key
   devssh 'cd /opt/ammari && ./set-env-var.sh --check env/admin.env PRIVATE_S3_BUCKET PRIVATE_S3_ACCESS_KEY_ID PRIVATE_S3_SECRET_ACCESS_KEY'
   devssh 'cd /opt/ammari && docker compose up -d --force-recreate admin'   # admin reads env only at start
   ```
   `S3_ENDPOINT`, `S3_REGION` and `S3_KEY_PREFIX=dev/` are shared with the media bucket, so dev
   proofs land under `dev/payment_proof/...`. The admin refuses a bucket name not ending in
   `-private`, the media bucket, or the media token.
4. **Verify:** the checklist in `docs/deploy-prod.md` §14.6, steps 1 to 4 and 6, on
   `admin.ammari.my.id`.

Dev has no backup job (`deploy/` ships none, unlike `deploy-prod/backup/`), so dev proofs are not backed up.
Rollback: nothing to undo; an older image ignores these vars.

## Image tagging scheme

Every commit SHA that `deploy-dev.yml` deploys must have all three images
(`ammari-admin`/`ammari-web`/`ammari-migrator`) pushed to GHCR under that same SHA tag, because
`remote-deploy.sh` always pulls all three by one SHA — it has no notion of "this app didn't
change." But the workflow only *rebuilds* the images actually affected by the commit (the
`plan` job's path-prefix check). To close that gap:

- Every image push (the `build` job) tags **both** `ghcr.io/tangguhriyadi/ammari-<image>:<sha>`
  and `ghcr.io/tangguhriyadi/ammari-<image>:dev-latest`. `dev-latest` is a moving tag: it always
  points at the most recently built content for that one image.
- A separate `retag` job runs after `build` and, for each of admin/web/migrator that **wasn't**
  rebuilt this run, points this commit's `:<sha>` tag at that image's current `:dev-latest`
  digest with `docker buildx imagetools create` — a manifest-only copy, no pulling or re-pushing
  layers.
- This is safe to do unconditionally because the `deploy-dev` concurrency group serializes runs
  (no two can race to move `dev-latest`) and `dev` only ever moves forward (no force-push), so
  for an image that wasn't rebuilt this run, `dev-latest` can never be newer than this commit
  (nothing later has built it yet) and can never be older than this commit's actual content
  (nothing has changed that app's inputs since the last build, by definition of "not affected").
- Rollback (`workflow_dispatch` with `sha` set) skips `build` and `retag` entirely and redeploys
  whatever was already pushed under that SHA — which, as long as it was deployed after this
  scheme existed, is guaranteed to have all three tags.

## Rollback

```
Actions → Deploy (dev) → Run workflow → sha: <the older commit SHA to roll back to>
```
This skips the build entirely and redeploys images already pushed under that SHA — **the
migrator is never re-run on rollback**. That's exactly why `CLAUDE.md` now requires every
migration to stay backward-compatible with the previously-deployed release: rolling back only
ever swaps the app images back against whatever schema is currently live, never reverses a
migration.

**Do not roll dev back to a release from before S3** (migration 0024, purchase documents and
goods receipts) once any goods receipt exists on dev (`select count(*) from goods_receipts;`).
The old `/purchases` page lists the ledger rows a receipt wrote as plain purchases with the old
void button, which voids the ledger row (stock and value leave) without reversing the receipt,
so the purchase document and the stock silently disagree from then on. Roll forward with a fix
instead (push the revert or patch to `dev`). Rolling back from S4 (migration 0025, production
output receipts) to S3 is safe; see `docs/deploy-prod.md` §2.1 for what to expect while S3 is
live.

**Rolling back from S5** (migration 0026, defect stock / rejects at receipt) to S4 is safe only
while no receipt line has a reject (`select count(*) from goods_receipt_items where qty_rejected
<> 0;` is 0). The S4 release ignores `qty_rejected`: it treats rejected units as still
outstanding (so they could be received a second time), and its "Batalkan penerimaan" reverses
the good units but leaves the receipt's rejects in `defect_movements`. If rejects exist, roll
forward with a fix instead; or reverse those receipts on S5 first, then roll back.

**Rolling back from S6** (migration 0027, defect dispositions) to S5 is safe. S5 already reads
returns correctly (they re-open outstanding, so a replacement can still be received on a re-opened
document), refuses to reverse a receipt whose defects were returned or released, and simply
cannot create or reverse returns/releases while it is live. Its "Cacat" column shows everything
that arrived defective rather than what is still held, and the variance panels are absent.

## Image retention and disk space

Every deploy pulls three fresh SHA-tagged images (admin/web/migrator). Nothing removed the old
ones until `deploy/remote-deploy.sh` grew its own cleanup step: after the post-deploy health
checks pass, it keeps local images for the **currently-deployed SHA plus the previous 4 deployed
SHAs** (5 total — enough to roll back a few deploys without needing to re-pull anything) and
removes everything older, plus any dangling (untagged) image layers.

- **What counts as "deployed"**: `/opt/ammari/deploy-history.log`, one SHA per line, appended on
  every successful deploy (including a rollback — rolling back to an older SHA promotes it back
  to "current" in this file). Not image creation/pull date — a rollback pulls an *older* SHA,
  which would otherwise look newest-by-pull-time and evict the images actually still needed.
- **What it never touches**: the `caddy` image (not an `ammari-*` image, so every command is
  scoped away from it by construction), and nothing related to volumes —
  `docker image prune` is run **without** `-a`/`--volumes`, and `docker system prune --volumes`
  is never run anywhere in this pipeline.
- **Failure mode**: cleanup runs in its own subshell with `set +e`; any failure inside it only
  logs a `WARNING` to the deploy log and never fails the deploy (the deploy already succeeded —
  the health checks ran before cleanup starts).

### Emergency: manually freeing disk space

Safe to run any time, as `deploy` on the VPS (`ssh -i ~/ammari-secrets/ammari_deploy_key
deploy@43.129.55.61; cd /opt/ammari`, no `sudo` needed, same key GitHub Actions uses):

```bash
docker image prune -f                     # dangling (untagged) images only — never a tagged
                                           # image, never a volume
docker images 'ghcr.io/tangguhriyadi/ammari-*'   # see what's actually taking space and why
```

To remove a *specific* older image once you've confirmed (from the list above and
`deploy-history.log`) that it isn't one of the last 5 deployed SHAs:

```bash
docker rmi ghcr.io/tangguhriyadi/ammari-admin:<old-sha>
```

**Never run** `docker system prune --volumes` or `docker volume prune` here — both can remove
`caddy_data`/`caddy_config` (deploy/docker-compose.yml) or, if ever run from the wrong directory,
a Postgres data volume elsewhere on the box. If disk is critically full and the above isn't
enough, stop and look at `docker system df` first rather than reaching for a broader prune.

## Refreshing Cloudflare's IP ranges

Rare (Cloudflare publishes changes occasionally), but when it happens:
```bash
./deploy/update-cloudflare-ips.sh
```
Regenerates `deploy/cloudflare-ips.txt` and the two derived Caddy snippets. Commit the result;
the next deploy syncs it to the server and reloads Caddy automatically.

## Internal cron service (payment expiry sweep, order emails, retention)

Added in docs/plans/cart-checkout.md session 12. The `cron` service in
`deploy/docker-compose.yml` (pinned `curlimages/curl`, script `deploy/cron/cron.sh`, no ports)
calls the web container directly on the internal network: `POST
http://web:3000/api/internal/payments/sweep` every 5 minutes, then `POST
http://web:3000/api/internal/emails/dispatch` (order emails: retries and the "Pesanan dikirim" email
after staff's "Tandai dikirim"; session 13), and `POST http://web:3000/api/internal/retention` once at
start and then every 24 hours. All need
`Authorization: Bearer <INTERNAL_CRON_SECRET>`; Caddy answers 404 for `/api/internal/*` on the
public host, and the routes also refuse any request carrying `CF-Connecting-IP` /
`X-Forwarded-For`. The sweep only acts on checkout orders that already exist, so it is safe with
`STOREFRONT_CART_ENABLED=false`, and a Postgres advisory lock keeps two runs from overlapping.

The secret lives in two server-only files, **with the same value**: `env/web.env`
(`INTERNAL_CRON_SECRET=`) and `env/cron.env` (only that one line; never copy web.env's other
secrets into it). `remote-deploy.sh` creates an empty `env/cron.env` if it is missing (so a deploy
never fails on it) and recreates the `cron` container on every deploy. Until both files carry the
secret the cron loop idles and the routes answer 503: nothing is swept or pruned, nothing breaks.

Turning it on (as `deploy`, in `/opt/ammari`; `docs/launch/checkout-dev.md` D3 does the same from
your Mac over ssh):

1. Generate one value without printing it: `(umask 077 && openssl rand -hex 32 > /tmp/cron-secret)`.
2. Write it into both files with the synced helper, which never prints a value:
   `./set-env-var.sh env/web.env INTERNAL_CRON_SECRET < /tmp/cron-secret`,
   `./set-env-var.sh env/cron.env INTERNAL_CRON_SECRET < /tmp/cron-secret`,
   `./set-env-var.sh --same env/web.env env/cron.env INTERNAL_CRON_SECRET` (expect `MATCH`);
   `rm /tmp/cron-secret`.
3. `docker compose up -d --force-recreate web cron` (web reads env only at start).
4. Check: `docker compose logs --tail 20 cron` shows, after ~30 s,
   `/api/internal/retention -> 200 {...}` and `/api/internal/payments/sweep -> 200 {...}`.
   `ERROR ... 503` means web.env lacks the secret (or the payment provider is not configured, which
   is the sweep's 503 too: see web's logs); `401` means the two values differ; `no answer` means web
   is down; `502` means the payment gateway could not be asked and `500` that an order failed (both
   retried every 5 minutes; see web's logs). `ALERT: the payment expiry sweep has failed N times in
   a row` appears after 15 minutes of failures; `order still unpaid and open long after its payment
   window` in web's logs names an order the sweep cannot end (look at it in admin).
   `/api/internal/emails/dispatch -> 503 {"problems":[...]}` names the missing email variables
   (`RESEND_API_KEY`, `EMAIL_FROM`, `BETTER_AUTH_URL`, `CUSTOMER_BETTER_AUTH_SECRET`); `500` means a
   send failed (retried after 10 minutes for up to 23 hours) or was refused for good (see
   `order_notifications.error`); `ALERT: the order email pass has failed N times in a row` after 15
   minutes. A missing `store_settings.support_email` only logs a warning in web (owner emails wait
   until it is set in admin).

Rotating: change both files, then step 3. Turning it off: empty `env/cron.env` and recreate `cron`.

## Troubleshooting

Real failures hit during the first dev rollout, and their fixes:

- **Deploy fails with `failed to resolve reference ... ammari-web:<sha>: not found` (or
  `ammari-admin`/`ammari-migrator`), even though the build step reported success.** Hit once
  (commit `85c30f3`, admin-only change): the affected-image detection correctly built and pushed
  only `ammari-admin:<sha>`, but `remote-deploy.sh` always pulls all three images at that same
  SHA, and `ammari-web`/`ammari-migrator` were never pushed under it. Fixed by the `retag` job
  and the "Image tagging scheme" section above — every deploy now gets all three SHA tags
  regardless of which images were actually rebuilt. `remote-deploy.sh` also now verifies all
  three images exist (`docker manifest inspect`) before pulling or touching anything, so a
  missing image fails fast with a clear message instead of aborting mid-pull.
- **Migrations fail with `28P01 password authentication failed`, but the password is right.**
  Sumopod's direct port (`65434`, §0) expects the username **without** the `.jkt1_003` suffix
  shown elsewhere in Sumopod's dashboard — using the suffixed form on this port authenticates as
  a different (or nonexistent) role and fails with this exact error, which looks like a wrong
  password but isn't. Double-check `DATABASE_URL` in `env/admin.env`/`env/web.env` strips it.
- **`admin`/`web` report "unhealthy" in `docker compose ps`, even though the site works in a
  browser.** Next's standalone `server.js` binds to `$HOSTNAME`; Docker exports that as the
  container ID unless the image overrides it, so the server ends up listening on an address
  Docker Compose's own in-container healthcheck (which curls `127.0.0.1`) can't reach, while
  external traffic via Cloudflare/Caddy still gets through fine — which is exactly why this can
  look like "it works, but Docker disagrees." Fixed by `ENV HOSTNAME=0.0.0.0` in both
  `apps/admin/Dockerfile` and `apps/web/Dockerfile`; if it ever recurs, check that ENV line is
  still there after any Dockerfile edit.
- **Every request gets Cloudflare error 520.** Almost always the Authenticated Origin Pulls
  **Zone-level** toggle is ON with no custom client certificate uploaded — see
  `deploy/cloudflare/README.md`'s "three separate AOP toggles" section. Dev should only ever
  have **Global** AOP enabled. Confirm with the `curl --resolve ... -k` check above: a clean TLS
  `certificate_required` alert there (not a 520) means AOP is configured correctly and the 520
  is something else; if that curl check itself returns an actual HTTP response, something is
  mis-set in the other direction (origin trusting nothing, effectively).
- **Reading logs and health status on the VPS.** As `deploy` (not `ubuntu` or `root` —
  `/opt/ammari` and the running containers are owned by/started as `deploy`), reached directly
  from your Mac with the dedicated deploy key, no `sudo` needed:
  ```bash
  ssh -i ~/ammari-secrets/ammari_deploy_key deploy@43.129.55.61
  cd /opt/ammari
  docker compose ps                                              # overall status
  docker compose logs --tail 100 admin                           # or web / caddy
  docker inspect --format '{{json .State.Health}}' $(docker compose ps -q admin) | python3 -m json.tool
  ```
  (`deploy/remote-deploy.sh`'s own `poll_health` now prints the same two things automatically
  into the GitHub Actions log when a deploy's post-deploy health check fails — this is for
  digging in further by hand, or for a failure that happens well after a deploy succeeded.)
- **A Caddyfile change deploys, `caddy reload` reports success, but the new config never
  actually takes effect.** Hit for real: the host's `/opt/ammari/Caddyfile` had the new content,
  but the caddy *container's own* `/etc/caddy/Caddyfile` still had the old content. Cause: the
  Caddyfile used to be bind-mounted as a single file, which binds to that file's specific
  **inode**, not its path — `rsync` (no `--inplace`) replaces a file by writing a new one and
  renaming it over the old name, which changes the inode, and a single-file-mounted container
  never re-resolves to the new one no matter how many times you `reload`. Fixed by mounting
  `deploy/caddy/` as one DIRECTORY (`./caddy:/etc/caddy:ro` in `docker-compose.yml`) instead —
  a directory mount always resolves a path fresh against whatever the host currently has there.
  `remote-deploy.sh` no longer just trusts a reload either: it compares the container's own
  sha256 of these files against the host's first, recreates the `caddy` container instead of
  reloading if they ever mismatch, and re-verifies after. If this ever recurs anyway (e.g. after
  some future compose/volume change), the fix is the same: `docker compose up -d --force-recreate
  caddy` — a reload alone will NOT fix a genuinely stale mount, only recreating the container
  re-establishes it.
