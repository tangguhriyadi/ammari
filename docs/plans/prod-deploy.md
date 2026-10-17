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

- Separate prod VPS: **Sumopod, Jakarta region (same provider as dev), 2 vCPU / 4 GB RAM.** SSH
  key only, `ufw` 22/80/443, `deploy` user, Docker log limits (already the pattern in
  `deploy/docker-compose.yml`'s `x-logging`).
- Postgres 16 + pgvector as a **container** on the prod VPS, not exposed publicly. Nightly
  encrypted `pg_dump` to Cloudeka S3 with retention, plus a documented restore drill.
- Cloudflare in front of `ammari.id`, **Full (strict)** + Authenticated Origin Pulls using a
  **custom per-zone certificate** (dev uses the Global toggle; prod must not depend on it).
- Separate prod storage bucket, same public-read policy pattern (`products/*`, `content/*`),
  applied with the existing `policy:apply --env prod` script.
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
┌───────────────────────────── Prod VPS (Jakarta, 2 vCPU / 4 GB, ufw 22/80/443) ───────────────┐
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
│  nightly systemd timer: pg_dump → openssl encrypt → upload to a SEPARATE, private Cloudeka    │
│  S3 backup bucket (its own access key — never the product-image bucket's)                    │
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

**Memory budget:** 4 GB total. Steady state (one slot per app + db + caddy) is comfortably under
1 GB. The pressure point is the brief window during a blue-green switch where **both** slots of
an app can be running — worst case, both admin's and web's slots flip in the same deploy (e.g. a
`packages/` change that affects both), meaning 4 Next containers + db + caddy at once:
4×450MB + 768MB + 128MB ≈ **3.2 GB**, which is why the caps above exist and why Session 3
includes an actual measurement, not just this estimate — see Session 3 and §4.

---

## 2. Differences from dev

| Aspect | Dev (current) | Prod (this plan) |
|---|---|---|
| VPS | Shared, 43.129.55.61 | Separate VPS, **Sumopod, Jakarta region** (same provider as dev), 2 vCPU/4GB, **80 GB SSD** (OS + 3 images × last-5-SHA retention + Postgres data + short-lived backup staging, with headroom — see §6; 60 GB would work but 80 GB costs little more and avoids a disk-pressure page at 2am) |
| Database | Managed Sumopod Postgres 16, direct port, `sslmode=disable` | **Self-hosted** `pgvector/pgvector:pg16` container on the VPS, named volume, not exposed; `sslmode` moot (same-host, over the Docker bridge); modest `mem_limit`/`shared_buffers` tuning (§1, Session 1) |
| Deploy trigger | Push to `dev` → auto-deploy | **`workflow_dispatch` only** (`sha` input, empty = current `main` HEAD) — **no `push` trigger at all**. Required-reviewer approval isn't available on a private repo (§8 item 3), so "no automatic trigger exists" is the deliberate-action gate, not an approval click |
| App container swap | `docker compose up -d` (brief downtime while the container restarts) | **Blue-green**: new slot started + health-checked while the old slot still serves traffic, then Caddy's upstream flips, then the old slot stops. Both apps' slots can flip in the same run only if memory allows (§1, §4 step — Session 3's dry run); falls back to flipping admin then web sequentially otherwise |
| Cloudflare AOP | Global toggle (shared Cloudflare cert, no upload) | **Zone-level**: a leaf certificate **and its private key** we generate and upload to Cloudflare for this zone only; our CA's root key never leaves the owner's machine/password manager and only the root cert sits on the VPS — Caddy's `trust_pool` points at **our own CA**, not Cloudflare's published Global CA |
| www handling | `ammari.my.id` and `www.ammari.my.id` both served directly | `www.ammari.id` **301-redirects** to `https://ammari.id` — the apex is canonical |
| Image tags | `:<sha>`, `:dev-latest` | Same images, reused as-is (environment-agnostic by design — see `apps/admin/Dockerfile`'s comment on build-time placeholders), additionally tagged `:prod-latest` |
| Backups | None (managed provider's own responsibility) | Nightly encrypted `pg_dump` → a **separate, private** Cloudeka S3 bucket with its own access key, documented restore drill |
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
  for a 4 GB box with a small catalog). Update `docs/SPEC.md` §2.4 per the note above.
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
  5. For each of admin/web whose image actually changed this deploy: start the **inactive**
     slot's container on the new image tag; health-check it directly (not yet through Caddy).
  6. Regenerate a small generated Caddy snippet (`deploy-prod/caddy/active-upstream.caddy`)
     pointing `reverse_proxy` at the now-active slot's container names, then `caddy reload`
     (same no-downtime reload dev already uses for config changes).
  7. Re-verify health **through Caddy** (end-to-end, not just the container).
  8. Stop (not remove) the old slot's containers; update the per-app `active-slot-*` file.
  9. Reuse dev's image-retention logic (keep current + previous 4 deployed SHAs; never touch
     `caddy`/`db` images or any volume).
- **Memory check (required before this ships):** run a dry deploy locally (or on the VPS before
  the first real cutover) that forces **both** admin and web to flip in the same run — the
  worst case — and measure actual peak RSS across all containers (`docker stats --no-stream`
  polled during the overlap window). If peak stays under ~3.2 GB (§1's budget), simultaneous
  flips are fine and this is the default. **If it doesn't fit**, change step 5 above to flip
  admin's slot fully (start → health-check → Caddy flip → stop old) before starting web's flip,
  so at most one app ever has two slots running at once — document whichever behavior the
  measurement justified directly in the script's own comment, not just in this plan.
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
- **Scope:** mirror `.github/workflows/deploy-dev.yml`'s `plan`/`build`/`retag`/`deploy`
  structure, parameterized for the `production` environment + `prod-latest` tag — but **trigger
  on `workflow_dispatch` only**, no `push` trigger of any kind. Inputs: `sha` (optional — empty
  means "build and deploy whatever `main` currently points at," identical semantics to dev's own
  empty-input case, since `github.sha` already resolves to the dispatched ref's HEAD; a non-empty
  value is a rollback to that exact SHA, same as dev). Running this workflow always means
  explicitly selecting `main` as the ref to dispatch against in the Actions UI — there's no
  branch picker ambiguity to get wrong since no other trigger exists. The `deploy` job keeps
  `environment: production` for its **secrets** (and so the environment's deployment branch
  rule, set up in §4 step 11, actually applies to it) — not for a reviewer gate, which GitHub
  doesn't offer on a private repo (§8 item 3).
- **Files:** `.github/workflows/deploy-prod.yml`.
- **Verification:** `act`/dry inspection of the YAML (no real GHCR push in this session — no
  secrets exist yet); confirm the SHA-regex injection guard from dev's workflow is carried over
  unchanged (same security-reviewer finding applies here); confirm there is no `on: push:` key
  anywhere in the file.
- **Rollback:** delete the workflow file; nothing has deployed yet at this point.

### Session 5 — Backup + restore drill
- **Scope:** `deploy-prod/backup/pg-backup.sh` (`pg_dump` → `openssl enc` with a key read from
  `deploy-prod/env/backup.env` → `aws s3 cp` to the **dedicated, private** Cloudeka backup bucket
  — see §4 step 7 — using the same path-style S3 client approach
  `packages/storage/src/s3-client.ts` already documents for Cloudeka). Retention (confirmed):
  delete remote objects older than the 14-daily + 8-weekly window. A systemd timer unit (not
  cron — easier to see failures with `systemctl status`) to run it nightly.
  `docs/runbooks/restore-drill.md`: step-by-step for restoring a backup into a **disposable**
  local Postgres container (never the real `ammari` db, per `CLAUDE.md`'s local-safety rule) and
  verifying row counts/an app smoke test against it.
- **Files:** `deploy-prod/backup/pg-backup.sh`, `deploy-prod/backup/pg-backup.service`,
  `deploy-prod/backup/pg-backup.timer`, `deploy-prod/env/backup.env.example`,
  `docs/runbooks/restore-drill.md`.
- **Verification:** run the restore drill for real, once, against a local disposable DB seeded
  with throwaway data — prove the whole chain (dump → encrypt → upload → download → decrypt →
  restore) actually works before the owner ever needs it under pressure.
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
  that alerts if **either** the newest object in the backup bucket is older than ~26h **or no
  backup object exists at all yet** (so a brand-new install with zero backups ever run pages
  someone immediately, instead of silently waiting for a "staleness" condition that can never
  trigger when there's nothing to compare against).
- **Files:** `deploy-prod/monitoring/disk-alert.sh` + its timer unit,
  `deploy-prod/monitoring/backup-check.sh` + its timer unit, a short section in
  `docs/deploy-prod.md`.
- **Verification:** trigger each alert condition manually once (fill the disk with a dummy file
  under a throwaway path, or point the backup check at an empty/missing bucket prefix) to confirm
  the alert actually fires and the email actually arrives, then clean up the manual trigger.
- **Rollback:** scripts/timers only.

### Session 7 — Prod bucket policy + runbook (`docs/deploy-prod.md`)
- **Scope:** fill `packages/storage/bucket-policy.prod.json`'s `REPLACE_WITH_PROD_BUCKET_NAME`
  once the owner has created the real **product-image** bucket (§4 step 7 — not the backup
  bucket, which stays private with no policy at all) and write `docs/deploy-prod.md` — a full
  runbook mirroring `docs/deploy.md`'s shape (facts this runbook assumes → one-time VPS setup →
  Cloudflare → GitHub settings → env files → first deploy → bootstrap → bucket policy → image
  tagging → rollback → retention → troubleshooting), but for prod's specifics (self-hosted DB,
  blue-green, zone-level AOP, backups, workflow_dispatch-only trigger).
- **Files:** `packages/storage/bucket-policy.prod.json`, `docs/deploy-prod.md`.
- **Verification:** `pnpm --filter @ammari/storage policy:apply -- --env prod --dry-run` once
  real bucket credentials exist (owner runs this; agent can review the dry-run JSON output).
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

1. **Buy the VPS.** Sumopod, Jakarta region (same provider as dev's managed Postgres — but this
   time you're provisioning a **VPS/compute** instance, not their managed Postgres product),
   2 vCPU / 4 GB RAM, 80 GB SSD, Ubuntu 24.04, `x86_64` (confirm with `uname -m` once it's up —
   the build pipeline targets `linux/amd64`; if you ever get handed an `aarch64` box, stop and
   flag it, same caveat as dev). Note the IP.
2. **DNS.** Cloudflare dashboard → the `ammari.id` zone (add it to Cloudflare first if it isn't
   there yet) → add **A** records for `ammari.id`, `www.ammari.id`, `admin.ammari.id` pointing at
   the new VPS IP, **proxied** (orange cloud). `www` still needs its own DNS record even though
   it will only ever 301-redirect — Cloudflare/Caddy still need to receive that request to issue
   the redirect.
3. **SSH + VPS one-time setup.** **[dev-style]**, against the new VPS:
   - Confirm `docker compose version` works.
   - `sudo adduser --disabled-password --gecos "" deploy && sudo usermod -aG docker deploy`.
   - Generate a **new, prod-only** SSH keypair on your own machine (never reuse dev's key):
     `ssh-keygen -t ed25519 -C "github-actions-deploy-prod@ammari" -f ammari_prod_deploy_key -N ""`.
     Put the public half in `/home/deploy/.ssh/authorized_keys` on the new VPS.
   - `ssh-keyscan -t ed25519 <new-vps-ip>` — save the output for step 11.
   - `sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable`.
   - `sudo mkdir -p /opt/ammari-prod/env /opt/ammari-prod/caddy/certs /opt/ammari-prod/cloudflare /opt/ammari-prod/backup && sudo chown -R deploy:deploy /opt/ammari-prod`.
   - Create a classic GitHub PAT (`read:packages` only) and, as `deploy`:
     `echo "<PAT>" | docker login ghcr.io -u <your-github-username> --password-stdin`.
4. **Cloudflare — TLS mode.** `ammari.id` zone → **SSL/TLS → Overview** → **Full (strict)**.
5. **Cloudflare — zone-level Authenticated Origin Pulls (the part that differs from dev).**
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
6. **Cloudflare — origin certificate.** **[dev-style]**: **SSL/TLS → Origin Server → Create
   Certificate**, hostnames `ammari.id`, `www.ammari.id`, `admin.ammari.id` → place both files at
   `/opt/ammari-prod/caddy/certs/origin.pem` / `origin.key` (`chmod 600` the key). (This is a
   different certificate from step 5's AOP leaf — this one is what Caddy presents *to*
   Cloudflare as the server's own TLS identity; step 5's pair is what Cloudflare presents *to*
   Caddy to prove the request really came from Cloudflare. Two unrelated cert pairs, both
   required, easy to conflate.)
7. **Object storage — two separate buckets.** On Cloudeka:
   - **Product-image bucket** (public-read, same pattern as dev): create it, note the bucket
     name, endpoint, region, and a fresh access key/secret. You'll need the bucket name for
     Session 7's code change, and the credentials for step 12 below.
   - **Backup bucket** (private, never gets a public-read policy — no `policy:apply` run against
     it, ever): create a **second, separate** bucket, with its **own** access key/secret distinct
     from the product-image bucket's. If Cloudeka supports bucket versioning or object lock /
     write-once (WORM) semantics, enable it on this bucket as a nice-to-have — it means a
     compromised VPS (which only ever holds a key that can write here, see below) can't also
     delete or overwrite existing backups, only add new ones. If Cloudeka offers scoping a key to
     write-only (`PutObject`, no `DeleteObject`/`GetObject`) for this bucket, prefer that over a
     full-access key for the same reason — the VPS only ever needs to upload, never read back or
     delete (the restore drill reads with a *different*, owner-held credential, not the one that
     lives on the VPS).
8. **Resend.** Create a separate API key for prod under the already-verified `mail.ammari.id`
   domain (Resend dashboard → API Keys → Create). This same key is reused by the monitoring
   scripts in Session 6 to send alert emails — no separate key needed for that.
9. **Google OAuth.**
   - Google Cloud Console → the existing OAuth client → **Authorized redirect URIs** → add
     `https://ammari.id/api/auth/callback/google` and
     `https://admin.ammari.id/api/auth/callback/google` (same client ID/secret as dev — just more
     redirect URIs registered on it).
   - Same client → **Authorized JavaScript origins** → add `https://ammari.id` and
     `https://admin.ammari.id` too, if the client has any origins listed at all (some OAuth
     flows need this, some don't — check whether dev's own origins list is non-empty; if it is,
     mirror the same pattern for prod's domains).
   - **OAuth consent screen** → confirm **Publishing status** is **"In production,"** not
     "Testing." In Testing, Google only allows sign-in for accounts explicitly added as test
     users — real customers/staff signing in with Google on prod would fail outright. This is a
     one-time toggle on the consent screen, separate from the redirect URIs above.
10. **Build the secrets files, on your Mac, never displayed or typed by hand.**
    ```bash
    mkdir -p ~/ammari-secrets
    cp deploy-prod/env/admin.env.example  ~/ammari-secrets/prod-admin.env
    cp deploy-prod/env/web.env.example    ~/ammari-secrets/prod-web.env
    cp deploy-prod/env/backup.env.example ~/ammari-secrets/prod-backup.env

    # REVALIDATE_SECRET and PREVIEW_SECRET must be IDENTICAL between admin and web — generate
    # each ONCE, then append the same value to both files:
    REVALIDATE_SECRET="$(openssl rand -base64 32)"
    printf 'REVALIDATE_SECRET=%s\n' "$REVALIDATE_SECRET" >> ~/ammari-secrets/prod-admin.env
    printf 'REVALIDATE_SECRET=%s\n' "$REVALIDATE_SECRET" >> ~/ammari-secrets/prod-web.env
    unset REVALIDATE_SECRET

    PREVIEW_SECRET="$(openssl rand -base64 32)"
    printf 'PREVIEW_SECRET=%s\n' "$PREVIEW_SECRET" >> ~/ammari-secrets/prod-admin.env
    printf 'PREVIEW_SECRET=%s\n' "$PREVIEW_SECRET" >> ~/ammari-secrets/prod-web.env
    unset PREVIEW_SECRET

    # App-specific secrets, straight into their own file, never assigned to a shell variable
    # you'd have to remember to unset:
    printf 'STAFF_BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 32)" >> ~/ammari-secrets/prod-admin.env
    printf 'CUSTOMER_BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 32)" >> ~/ammari-secrets/prod-web.env

    # Backup encryption key — needed again in step 19's restore-drill-for-real and in any future
    # disaster recovery. LOSING THIS KEY MAKES EVERY EXISTING ENCRYPTED BACKUP PERMANENTLY
    # UNREADABLE — there is no recovery path without it. Keep a copy in a password manager
    # (not just this file on your Mac) the moment it's generated, before it's ever used.
    printf 'PG_BACKUP_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 48)" >> ~/ammari-secrets/prod-backup.env

    chmod 600 ~/ammari-secrets/*
    ```
    Now **edit the non-secret values by hand** in those same three files (this part is normal
    editing, not a secrets operation): `DATABASE_URL`, `MAIN_SITE_URL`, `BETTER_AUTH_URL`s
    (`https://ammari.id` for web — the **apex**, not `www.`), `DEPLOY_ENV=production`, Google
    OAuth client id/secret (step 9 — these came from Google's console, not generated locally, so
    typing them in is unavoidable but they aren't freshly-generated local secrets either),
    Resend key (step 8), S3 credentials for the **product-image** bucket (step 7), backup bucket
    name/credentials (step 7) into `prod-backup.env`. **Never** add `NODE_ENV` or
    `E2E_TEST_LOGIN` to any of these files. Double-check `STOREFRONT_CART_ENABLED=false` in
    `prod-web.env` (the whole point of this early launch).
11. **GitHub repo settings.**
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
12. **Copy the secrets files onto the VPS, then fill in the real env files.**
    ```bash
    scp ~/ammari-secrets/prod-admin.env  deploy@<vps-ip>:/opt/ammari-prod/env/admin.env
    scp ~/ammari-secrets/prod-web.env    deploy@<vps-ip>:/opt/ammari-prod/env/web.env
    scp ~/ammari-secrets/prod-backup.env deploy@<vps-ip>:/opt/ammari-prod/env/backup.env
    ssh deploy@<vps-ip> 'chmod 600 /opt/ammari-prod/env/*.env'
    ```
    These three files are now complete (step 10 already filled in every value, secret and
    non-secret) — nothing left to edit on the VPS itself. If a non-secret value ever needs to
    change later (a URL, a flag), edit the copy in `~/ammari-secrets` and re-run the matching
    `scp` line above, rather than editing the file directly on the VPS, so `~/ammari-secrets`
    stays the one source of truth.
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
14. **First deploy.** **Actions → Deploy (prod) → Run workflow**, branch/ref `main`, leave `sha`
    empty (deploys `main`'s current HEAD). Watch the run.
15. **Bootstrap the first `super_admin`.** **[dev-style]**, against the prod migrator image —
    same `docker run --rm --env-file /opt/ammari-prod/env/admin.env ... tsx src/seed.ts` command
    as `docs/deploy.md` §7, with `SEED_SUPER_ADMIN_EMAIL`/`SEED_SUPER_ADMIN_NAME` set to you.
16. **Apply the prod bucket policy.** `pnpm --filter @ammari/storage policy:apply -- --env prod
    --dry-run` first, then without `--dry-run`, once Session 7's code change has filled in the
    real **product-image** bucket name. Never run this against the backup bucket.
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
  from `/opt/ammari-prod/env/backup.env` (`PG_BACKUP_ENCRYPTION_KEY`) → upload to a **dedicated,
  private** Cloudeka S3 bucket (§4 step 7 — never the product-image bucket, never given a
  public-read policy, its own access key) via the same path-style S3 approach
  `packages/storage` already uses for Cloudeka. **Retention (confirmed): keep the last 14 daily
  + last 8 weekly** backups, pruning anything remote older than that on each run. Never deletes a
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
     setup. A SaaS free tier over self-hosting one more service on a 4 GB box.
  2. **Disk alert** — VPS-local timer, alerts past ~80% disk used (the exact threshold most
     likely to matter here: Docker image/layer growth plus Postgres data growth over months).
  3. **Backup success** — VPS-local timer, alerts if **either** the newest object in the backup
     bucket is older than ~26 hours (gives a bit of slack over the 24h cadence before paging
     anyone) **or no backup object exists at all** — the latter catches a brand-new install
     whose backup timer never successfully ran even once, which a pure "staleness" check alone
     would never flag (there's nothing to compare against yet).

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
- [ ] A product image renders (confirms the prod bucket policy from Session 7 is actually applied
      — an `AccessDenied` here means the policy never got applied for real).
- [ ] The nightly backup timer has produced at least one real object in the **backup** bucket,
      and that bucket still has no public-read policy.
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
5. **VPS provider:** confirmed — Sumopod, Jakarta region (same provider as dev), 2 vCPU / 4 GB.
   Disk-size proposal (80 GB SSD) kept as-is.

No open questions remain blocking this plan.
