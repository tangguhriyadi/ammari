# Plan: Production Deployment (ammari.id / admin.ammari.id)

## Summary

Goal: `ammari.id` (web) and `admin.ammari.id` (admin) are live in production around
**25 Oct 2026**, specifically so the site can be submitted to the payment gateway for
verification ahead of the **1 Nov 2026** launch (`docs/SPEC.md` §1). Checkout stays **off**
(`STOREFRONT_CART_ENABLED=false`, already the default in `deploy/env/web.env.example`) —
WhatsApp is the primary CTA. This is a narrower goal than full launch: catalog + voucher claim +
account pages live and reachable, no live checkout yet.

This plan reuses the dev pipeline (`docs/deploy.md`, `docs/plans/deploy-dev.md`,
`.github/workflows/deploy-dev.yml`, `deploy/`) wherever it already fits and calls out exactly
where prod must differ. The two biggest departures from dev, both already decided (see below):
Postgres runs as a **container on the prod VPS itself** (dev uses a managed Sumopod instance),
and app deploys are **blue-green** (dev does a brief-downtime `docker compose up -d` swap).

## Decisions already made (do not re-open)

- Separate prod VPS: **Sumopod, Jakarta region (same provider as dev), 2 vCPU / 3.6 GiB RAM
  (confirmed via `free -h` on the provisioned box — see §4 step 1), 60 GB SSD.** SSH key only,
  `ufw` 22/80/443, `deploy` user, Docker log limits (already the pattern in
  `deploy/docker-compose.yml`'s `x-logging`).
- Postgres 16 + pgvector as a **container** on the prod VPS, not exposed publicly. Nightly
  encrypted `pg_dump` with retention, plus a documented restore drill.
- Cloudflare in front of `ammari.id`, **Full (strict)** + Authenticated Origin Pulls using a
  **custom per-zone certificate** (dev uses the Global toggle; prod must not depend on it).
- **One** prod storage bucket (`ammariprod-cdy2yf`, Cloudeka, endpoint
  `https://kencana.basic.box.cloudeka.id`, region `kencana` — same Cloudeka setup as dev),
  **not** a separate bucket per purpose. Public-read policy pattern unchanged (`products/*`,
  `content/*`), applied with the existing `policy:apply --env prod` script. Backups live in the
  **same** bucket under a private `backups/` prefix — **not** a separate dedicated backup
  bucket/access key, a scope-down from this plan's original design (see the "Later" list at the
  end of this plan for the reasoning and the planned upgrade path).
- Separate Resend API key for prod (domain `mail.ammari.id` already verified), separate Google
  OAuth redirect URIs for `ammari.id`, fresh secrets (`REVALIDATE_SECRET`, `PREVIEW_SECRET`,
  both `BETTER_AUTH_SECRET`s) generated fresh for prod.
- Blue-green (zero-downtime) container switch for prod app deploys. Prod deploys are a
  deliberate action: `deploy-prod.yml` has **no `push` trigger at all** — it only runs via
  `workflow_dispatch`, a human clicking "Run workflow" in the Actions tab. (GitHub's
  required-reviewer / wait-timer deployment-protection rules are a **public-repo-only** feature
  on Free/Pro/Team — this repo is private, so that gate isn't available; the trigger design is
  the substitute for it, not a workaround for a missing nice-to-have. See §8 item 3.)
- No test-only routes/flags in prod (`E2E_TEST_LOGIN`, `/api/test/*`); `NODE_ENV` is never
  written into an env file (the Docker images already bake `NODE_ENV=production`).
- Secrets are generated with `openssl` straight into files on the owner's own Mac, never
  displayed in a terminal, pasted into chat, or typed by hand onto the VPS — the files
  themselves are copied across with `scp` (§4).

## Note on `docs/SPEC.md` §2.4

SPEC.md currently says prod uses "a separate managed Postgres 16 + pgvector instance" — that's
now stale; the decision above is a self-hosted container. Per `CLAUDE.md` ("if something here
and SPEC.md disagree, SPEC.md wins — fix this file"), Session 1 below includes updating that one
paragraph. Flagging it here so it isn't missed; this plan file follows the decision above, not
the current SPEC.md text.

---

## 1. Architecture overview

```
Internet
   │
   │  HTTPS (ammari.id, www.ammari.id, admin.ammari.id)
   ▼
Cloudflare  (DNS proxy, Full-strict TLS, per-zone Authenticated Origin Pulls)
   │
   │  HTTPS + client cert (our own leaf cert/key uploaded to Cloudflare; Caddy verifies against
   │  our own CA root, kept only on the origin)
   ▼
┌────────────────── Prod VPS (Jakarta, 2 vCPU / 3.6 GiB RAM, ufw 22/80/443) ───────────────────┐
│                                                                                               │
│  Caddy (:80, :443 — the ONLY container publishing ports), mem_limit ~128MB                   │
│   ├─ ammari.id                        → reverse_proxy to the ACTIVE web-{blue,green} slot     │
│   ├─ www.ammari.id                    → 301 redirect to https://ammari.id (apex is canonical) │
│   └─ admin.ammari.id                  → reverse_proxy to the ACTIVE admin-{blue,green} slot   │
│       (both blocked for /api/test/*; web blocked for /api/revalidate on the public hostname)  │
│                                                                                               │
│  internal Docker network (bridge, no published ports — only Caddy + these talk to each other)│
│   ├─ admin-blue / admin-green   (only one "active" at a time; ~450MB mem_limit each,          │
│   │                               NODE_OPTIONS=--max-old-space-size=320)                      │
│   ├─ web-blue   / web-green     (same caps)                                                   │
│   └─ db  (pgvector/pgvector:pg16, named volume, no published port, pg_isready healthcheck,    │
│            mem_limit ~768MB, modest shared_buffers/effective_cache_size — see Session 1)      │
│                                                                                               │
│  migrator (one-off `docker run --rm`, same `internal` network, runs BEFORE any slot swap)     │
│                                                                                               │
│  nightly systemd timer: pg_dump → AES-256 encrypt → upload to the SAME prod bucket's private  │
│  backups/ prefix (shares the app's one access key — accepted risk, see "Later" list)          │
│                                                                                               │
│  systemd timers: disk-space alert, backup-success alert — both email via the prod Resend key  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

**What's public:** only Caddy's 80/443, and only reachable in practice via Cloudflare (Full-strict
+ zone-level Authenticated Origin Pulls — a direct curl to the VPS IP must fail with a TLS error,
exactly like dev's existing verification step in `docs/deploy.md`). `admin`, `web`, and `db` are
never reachable except from Caddy / each other over the `internal` network. The DB is not
reachable from the internet, from the owner's laptop, or from the dev VPS — only from containers
on this one VPS.

**What runs where:** GitHub Actions builds and pushes images (never the VPS — it can't reliably
run a Next.js build, same reasoning as `docs/SPEC.md` §2.3); the VPS only pulls, migrates,
health-checks, and swaps.

**Memory budget:** 3.6 GiB total RAM (confirmed via `free -h` on the actual provisioned VPS,
§4 step 1 — revised down from this plan's original 4 GB planning estimate), with ~0.6 GiB
already used by the OS/Docker daemon at idle, leaving **~3.0 GiB usable**. Steady state (one
slot per app + db + caddy) is comfortably under 1 GB.

The pressure point is the brief window during a blue-green switch where **both** slots of an
app can be running. Given the usable headroom, **the sequential slot switch is the default
design, not a fallback**: admin flips fully (start → health-check → Caddy flip → stop old)
before web's flip starts, so **at most one app ever has two slots running at once** — peak is 3
app containers (the other app's single active slot + the flipping app's old and new slots), not
4. Peak budget: 3×450MB + 768MB + 128MB ≈ **2.25 GB**, comfortably under the ~3.0 GiB usable
and under this plan's own ~2.4 GB target for the sequential design — which is why the per-app
mem_limit/NODE_OPTIONS caps chosen in Session 1 didn't need to change when this was revised down
from the original 4 GB estimate. Session 3 still includes an actual measurement on the real VPS
to confirm this holds in practice, not just on paper — see Session 3 and §4.

---

## 2. Differences from dev

| Aspect | Dev (current) | Prod (this plan) |
|---|---|---|
| VPS | Shared, 43.129.55.61 | Separate VPS, **Sumopod, Jakarta region** (same provider as dev), 2 vCPU/3.6 GiB RAM, **60 GB SSD** (provisioned, confirmed via `free -h`/`df -h` — §4 step 1; OS + 3 images × last-5-SHA retention + Postgres data + short-lived backup staging, with the 80%-used disk alert from §6 as the backstop) |
| Database | Managed Sumopod Postgres 16, direct port, `sslmode=disable` | **Self-hosted** `pgvector/pgvector:pg16` container on the VPS, named volume, not exposed; `sslmode` moot (same-host, over the Docker bridge); modest `mem_limit`/`shared_buffers` tuning (§1, Session 1) |
| Deploy trigger | Push to `dev` → auto-deploy | **`workflow_dispatch` only** (`sha` input, empty = current `main` HEAD) — **no `push` trigger at all**. Required-reviewer approval isn't available on a private repo (§8 item 3), so "no automatic trigger exists" is the deliberate-action gate, not an approval click |
| App container swap | `docker compose up -d` (brief downtime while the container restarts) | **Blue-green**: new slot started + health-checked while the old slot still serves traffic, then Caddy's upstream flips, then the old slot stops. **Sequential by default** (admin flips fully, then web) — the real VPS's ~3.0 GiB usable RAM (§1) means at most one app ever has two slots running at once; Session 3's dry run measures actual peak RSS to confirm |
| Cloudflare AOP | Global toggle (shared Cloudflare cert, no upload) | **Zone-level**: a leaf certificate **and its private key** we generate and upload to Cloudflare for this zone only; our CA's root key never leaves the owner's machine/password manager and only the root cert sits on the VPS — Caddy's `trust_pool` points at **our own CA**, not Cloudflare's published Global CA |
| www handling | `ammari.my.id` and `www.ammari.my.id` both served directly | `www.ammari.id` **301-redirects** to `https://ammari.id` — the apex is canonical |
| Image tags | `:<sha>`, `:dev-latest` | Same images, reused as-is (environment-agnostic by design — see `apps/admin/Dockerfile`'s comment on build-time placeholders), additionally tagged `:prod-latest` |
| Backups | None (managed provider's own responsibility) | Nightly `pg_dump`, AES-256-encrypted client-side, uploaded to the **same** prod bucket's private `backups/` prefix (not a separate bucket — see "Later" list), documented restore drill |
| Robots / indexing | `DEPLOY_ENV=dev` → `disallow: /`; Caddy adds `X-Robots-Tag: noindex` | `DEPLOY_ENV=production` → allowed; the prod Caddyfile **omits** the `X-Robots-Tag` lines (per the dev Caddyfile's own comment flagging this) |
| Secrets | Reused dev Google OAuth client, dev Resend key | Fresh secrets everywhere per the decisions above; same Google OAuth **client**, additional redirect URIs + origins, consent screen must be "In production" (§4 step 9) |
| Secrets handling | N/A | Built with `openssl ... >> file` on the owner's Mac, never echoed to a terminal; `scp`'d to the VPS, `chmod 600` (§4 steps 10/12) |
| Config location | `deploy/` | **`deploy-prod/`** — a parallel directory, not branches inside `deploy/` (keeps the two `rsync` targets from ever being able to cross-contaminate; see Session 1) |
| GitHub Environment | `dev`, no deployment branch rule | `production` — environment secrets only, plus a **deployment branch rule** restricting it to `main` (no required reviewers — not available for a private repo) |

---

## 3. Ordered sessions for Claude Code

Each is scoped to fit one session. Do `/plan` → confirm → implement → `/code-review` (the
matching reviewer) → `/checkpoint` for each, per `CLAUDE.md`'s workflow. None of these touch a
real server or commit secrets — they produce config/scripts/docs that the owner then applies by
hand per §4.

### Session 1 — `deploy-prod/` scaffolding + compose + SPEC.md fix
- **Scope:** create `deploy-prod/docker-compose.yml` (caddy, db, admin-blue, admin-green,
  web-blue, web-green, as one compose file where only the active slots are actually started),
  `deploy-prod/env/admin.env.example`, `deploy-prod/env/web.env.example` (adapted from
  `deploy/env/*.env.example` — `DATABASE_URL` now points at the `db` service on the internal
  network, `DEPLOY_ENV=production`, `BETTER_AUTH_URL=https://ammari.id` for web — the **apex**,
  not `www.` — so `metadataBase` in `apps/web/src/app/layout.tsx` resolves canonical/OG URLs to
  the apex automatically, `STOREFRONT_CART_ENABLED=false` kept explicit with a comment not to
  flip it before checkout actually ships). Set `mem_limit` on every service (`caddy` ~128MB,
  `db` ~768MB, each `admin-*`/`web-*` ~450MB) and `NODE_OPTIONS=--max-old-space-size=320` on the
  admin/web services (heap cap below the container's `mem_limit`, leaving headroom for non-heap
  RSS — see §1's memory budget). Give the `db` service modest tuned settings via compose
  `command:` flags (e.g. `-c shared_buffers=192MB -c effective_cache_size=512MB` — conservative
  for a 3.6 GiB box with a small catalog). Update `docs/SPEC.md` §2.4 per the note above.
- **Files:** `deploy-prod/docker-compose.yml`, `deploy-prod/env/*.example`, `docs/SPEC.md`.
- **Verification:** `docker compose -f deploy-prod/docker-compose.yml config` validates; no
  secrets in the diff (`git diff` review); `pnpm lint`/`typecheck` unaffected (no app code
  touched).
- **Rollback:** delete the new directory; no server/state involved.

### Session 2 — Prod Caddyfile + Cloudflare zone-level AOP
- **Scope:** `deploy-prod/Caddyfile` (copy dev's as the stated starting point, drop the
  `X-Robots-Tag` lines, serve `ammari.id` and `admin.ammari.id`, add a **separate site block**
  for `www.ammari.id` that does `redir https://ammari.id{uri} 301` — no `reverse_proxy`, no TLS
  client-auth needed beyond the same cert since it's the same zone — keep the `/api/test/*` and
  `/api/revalidate` blocks on the two app hosts). `deploy-prod/cloudflare/README.md` documenting
  the **zone-level** cert flow: generate our own CA, then a **leaf** certificate signed by it
  with `basicConstraints=CA:FALSE` (a leaf cert must not itself be a CA), upload **both the leaf
  certificate and its private key** to Cloudflare's per-zone Authenticated Origin Pulls slot (not
  just the cert — Cloudflare presents this exact cert+key pair on every origin pull, so it needs
  both halves), keep the CA root on the VPS for Caddy's `trust_pool`, and document Cloudflare's
  own cert-expiry email notifications plus the renewal procedure (reissue a new leaf from the
  same CA before expiry, re-upload to Cloudflare, no Caddy config change needed since
  `trust_pool` trusts the CA, not the specific leaf). Generalize
  `deploy/update-cloudflare-ips.sh` to also write into `deploy-prod/cloudflare/` (Cloudflare's
  published IP ranges are global, not per-zone, so one script can feed both — same
  `cloudflare-ips.txt` as source, two generated-snippet destinations) — this is the only touch
  to an existing dev file in this whole plan, and it's additive (dev's own output paths are
  unchanged).
- **Files:** `deploy-prod/Caddyfile`, `deploy-prod/cloudflare/README.md`,
  `deploy/update-cloudflare-ips.sh` (generalize destination).
- **Verification:** `caddy validate` against the new Caddyfile (locally, via the pinned
  `caddy:2.10.2` image, same as dev's own verification step); confirm the `www` redirect block
  actually returns 301 with the right `Location` header against a local Caddy run; confirm dev's
  own generated files are byte-identical after the script change (no regression).
- **Rollback:** revert the one shared script; delete `deploy-prod/Caddyfile`/`cloudflare/`.

### Session 3 — Blue-green deploy script
- **Scope:** `deploy-prod/remote-deploy.sh`. Mechanics:
  1. Track the active slot **per app** in `/opt/ammari-prod/active-slot-admin` and
     `/opt/ammari-prod/active-slot-web` (`blue` or `green`, tracked separately since only one
     app's image may have actually changed for a given deploy).
  2. Verify all three images exist at the target SHA (same pattern as dev's
     `remote-deploy.sh`).
  3. Wait for `db` to be healthy (`docker compose exec db pg_isready`) — new on prod since dev
     has no local DB to wait for.
  4. Run the migrator against `db` (`docker run --rm --network ammari-prod_internal ...`),
     aborting the whole deploy on failure, same as dev.
  5. **Sequential by default** (§1's revised memory budget — the real VPS has ~3.0 GiB usable,
     not the original 4 GB planning estimate): for each of admin/web whose image actually
     changed this deploy, flip that app's slot **fully** — start the **inactive** slot's
     container on the new image tag, health-check it directly (not yet through Caddy), flip
     Caddy's upstream (step 6), re-verify through Caddy (step 7), then stop the old slot (step
     8) — **before starting the other app's flip**, if both changed in the same deploy. At most
     one app ever has two slots running at once; peak is 3 app containers, not 4.
  6. Regenerate a small generated Caddy snippet (`deploy-prod/caddy/active-upstream.caddy`)
     pointing `reverse_proxy` at the now-active slot's container names, then `caddy reload`
     (same no-downtime reload dev already uses for config changes).
  7. Re-verify health **through Caddy** (end-to-end, not just the container).
  8. Stop (not remove) the old slot's containers; update the per-app `active-slot-*` file.
  9. Reuse dev's image-retention logic (keep current + previous 4 deployed SHAs; never touch
     `caddy`/`db` images or any volume).
- **Memory check (required before this ships):** run a dry deploy locally (or on the VPS before
  the first real cutover) that exercises a deploy where **both** admin and web change in the
  same run, confirming the sequential flip in step 5 actually keeps peak concurrent app
  containers at 3, and measure actual peak RSS across all containers (`docker stats --no-stream`
  polled during the overlap window) to confirm it stays under the ~2.4 GB target (§1). If a real
  measurement ever doesn't fit that target, tighten the per-container `mem_limit`/
  `NODE_OPTIONS` caps rather than reverting to a simultaneous flip — document the measured
  numbers directly in the script's own comment, not just in this plan.
- **Files:** `deploy-prod/remote-deploy.sh`, `deploy-prod/docker-compose.yml` (health-check
  wiring for `db`).
- **Verification:** dry-run against a disposable local compose stack (not the real `ammari` dev
  database — spin up `deploy-prod/docker-compose.yml` locally with throwaway env values) to
  exercise the full slot-flip logic, including the memory check above, before it ever touches a
  server.
- **Rollback:** re-running the script with an older SHA re-triggers the same flip in reverse
  (same idea as dev's rollback — the migrator is never re-run on rollback, which is exactly why
  `CLAUDE.md`'s migration backward-compatibility rule matters here too).

### Session 4 — `deploy-prod.yml` GitHub Actions workflow
- **Scope:** `plan`/`build`/`retag`/`deploy` jobs, triggered on **`workflow_dispatch` only** — no
  `push` trigger of any kind. Inputs: `sha` (optional — empty means "deploy whatever `main`
  currently points at," since `github.sha` already resolves to the dispatched ref's HEAD) and
  `skip_migrate` (boolean, default `false` — **ROLLBACK ONLY**, skips the migrator; never set on
  a normal forward deploy). `plan` guards before anything else runs: (a) the run must be
  dispatched with `main` selected as the branch, failing otherwise — the workflow file is
  reachable from `dev` too (it has to be, to get merged there first), so this is an explicit
  check, not something implied by "no push trigger exists"; (b) `sha` must match the same strict
  hex-digest regex `deploy-dev.yml`'s own "Resolve target SHA" step uses, carried over unchanged;
  (c) the resolved sha must additionally be an ancestor of (or equal to) `origin/main`
  (`git merge-base --is-ancestor`, after fetching both `main` and `dev` so the check has a real
  answer either way) — a commit that only ever lived on `dev` can never be deployed to prod, even
  by hash. Unlike `deploy-dev.yml`, `plan` does **not** decide what to build from a git diff —
  since `main` only ever fast-forwards from `dev`, images for the target sha normally already
  exist in GHCR from dev's own pipeline; `plan` checks GHCR directly (`docker manifest inspect`)
  for each of admin/web/migrator and only ever hands `build` the ones actually missing. `retag`
  then always points `:prod-latest` at `:<sha>` for **all three** images (whether just-built or
  already-existing) via `docker buildx imagetools create` (manifest-only copy, no layer
  pull/push). `deploy` keeps `environment: production` for its secrets (so the environment's
  deployment branch rule, §4 step 11, actually applies) and checks out **current `main` HEAD**
  (not the target sha) for the `deploy-prod/` scaffolding it rsyncs — a rollback redeploys an
  older app sha through the current deploy tooling, the same split dev's own rollback already
  relies on. The rsync excludes carry over dev's three (`env/`, `caddy/certs/`,
  `cloudflare/origin-pull-ca.pem`) plus prod-only additions: `backup/` (Session 5, once it lands)
  and every piece of `remote-deploy.sh`'s own on-disk state (`active-slot-*`, `deployed-sha-*`,
  `deploy-history.log`, `.env`, and the generated `caddy/active-upstream.caddy` — the checked-in
  copy in this repo is a committed default/explainer, not the live state, so a sync must never
  overwrite it with that default). The `deploy` job writes a job summary: the deployed sha, which
  images were built vs. reused from GHCR, each app's active slot after the run, and whether
  migrations ran.
- **Files:** `.github/workflows/deploy-prod.yml`.
- **Verification:** `actionlint` (which runs `shellcheck` against every `run:` block) clean; a
  separate manual `shellcheck` pass against each extracted inline script, also clean; confirmed
  there is no `on: push:` key anywhere in the file; confirmed the SHA-regex injection guard
  matches `deploy-dev.yml`'s unchanged; walked the guard logic by hand against four cases (`main`
  HEAD, an older `main` sha, a `dev`-only sha, a malformed sha). No real workflow run was
  triggered and no server was touched.
- **Rollback:** delete the workflow file; nothing has deployed yet at this point.

### Session 5 — Backup + restore drill
- **Scope:** `deploy-prod/backup/pg-backup.sh` (`pg_dump` → `openssl enc -aes-256-cbc -pbkdf2`
  with `PG_BACKUP_ENCRYPTION_KEY` read from `deploy-prod/env/backup.env` → `aws s3 cp` to the
  **same** prod bucket's private `backups/` prefix — see §4 step 7 — using the **same S3
  credentials admin.env already holds** (`S3_ENDPOINT`/`S3_REGION`/`S3_BUCKET`/
  `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, read from `/opt/ammari-prod/env/admin.env`, not
  duplicated into `backup.env` — one bucket, one access key, see the "Later" list for the
  upgrade path), using the same path-style S3 client approach
  `packages/storage/src/s3-client.ts` already documents for Cloudeka). Retention (confirmed):
  delete remote objects under `backups/` older than the 14-daily + 8-weekly window — the script
  must never touch `products/*`/`content/*`, which share the bucket. A systemd timer unit (not
  cron — easier to see failures with `systemctl status`) to run it nightly.
  `docs/runbooks/restore-drill.md`: step-by-step for restoring a backup into a **disposable**
  local Postgres container (never the real `ammari` db, per `CLAUDE.md`'s local-safety rule) and
  verifying row counts/an app smoke test against it.
- **Files:** `deploy-prod/backup/pg-backup.sh`, `deploy-prod/backup/pg-backup.service`,
  `deploy-prod/backup/pg-backup.timer`, `deploy-prod/env/backup.env.example`,
  `docs/runbooks/restore-drill.md`.
- **Verification:** run the restore drill for real, once, against a local disposable DB seeded
  with throwaway data — prove the whole chain (dump → encrypt → upload → download → decrypt →
  restore) actually works before the owner ever needs it under pressure. Also confirm, once a
  real object exists under `backups/` in the prod bucket, that an anonymous request to it
  returns **403** (same check as Session 7's and §7's go-live checklist — the `backups/` prefix
  must stay outside the policy's public-read statement even though it shares a bucket with the
  public `products/*`/`content/*` prefixes).
- **Rollback:** scripts only; nothing destructive by construction (backup is read-only against
  the real DB; restore drill only ever targets a disposable DB).

### Session 6 — Monitoring minimum
- **Scope:** document (not code — UptimeRobot is a SaaS the owner sets up directly, §4 step 18)
  the uptime check, and build the other two, both alerting by **email via the prod Resend API
  key** (read from `/opt/ammari-prod/env/admin.env`, same key the app already uses for OTP —
  a plain `curl` to Resend's `/emails` endpoint, no new credential needed) to **both**
  `ammariofc@gmail.com` and the owner's own address: (a) uptime — UptimeRobot free tier hitting
  `/api/health` on both domains, 5-minute interval (confirmed choice; no agent action beyond
  documenting it in `docs/deploy-prod.md`), (b) disk-space alert — a small script + systemd timer
  on the VPS that alerts past a threshold (propose 80% used), (c) backup-success check — a script
  that alerts if **either** the newest object under the prod bucket's `backups/` prefix is older
  than ~26h **or no backup object exists at all yet** (so a brand-new install with zero backups
  ever run pages someone immediately, instead of silently waiting for a "staleness" condition
  that can never trigger when there's nothing to compare against).
- **Files:** `deploy-prod/monitoring/disk-alert.sh` + its timer unit,
  `deploy-prod/monitoring/backup-check.sh` + its timer unit, a short section in
  `docs/deploy-prod.md`.
- **Verification:** trigger each alert condition manually once (fill the disk with a dummy file
  under a throwaway path, or point the backup check at an empty/missing bucket prefix) to confirm
  the alert actually fires and the email actually arrives, then clean up the manual trigger.
- **Rollback:** scripts/timers only.

### Session 7 — Prod bucket policy + runbook (`docs/deploy-prod.md`)
- **Status:** the bucket-policy half of this session's scope was pulled forward and done
  already (2026-10-17), once the owner provisioned the real bucket (§4 step 7) —
  `packages/storage/bucket-policy.prod.json`'s `REPLACE_WITH_PROD_BUCKET_NAME` is filled in with
  the real bucket (`ammariprod-cdy2yf`), scoped to `products/*`/`content/*`/`healthcheck/*` only
  — the private `backups/` prefix in that same bucket has no matching statement and must stay
  that way (verified: §7's go-live checklist, Session 5's verification). What's left for this
  session is `docs/deploy-prod.md` itself.
- **Scope:** write `docs/deploy-prod.md` — a full runbook mirroring `docs/deploy.md`'s shape
  (facts this runbook assumes → one-time VPS setup → Cloudflare → GitHub settings → env files →
  first deploy → bootstrap → bucket policy → image tagging → rollback → retention →
  troubleshooting), but for prod's specifics (self-hosted DB, blue-green, zone-level AOP, the
  single-bucket backup layout, workflow_dispatch-only trigger).
- **Files:** `docs/deploy-prod.md` (`packages/storage/bucket-policy.prod.json` already done,
  above).
- **Verification:** `pnpm --filter @ammari/storage policy:apply -- --env prod --dry-run` once
  real bucket credentials exist (owner runs this; agent can review the dry-run JSON output);
  once applied for real, an anonymous `curl` to an object under `backups/` must return **403**
  (document this exact check in the runbook's own verification section, not just this plan).
- **Rollback:** doc-only; the bucket policy apply step is already a dry-run-first, additive-only
  operation by design (same as dev's).

### Session 8 — Go-live dry run
- **Scope:** once all of the above is merged and the owner has completed §4 up through "First
  deploy," do a final pass: confirm `robots.ts` serves `allow` only once `DEPLOY_ENV=production`
  is actually set, confirm the Caddy `/api/test/*` block is in place, confirm
  `STOREFRONT_CART_ENABLED` reads `false` from the live env file, confirm `www.ammari.id` actually
  301s to the apex, confirm **`store_settings.whatsapp_number`** (admin: Content → Settings) is
  set so the PDP's CTA renders — this is read from the database via
  `apps/web/src/lib/store-settings.ts`'s `getWhatsappNumber()`, not an env var; `STORE_WHATSAPP_NUMBER`
  is only a fallback for when the database value is empty and should not be relied on in prod —
  walk the go-live checklist in §7 end to end against the real prod URLs.
- **Files:** none (verification session) — any fix found becomes its own small follow-up commit.
- **Verification:** the checklist in §7, performed for real against `https://ammari.id` and
  `https://admin.ammari.id`.
- **Rollback:** n/a (read-only session); any issue found triggers the normal rollback path (§7).

---

## 4. Owner checklist

Everything below is yours — no agent session touches a real server, pastes a secret, or creates
a GitHub environment. Do these **in order**; each step assumes the previous ones are done. Where
a dev-runbook step already exists almost verbatim, it's marked **[dev-style]** — same shape as
`docs/deploy.md`, just against the new VPS/zone. **No secret value is ever typed into a chat,
prompt, terminal echo, or pasted by hand between files** — every secret is generated with
`openssl` straight into a file and moved between machines as a file (`scp`), per steps 10/12.

**Status as of 2026-10-17:** steps 1, 3, 4, 6, 7, 8, 9 done; step 5 partially done (cert/key
uploaded, toggle still OFF). **Remaining:** DNS A records (step 2), the AOP toggle (step 5), env
files (step 10), GitHub environment (step 11), and everything from step 12 onward.

1. **Buy the VPS.** ✅ **Done.** Sumopod, Jakarta region, **IP `43.173.52.121`**, Ubuntu 24.04,
   `x86_64` confirmed, **2 vCPU / 3.6 GiB RAM / 60 GB SSD** (the actual provisioned specs —
   `free -h`/`df -h` on the box, not the original 4 GB/80 GB planning estimate; §1's memory
   budget and §2's VPS row are both updated to match).
2. **DNS.** *Remaining.* Cloudflare dashboard → the `ammari.id` zone (add it to Cloudflare first
   if it isn't there yet) → add **A** records for `ammari.id`, `www.ammari.id`,
   `admin.ammari.id` pointing at `43.173.52.121`, **proxied** (orange cloud). `www` still needs
   its own DNS record even though it will only ever 301-redirect — Cloudflare/Caddy still need to
   receive that request to issue the redirect.
3. **SSH + VPS one-time setup.** ✅ **Done** (with extra hardening beyond the original
   **[dev-style]** steps below — recorded as actually performed):
   - Docker + the `docker compose` plugin confirmed installed and working.
   - Docker log limits applied.
   - `ufw` allows only 22/80/443 and is enabled.
   - `deploy` user created, in the `docker` group.
   - `/opt/ammari-prod/{env,caddy/certs,cloudflare,backup}` created, owned by `deploy`.
   - Prod-only deploy SSH key installed for `deploy` (for GitHub Actions' use, step 11).
   - A **separate** admin SSH key installed for `ubuntu` (interactive/admin access, kept
     distinct from the deploy-automation key above — not in the original plan text, added as
     extra hardening).
   - Password authentication and root SSH login both disabled (extra hardening beyond the
     original plan text).
   - *Still remaining from this step:* the GitHub PAT / `docker login ghcr.io` on the VPS as
     `deploy` (needed before the first real image pull, step 14) — do this once GitHub
     environment secrets (step 11) are set up, no need to do it in isolation now.
4. **Cloudflare — TLS mode.** ✅ **Done.** `ammari.id` zone → **SSL/TLS → Overview** → set to
   **Full (strict)**.
5. **Cloudflare — zone-level Authenticated Origin Pulls (the part that differs from dev).**
   ⚠️ **Partially done:** the leaf certificate + private key are generated and uploaded to the
   zone-level AOP slot, and the CA root is already placed on the VPS at
   `/opt/ammari-prod/cloudflare/origin-pull-ca.pem`. **The AOP toggle itself is still OFF** —
   flipping it on is in the *Remaining* list below, deliberately left for later (enabling it
   before the prod Caddyfile/`trust_pool` exists, Session 2, would just make the origin
   unreachable with no app behind it to notice). Steps already done, for reference:
   - On your own machine (not the VPS), generate a CA, then a **leaf** certificate signed by it
     (note `basicConstraints=CA:FALSE` on the leaf — it must not itself be usable as a CA):
     ```bash
     openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
       -keyout ammari-prod-aop-ca.key -out ammari-prod-aop-ca.pem \
       -subj "/CN=Ammari Prod AOP CA"
     openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr \
       -subj "/CN=ammari-prod-origin-pull"
     openssl x509 -req -in client.csr -CA ammari-prod-aop-ca.pem -CAkey ammari-prod-aop-ca.key \
       -CAcreateserial -days 825 -out client.pem \
       -extfile <(printf "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n")
     ```
     (825 days, not 3650, for the leaf: that's the longest validity public CAs/browsers still
     widely tolerate, and more importantly Cloudflare will email expiry reminders against it —
     good practice to keep this one renewable rather than "set once for 10 years and forget."
     The CA root itself can stay long-lived.)
   - `ammari.id` zone → **SSL/TLS → Origin Server → Authenticated Origin Pulls → Zone-level**
     (not Global, not Per-hostname) → upload **both `client.pem` and `client.key`** — Cloudflare
     needs the private key too, since it's the one presenting this exact cert+key pair on every
     origin pull, not just validating someone else's — then enable the toggle.
   - Put `ammari-prod-aop-ca.pem` (the CA **root**, not the leaf) on the VPS at
     `/opt/ammari-prod/cloudflare/origin-pull-ca.pem` — this is what the prod Caddyfile's
     `trust_pool` reads (different file from dev's, which reads Cloudflare's own published
     Global CA). Caddy trusts the CA, not the specific leaf, so renewing the leaf later never
     requires a Caddy config change.
   - Keep `ammari-prod-aop-ca.key` (the CA private key) and a copy of `client.key` in
     `~/ammari-secrets` (`chmod 600`) **and** in a password manager — do not delete either from
     your machine the way dev's one-off cert flow could; you'll need the CA key again to reissue
     a leaf before the 825-day expiry, and Cloudflare's own dashboard will email expiry
     reminders to the account's registered contacts ahead of that date. **Renewal:** re-run the
     `openssl x509 -req ...` leaf-issuance command above (new leaf, same CA), re-upload the new
     `client.pem`/`client.key` pair to the same Zone-level AOP slot (overwrites the old pair), no
     DNS/Caddy change needed.
   - Verification (unchanged from dev's approach): a direct `curl --resolve ...` to the VPS IP,
     bypassing Cloudflare, must still fail with a TLS `certificate_required` error — see §7's
     go-live checklist.
6. **Cloudflare — origin certificate.** ✅ **Done.** **[dev-style]**: **SSL/TLS → Origin Server
   → Create Certificate**, hostnames `ammari.id`, `www.ammari.id`, `admin.ammari.id` → both files
   placed at `/opt/ammari-prod/caddy/certs/origin.pem` / `origin.key` (`chmod 600` the key).
   (This is a different certificate from step 5's AOP leaf — this one is what Caddy presents *to*
   Cloudflare as the server's own TLS identity; step 5's pair is what Cloudflare presents *to*
   Caddy to prove the request really came from Cloudflare. Two unrelated cert pairs, both
   required, easy to conflate.)
7. **Object storage — one prod bucket.** ✅ **Done.** On Cloudeka: bucket **`ammariprod-cdy2yf`**,
   endpoint `https://kencana.basic.box.cloudeka.id`, region `kencana` (same Cloudeka setup as
   dev). **Revised from this plan's original two-bucket design** — there is **no** separate
   backup bucket/access key for now (see the "Later" list at the end of this plan for the
   reasoning and the planned upgrade). Layout within this one bucket:
   - `products/*`, `content/*`, `healthcheck/*` — public-read (unchanged from the original
     design), policy already applied via `packages/storage/bucket-policy.prod.json` (Session 7's
     bucket-name fill was pulled forward and done today).
   - `backups/*` — **private**, no matching statement in the bucket policy. Accepted risk: a
     mistake in the bucket policy wouldn't expose readable backup *content* even if it exposed
     the prefix, because backups are encrypted client-side (AES-256) before upload — but the
     prefix must still be verified private (an explicit `backups/` → 403 check is in §7's
     go-live checklist, Session 5's verification, and Session 7's runbook).
   - The app's own S3 access key (already in `admin.env`, step 10) is reused for backup uploads
     too — one key, not two. See the "Later" list for when this should become two separate keys.
8. **Resend.** ✅ **Done.** A prod API key named **"ammari-prod"** was created, with **Sending
   access restricted to the `mail.ammari.id` domain**, and saved on the owner's Mac (not in this
   repo). Still needed later: copy its value into `prod-admin.env`/`prod-web.env` at step 10.
9. **Google OAuth.** ✅ **Done, nothing to change.** The single OAuth client **"Ammari"**
   already lists both `https://ammari.id/api/auth/callback/google` and
   `https://admin.ammari.id/api/auth/callback/google` as **Authorized redirect URIs**, and the
   **consent screen** is already **"In production."** No **Authorized JavaScript origins** are
   needed — this is a server-side OAuth flow, so the client has none listed and none to add.
10. **Build the secrets files, on your Mac, never displayed or typed by hand.** *Remaining.*
    `deploy-prod/make-prod-env.sh` does this: builds `~/ammari-secrets/prod-admin.env`,
    `prod-web.env`, `prod-db.env` and `prod-backup.env` from `deploy-prod/env/*.example`,
    generating fresh secrets with `openssl rand` (both `BETTER_AUTH` secrets, `REVALIDATE_SECRET`
    and `PREVIEW_SECRET` — each shared identically between `prod-admin.env`/`prod-web.env` —
    the Postgres password written consistently into `prod-db.env` and into `DATABASE_URL` in
    both app files, and `PG_BACKUP_ENCRYPTION_KEY`), and filling every non-secret value from
    this plan (`https://ammari.id`/`https://admin.ammari.id`, `DEPLOY_ENV=production`,
    `STOREFRONT_CART_ENABLED=false`, the `ammariprod-cdy2yf`/`kencana` bucket settings, the
    alert-recipient addresses). It reads the already-provisioned prod Resend key from
    `~/ammari-secrets/prod-resend-api-key` (step 8), and reuses the Google OAuth client id/
    secret and S3 access key/secret from `~/ammari-secrets/dev-admin.env` when the variable
    names exist there (same Google client, same Cloudeka account — step 9, step 7), asking for
    anything it can't find with a hidden prompt instead. It never prints a secret to the
    terminal, never writes one into this repo, and refuses to overwrite an existing
    `~/ammari-secrets/prod-*.env` unless you pass `--force` (which backs the old file up with a
    timestamp first):
    ```bash
    deploy-prod/make-prod-env.sh
    ```
    It ends with a validation pass that prints only key names — which are set, still empty, or
    still a placeholder — and confirms (by hash, never by value) that `REVALIDATE_SECRET` and
    `PREVIEW_SECRET` actually match between `prod-admin.env` and `prod-web.env`. A few values it
    deliberately leaves empty for you to fill by hand afterward (not generated or confirmed by
    the plan's own text): `EMAIL_FROM` and `STORAGE_PUBLIC_BASE_URL` in both app files, and
    `STORE_WHATSAPP_NUMBER` in `prod-web.env` (optional fallback only — see step 19). **Never**
    add `NODE_ENV` or `E2E_TEST_LOGIN` to any of these files — the script never does either.
11. **GitHub repo settings.** *Remaining.*
    - **Settings → Actions → General → Workflow permissions** → "Read and write permissions"
      (should already be set from dev's setup; confirm it still is).
    - **Settings → Environments → New environment**, name it exactly `production`.
      - **Deployment branches and tags** → **Selected branches and tags** → add `main`. This is
        the actual protection on this environment (required reviewers aren't offered on a
        private repo — see §8 item 3): a `workflow_dispatch` run can only use this environment's
        secrets when it's dispatched against the `main` ref.
      - **Environment secrets** on `production`: `DEPLOY_SSH_HOST` (new VPS IP),
        `DEPLOY_SSH_USER` (`deploy`), `DEPLOY_SSH_KEY` (the **prod** private key from step 3),
        `DEPLOY_SSH_KNOWN_HOSTS` (step 3's `ssh-keyscan` output).
12. **Copy the secrets files onto the VPS, then fill in the real env files.** *Remaining.*
    `deploy-prod/upload-prod-env.sh` does this: `scp`s all four files from `~/ammari-secrets`
    (`prod-admin.env`, `prod-web.env`, `prod-db.env`, `prod-backup.env`) to
    `deploy@43.173.52.121:/opt/ammari-prod/env/` as `admin.env`/`web.env`/`db.env`/`backup.env`
    using `~/ammari-secrets/ammari_prod_deploy_key`, then `chmod 600`s them remotely. It prints
    only file names and permissions, never a file's contents:
    ```bash
    deploy-prod/upload-prod-env.sh
    ```
    These four files are now complete (step 10 already filled in every value, secret and
    non-secret) — nothing left to edit on the VPS itself. If a non-secret value ever needs to
    change later (a URL, a flag), edit the copy in `~/ammari-secrets` and re-run this script,
    rather than editing a file directly on the VPS, so `~/ammari-secrets` stays the one source
    of truth. (`prod-db.env`/`db.env` holds `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` for
    the self-hosted `db` service, `deploy-prod/docker-compose.yml`'s own `env_file: ./env/db.env`
    — easy to forget since it's the one file step 10/12 didn't originally call out by name.)
13. **Promote `dev` into `main`.** `main` already exists in this repo (confirmed:
    `git branch -a` shows both local and `origin/main`) — if it ever doesn't,
    `git checkout -b main dev && git push -u origin main` first. Otherwise, fast-forward it to
    match `dev`:
    ```bash
    git fetch origin
    git checkout dev && git pull --ff-only origin dev
    git checkout main
    git merge --ff-only dev
    git push origin main
    ```
    `--ff-only` is deliberate: it refuses (rather than creating a merge commit) if `main` has
    diverged from `dev` for any reason, which shouldn't happen given `CLAUDE.md`'s "all work
    happens on `dev`" rule. **Note:** `CLAUDE.md` also says `main` is "protected on GitHub: no
    direct pushes" — if that protection rule is configured to reject even a clean fast-forward
    push (as opposed to only rejecting force-pushes or non-fast-forward pushes), the
    `git push origin main` above will be rejected; in that case use
    `gh pr create --base main --head dev` and merge it with **"Rebase and merge"** (not a merge
    commit) to keep the same linear fast-forward-equivalent history, then proceed.
14. **First deploy.** **Actions → Deploy (prod) → Run workflow** → branch dropdown ("Use workflow
    from") set to **`main`** (the workflow refuses to run against anything else — Session 4's
    guard) → leave **`sha`** empty (deploys `main`'s current HEAD) → leave **`skip_migrate`**
    unchecked (that input is rollback-only — see the Rollback plan, §7) → **Run workflow**. Watch
    the run; its job summary reports the deployed sha, which images were built vs. reused from
    GHCR, each app's active slot after the run, and whether migrations ran.
15. **Bootstrap the first `super_admin`.** **[dev-style]**, against the prod migrator image —
    same `docker run --rm --env-file /opt/ammari-prod/env/admin.env ... tsx src/seed.ts` command
    as `docs/deploy.md` §7, with `SEED_SUPER_ADMIN_EMAIL`/`SEED_SUPER_ADMIN_NAME` set to you.
16. **Apply the prod bucket policy.** `pnpm --filter @ammari/storage policy:apply -- --env prod
    --dry-run` first, then without `--dry-run` (the bucket name is already filled in
    `bucket-policy.prod.json`, step 7). After it applies, confirm an anonymous `curl` to an
    object under `backups/` in `ammariprod-cdy2yf` returns **403** — the policy must never grant
    that prefix public read, since it shares the bucket with `products/*`/`content/*`.
17. **Set up the nightly backup timer and monitoring timers** (Sessions 5–6's systemd units) —
    `systemctl enable --now pg-backup.timer disk-alert.timer backup-check.timer`.
18. **Set up UptimeRobot (free tier).**
    - Sign up at uptimerobot.com (free plan is enough — up to 50 monitors, 5-minute interval).
    - **Add New Monitor** → Monitor Type: **HTTP(s)** → Friendly Name "Ammari web health" →
      URL `https://ammari.id/api/health` → Monitoring Interval: **5 minutes**. This endpoint
      (`apps/web/src/app/api/health/route.ts`) is deliberately unauthenticated and checks real DB
      connectivity, returning HTTP 503 on failure — a better signal than just checking the
      homepage loads.
    - Repeat for **admin**: Friendly Name "Ammari admin health" → URL
      `https://admin.ammari.id/api/health` → same 5-minute interval.
    - Optionally add two more plain HTTP(s) monitors on the bare `https://ammari.id` and
      `https://admin.ammari.id` root URLs, to also catch a failure in front of the app (Cloudflare
      or Caddy) that `/api/health` itself wouldn't see if the app never got the request at all.
    - **Alert Contacts** → confirm your email is added as a contact (UptimeRobot adds your
      signup email by default) → on each of the monitors above, under **Alert Contacts To
      Notify**, make sure that email contact is checked.
19. **Products/content.** Log into `https://admin.ammari.id` with the account from step 15 and
    enter real products, fabrics, and homepage content through the admin UI (see §5 — no import
    script is used for this first batch). Also set `store_settings.whatsapp_number` (Content →
    Settings) — this is what the storefront actually reads (§3 Session 8).
20. **Run the restore drill for real, once, against prod's first real backup** (not just the
    disposable-DB drill from Session 5) — confirms the whole chain works end to end before you
    need it under pressure. You'll need `PG_BACKUP_ENCRYPTION_KEY` from step 10's
    `~/ammari-secrets/prod-backup.env` (or your password manager) to decrypt it.

---

## 5. Data plan

- Prod starts from an **empty** database. The migrator image runs every migration in order
  (same mechanism as dev — `packages/db/src/migrate.ts`, aborts the deploy on failure) and
  nothing else. No dev data, no `pnpm db:seed` dev/demo fixtures.
- Reference data that application code depends on (permission keys, channel ids, etc.) already
  ships inside migrations per `CLAUDE.md`'s database rules, so it exists correctly on prod the
  moment migrations finish — no separate step needed.
- **First `super_admin`:** exactly the existing `packages/db/src/seed.ts` bootstrap
  (`SEED_SUPER_ADMIN_EMAIL`/`NAME`), run once by hand (§4 step 15), never automated. It is an
  insert-only, `ON CONFLICT DO NOTHING` operation — safe to re-run, but it won't fix a wrong
  value if the email was already seeded once; use the admin UI's `/roles-staff` to correct a
  role/name after the fact, same caveat as dev's runbook.
- **Products / content:** entered by hand through the admin UI once the owner is logged in
  (§4 step 19). No Shopee/TikTok import is relevant yet (that import path is for *orders*, which
  don't exist before checkout ships) — this is first-time catalog entry, not a migration.

---

## 6. Backup/restore and monitoring minimum

- **Backup:** nightly `pg_dump --format=custom` → `openssl enc -aes-256-cbc -pbkdf2` with the key
  from `/opt/ammari-prod/env/backup.env` (`PG_BACKUP_ENCRYPTION_KEY`) → upload to the **same**
  prod bucket's private `backups/` prefix (§4 step 7 — `ammariprod-cdy2yf`, **not** a separate
  bucket — this plan's original two-bucket design was revised down, see the "Later" list)
  using the app's own S3 access key (already in `admin.env`) via the same path-style S3 approach
  `packages/storage` already uses for Cloudeka. The `backups/` prefix has no matching statement
  in `bucket-policy.prod.json`, so it stays private by default (S3's default-deny); since
  backups are also encrypted client-side before upload, a policy mistake on this prefix would
  expose ciphertext, not readable data — still, an explicit `backups/` → 403 check is required
  (§4 step 16, §7's go-live checklist) rather than relying on that encryption alone.
  **Retention (confirmed): keep the last 14 daily + last 8 weekly** backups under `backups/`,
  pruning anything remote older than that on each run — the prune logic must only ever touch
  keys under `backups/`, never `products/*`/`content/*` in the same bucket. Never deletes a
  *local* dump — the script writes to a temp path and removes it after a successful upload either
  way, success or failure, so a failed upload never leaves an unencrypted dump sitting on disk.
  **The encryption key itself must be stored off-server too** — a copy in `~/ammari-secrets` on
  the owner's Mac and in a password manager, generated at the same time as the key (§4 step 10).
  If this key is ever lost, every backup encrypted with it becomes permanently unreadable —
  there is no recovery path, so treat losing it as equivalent to having no backups at all.
- **Restore drill:** documented in `docs/runbooks/restore-drill.md` (Session 5), exercised once
  against a disposable local Postgres container before go-live, and once for real against the
  first real prod backup (§4 step 20). Steps: download the latest backup object, decrypt with the
  same key, `pg_restore` into a throwaway `ammari_scratch`-style database (never the real `ammari`
  db, per `CLAUDE.md`'s local-safety rule), spot-check row counts against what prod currently
  reports.
- **Monitoring minimum (three checks, Session 6), all alerting by email via the prod Resend key
  to `ammariofc@gmail.com` and the owner's own address:**
  1. **Uptime (confirmed): UptimeRobot, free tier.** HTTP(s) monitors on `/api/health` for both
     `https://ammari.id` and `https://admin.ammari.id`, 5-minute interval, email alerts (its own
     alert contact, separate from the Resend-based alerts below) — see §4 step 18 for exact
     setup. A SaaS free tier over self-hosting one more service on a 3.6 GiB box.
  2. **Disk alert** — VPS-local timer, alerts past ~80% disk used (the exact threshold most
     likely to matter here: Docker image/layer growth plus Postgres data growth over months).
  3. **Backup success** — VPS-local timer, alerts if **either** the newest object under the
     prod bucket's `backups/` prefix is older than ~26 hours (gives a bit of slack over the 24h
     cadence before paging anyone) **or no backup object exists at all** — the latter catches a
     brand-new install whose backup timer never successfully ran even once, which a pure
     "staleness" check alone would never flag (there's nothing to compare against yet).

---

## 7. Go-live checklist and rollback plan

### Pre-submission content checklist (payment gateway verification)

Confirmed gateway requirements, at submission time (not necessarily by 25 Oct — the deploy just
needs to be ready for whenever submission happens): the pages below must be live and contain
real content. All of them already exist in code and are editable through the admin — **writing
the actual content is the owner's job, not an agent task**; this checklist is only here so
nothing gets submitted half-filled.

- [ ] At least some real products are published, each with a real price (not a placeholder) —
      edited in admin's Products section.
- [ ] `https://ammari.id/terms-of-service` has real Terms of Service content (admin: Content →
      Info Pages, per `apps/admin/src/lib/content/info-pages.ts`).
- [ ] `https://ammari.id/privacy-policy` has a real Privacy Policy.
- [ ] `https://ammari.id/returns-exchange` has a real returns/refund/exchange policy.
- [ ] Store settings (admin: Content → Settings, `/content/settings`,
      `apps/admin/src/lib/content/store-settings.ts`) has real values for: WhatsApp number,
      support email, and business address — these are what make contact info visible on the
      storefront. `returnPolicySummary` in that same settings row should also be filled in if the
      gateway's reviewer expects a short policy snippet outside the full
      `/returns-exchange` page.
- [ ] Spot-check as a visitor (not logged into admin) that all of the above actually renders on
      the public site — a value saved in admin but not wired into the page it's meant to appear
      on would otherwise pass review by accident only.

### Go-live checklist (run through this for real, Session 8)

- [ ] `https://ammari.id` and `https://admin.ammari.id` load over HTTPS, Cloudflare Full-strict.
- [ ] `https://www.ammari.id` returns a 301 to `https://ammari.id` (not a duplicate render of the
      same content under two hostnames).
- [ ] Direct `curl --resolve ...` to the VPS IP, bypassing Cloudflare, **fails** with a TLS
      `certificate_required` error (same proof dev's runbook already performs) — confirms the
      zone-level AOP cert boundary actually holds, not just Global's.
- [ ] `/robots.txt` on `ammari.id` shows `allow: /` (confirms `DEPLOY_ENV=production` actually
      took effect at runtime, not just in the env file).
- [ ] `/api/test/*` returns 404 on both hosts at the Caddy layer (confirms the block is live even
      though the code-level gate should already be closed in a real env file).
- [ ] The PDP's primary CTA is "Tanya via WhatsApp," not "Tambah ke keranjang" (confirms
      `STOREFRONT_CART_ENABLED=false` really is what's live), and the WhatsApp number it links to
      matches what was entered in `store_settings` (§4 step 19), not a stale fallback.
- [ ] Voucher claim flow and customer OTP login both work end-to-end against the real prod email
      sender (Resend prod key) — send yourself one real OTP.
- [ ] Staff OTP + Google login both work against `admin.ammari.id`; the seeded `super_admin`
      account can reach `/roles-staff`.
- [ ] A product image renders (confirms the prod bucket policy on `ammariprod-cdy2yf` is
      actually applied — an `AccessDenied` here means the policy never got applied for real).
- [ ] An anonymous `curl` to an object under `ammariprod-cdy2yf`'s `backups/` prefix returns
      **403** — confirms the private prefix stays private even though it shares a bucket with
      the public `products/*`/`content/*` prefixes (not a separate bucket, see §4 step 7).
- [ ] The nightly backup timer has produced at least one real object under that `backups/`
      prefix.
- [ ] The uptime check is actually registered and green; a manually-triggered disk/backup alert
      email actually arrived at both recipient addresses.

### Rollback plan

- **App-layer rollback** (bad admin/web release): `workflow_dispatch` on `deploy-prod.yml` with
  an older `sha` — same shape as dev's rollback, skips `build`/`retag`, redeploys the
  already-pushed images under that SHA via the blue-green script, **never re-runs the migrator**.
  This is exactly why every migration must stay backward-compatible with the previously-deployed
  release (`CLAUDE.md`'s existing rule) — it's now load-bearing for prod's own DB too, not just a
  managed provider's.
- **DB-layer disaster recovery** (data corruption, bad manual change, etc. — rare, not a normal
  deploy rollback): stop the app containers, restore the most recent good backup into the `db`
  container's volume (or a fresh volume) per `docs/runbooks/restore-drill.md`, confirm row counts,
  restart. This is a manual, deliberate, owner-run procedure — never scripted into the deploy
  pipeline itself, same spirit as `CLAUDE.md`'s "never wipe local data without asking" rule
  applied to prod: nothing here ever runs automatically against the real prod volume.

---

## 8. Open questions — resolved

1. **Backup retention window:** confirmed — 14 daily + 8 weekly (§6, Session 5's prune logic).
2. **Uptime monitor:** confirmed — UptimeRobot free tier, 5-minute HTTP(s) checks against
   `/api/health` on both `ammari.id` and `admin.ammari.id`, email alerts (§4 step 18, §6).
3. **GitHub `production` environment reviewers:** **not applicable — GitHub's required-reviewer
   deployment-protection rule is only offered for public repositories** on Free/Pro/Team, and this
   repo is private, so there is no reviewer gate to configure at all (confirmed against GitHub's
   own docs). The design changed instead: `deploy-prod.yml` is `workflow_dispatch`-only (no
   `push` trigger), and the `production` environment is scoped to `main` via a deployment branch
   rule — see §4 step 11, Session 4. This still satisfies "a deliberate action," just via "no
   automatic trigger exists" rather than an approval click.
4. **Payment gateway's verification requirements:** confirmed, at submission time (not
   necessarily by 25 Oct) — published products with real prices, `/terms-of-service`,
   `/privacy-policy`, `/returns-exchange`, and visible contact info from store settings (phone,
   email, address). All pages already exist and are edited in admin; see the "Pre-submission
   content checklist" at the top of §7 — writing the real content is the owner's job, not an
   agent task.
5. **VPS provider:** confirmed and **provisioned** — Sumopod, Jakarta region (same provider as
   dev), IP `43.173.52.121`, 2 vCPU / **3.6 GiB RAM / 60 GB SSD** (actual specs confirmed via
   `free -h`/`df -h` on the box — revised down from this plan's original 4 GB/80 GB planning
   estimate; see §1's memory budget and §4 step 1).

No open questions remain blocking this plan.

---

## 9. Later (deliberately deferred, not blocking this launch)

- **Separate, private backup bucket with its own access key.** This plan originally called for
  a dedicated backup bucket distinct from the product-image bucket, each with its own S3
  credentials, so that a compromised VPS (which only ever holds one write-capable key) couldn't
  also read or delete backups. The actual prod setup (§4 step 7) instead keeps backups under a
  private `backups/` prefix in the **same** bucket as `products/*`/`content/*`, using the app's
  **same** S3 access key. Accepted risk for this early, pre-revenue launch: backups are encrypted
  client-side (AES-256) before upload, so even a full compromise of that one key only yields
  ciphertext, not readable backup content — and the key never gets delete/read-back scope
  beyond what the app itself already needs. Revisit once revenue justifies the operational cost
  of a second bucket + key (and, ideally, a write-only-scoped key for it, as this plan's original
  §4 step 7 text proposed) — a real improvement, not a correctness requirement for launch.
