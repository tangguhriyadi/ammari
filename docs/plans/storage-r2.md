# Plan: Move object storage (dev + prod) from Cloudeka to Cloudflare R2

## Summary

Cloudeka (the current S3-compatible provider, both environments) is slow enough to be a user-
facing problem, not just a rough edge. Measured from the dev VPS, inside the admin container,
with `packages/storage/scripts/s3-diagnose.mjs` (8KB PUT+DELETE ×3 per variant):

| | Cloudeka | R2 (bucket `ammari-diag`, `auto` region) |
|---|---|---|
| avg | 2–12s | ~0.3s |
| max | ~20s | ~0.7s |
| real admin upload (observed) | 38–113s | — |

The slowness reproduces even with a raw signed `fetch` bypassing the AWS SDK entirely — it's the
provider, not our client config (`docs/deploy-prod.md`'s troubleshooting section has the full
history of chasing this as an SDK/checksum/keep-alive issue before this diagnostic ruled Cloudeka
itself in as the cause). Moving to R2 fixes the root cause instead of adding more client-side
workarounds.

This also resolves `docs/plans/prod-deploy.md` §9's deferred "separate, private backup bucket
with its own access key" item — R2 buckets are free to create, so there's no cost reason left to
share one bucket/key between product images and backups.

**Scope: dev and prod both move.** No object migration (current data is test data — see
"Existing data" below). No code changes beyond what's listed in the sessions below — the
S3-compatible client (`packages/storage/src/s3-client.ts`) stays as-is.

## Decisions already made (do not re-open)

- **Three R2 buckets, account-wide:** dev media (public), prod media (public), prod backups
  (**private**, never public). Dev has no backups — only prod backs up.
- Dev's existing `local/` vs `dev/` key-prefix split (one bucket shared between local dev and the
  deployed dev VPS) carries over unchanged onto the new dev R2 bucket — still 3 buckets total, not
  4.
- **Public access via Cloudflare custom domains** on R2 (`img.ammari.my.id` for dev,
  `img.ammari.id` for prod), so requests are cached and protected by Cloudflare's edge. **Never**
  enable the `r2.dev` public-development URL on any bucket, including dev — it bypasses
  Cloudflare's cache/WAF and isn't needed once a custom domain is connected.
- **One R2 API token per bucket**, least privilege: "Object Read & Write" scoped to that one
  bucket. The backups token is never given access to the media buckets and vice versa.
- **No bucket policies.** R2 has no `PutBucketPolicy`/`GetBucketPolicy` API — the Cloudeka
  `policy:apply`/`policy:show` tooling and the "public-prefix" model it implements are retired,
  not ported. "Public" becomes a whole-bucket property (set once, via a custom domain) — which
  means every write path into a media bucket must be audited to confirm nothing private is ever
  written there (done in Session 1 below; conclusion: nothing is — see that session).
- **No object migration.** Existing `product_images`/content-image rows that point at Cloudeka
  URLs are test data; see "Existing data" below for exactly what happens to them.
- **Keep the S3 client as-is**: still S3-compatible (`@aws-sdk/client-s3`), `region: "auto"`
  (R2's required value), same checksum/timeout settings (`WHEN_REQUIRED`, 5s connect/30s request,
  3 attempts — R2 doesn't need these, but they're harmless and this isn't the place to change
  them), same `[upload-timing]`/`[image-resize]` logs. `packages/storage/scripts/s3-diagnose.mjs`
  gets committed as a permanent ops tool (currently untracked — `git status` shows it as `??`).

## Architecture: before → after

| | Before (Cloudeka) | After (R2) |
|---|---|---|
| Dev media bucket | `ammaridev-uc1gfp` (shared, `local/`/`dev/` prefix) | `ammari-dev` (same prefix split) |
| Prod media bucket | `ammariprod-cdy2yf` | `ammari-prod` |
| Prod backups | `backups/` prefix **inside** `ammariprod-cdy2yf`, same access key as media | **dedicated** `ammari-prod-backups` bucket, its own token |
| Public access | Bucket policy, `products/*`/`content/*`/`healthcheck/*` statements | Whole-bucket public via Cloudflare custom domain; no policy concept |
| Public URL | `STORAGE_PUBLIC_BASE_URL` = raw Cloudeka endpoint path | `STORAGE_PUBLIC_BASE_URL` = `https://img.ammari.my.id` (dev) / `https://img.ammari.id` (prod) |
| Region | `kencana` | `auto` |
| Endpoint | `https://kencana.basic.box.cloudeka.id` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |

Nothing else in the architecture changes: `apps/web` still never holds an S3 credential and still
just does `${STORAGE_PUBLIC_BASE_URL}/${storageKey}/${size}.webp` string concatenation
(`apps/web/src/lib/storage/public-url.ts`); `next.config.ts` has `images.unoptimized: true` and no
`remotePatterns`, so there is nothing to update there or any CORS concern — images are rendered as
plain `<img>`/`unoptimized next/image`, never `fetch`ed or drawn to canvas, on either app.

## Existing data: what happens to current rows

`product_images.storage_key` and the homepage content sections' `ContentImage.storageKey` keep
whatever value they already have — **no migration script, no bulk update.** After cutover:

- Every upload path (`apps/admin/src/lib/products/image-queries.ts`,
  `content-image-queries.ts`) generates a **new** `imageId`/`storageKey` on every upload
  (`randomUUID()`), so re-uploading a product/content image through the admin UI as normal
  creates a fresh object in the new R2 bucket and deletes the old DB row — no special flow needed.
- Deleting an old row calls `storage.delete()` against the *new* client (R2), targeting a key that
  only ever existed in Cloudeka. S3 `DeleteObject` (and R2's implementation of it) is idempotent —
  it returns success whether or not the key exists — and every delete call site
  (`deleteObjectsLogged` and its content-image equivalent) already treats delete failures as
  best-effort/logged, never thrown. So this is a silent no-op, not an error.
- Net effect: until the owner re-uploads each product/content image after cutover, that image's
  `<img>` tag 404s (broken image icon) — acceptable for test data, and the fix is "open the admin
  page, delete the broken image, upload it again," the same action an owner would take for any
  broken image today. No code or migration needed for this.

## Owner checklist (Cloudflare dashboard — no Claude Code session touches this)

Do this once, before Session 2 needs real credentials. Every secret gets copied with Cloudflare's
own "copy" button and piped straight into a file — **never pasted into a terminal command, never
displayed**:

```bash
mkdir -p ~/ammari-secrets && chmod 700 ~/ammari-secrets
# after clicking "copy" on each value in the Cloudflare dashboard:
pbpaste > ~/ammari-secrets/<name>   # see exact names below
chmod 600 ~/ammari-secrets/<name>
```

1. **Buckets** (Cloudflare dashboard → R2 → Create bucket, same account that already manages the
   `ammari.my.id`/`ammari.id` zones):
   - `ammari-dev` — Location: Automatic.
   - `ammari-prod` — Location: Automatic.
   - `ammari-prod-backups` — Location: Automatic.
2. **Public access — custom domains** (only on the two media buckets):
   - `ammari-dev` → Settings → Public access → Custom Domains → Connect Domain →
     `img.ammari.my.id`. Cloudflare provisions the DNS record and certificate automatically
     since the zone is in the same account — no separate DNS step.
   - `ammari-prod` → same → `img.ammari.id`.
   - Leave the "Public Development URL" (`r2.dev`) toggle **off** on all three buckets (default;
     just confirm it wasn't turned on at some point).
   - `ammari-prod-backups` → do **not** connect a custom domain, do **not** enable any public
     access toggle. It stays reachable only via the S3 API with its own scoped token.
3. **Account ID** (needed to build the S3 endpoint — same for every bucket, not secret, but
   account-specific so it doesn't belong hardcoded in a script either): Cloudflare dashboard → R2
   → the account ID shown on the R2 overview page.
   ```bash
   pbpaste > ~/ammari-secrets/r2-account-id
   ```
4. **API tokens** (R2 → Manage R2 API Tokens → Create API Token → "Permissions: Object Read &
   Write" → "Specify bucket(s)" → the one bucket). Create three, one per bucket:
   - `ammari-dev-rw` scoped to `ammari-dev` →
     `pbpaste > ~/ammari-secrets/r2-dev-access-key-id` and
     `pbpaste > ~/ammari-secrets/r2-dev-secret-access-key`.
   - `ammari-prod-rw` scoped to `ammari-prod` →
     `pbpaste > ~/ammari-secrets/r2-prod-access-key-id` and
     `pbpaste > ~/ammari-secrets/r2-prod-secret-access-key`.
   - `ammari-prod-backups-rw` scoped to `ammari-prod-backups` →
     `pbpaste > ~/ammari-secrets/r2-prod-backups-access-key-id` and
     `pbpaste > ~/ammari-secrets/r2-prod-backups-secret-access-key`.
   - `chmod 600 ~/ammari-secrets/r2-*` once all seven files exist.

That's every dashboard step. Nothing else (no lifecycle rules, no CORS config — see "Open
questions" for why) is required to go live.

## Code changes — ordered Claude Code sessions

Each session is code-only; none of them touch a real bucket or secret (same convention as every
other session in `docs/plans/prod-deploy.md` — "no agent session has touched the real VPS/GitHub
secrets/Cloudflare settings"). Run `/code-review` (routing to `typescript-reviewer`; add
`security-reviewer` for anything touching env/secret handling) before each commit, per CLAUDE.md.

### Session 1 — Retire the bucket-policy tooling, commit the diagnostic

- Delete `packages/storage/src/policy.ts`, `policy-apply.ts`, `policy-show.ts`,
  `test/policy.test.ts`, `bucket-policy.dev.json`, `bucket-policy.prod.json`.
- Remove the `policy:apply`/`policy:show` scripts from `packages/storage/package.json`.
- Update `packages/storage/src/check.ts`'s `printPublicReadOptions()` — it currently suggests a
  bucket policy as the recommended fix for a failed public-read check. Replace with: "connect a
  Cloudflare custom domain to this bucket (R2 dashboard → bucket → Settings → Public access →
  Custom Domains) and point `STORAGE_PUBLIC_BASE_URL` at it." Drop the ACL/signed-URL alternatives
  — they don't apply to R2.
- **Audit every write path** into a media bucket to confirm the "whole bucket is public, nothing
  private may ever land there" model holds. Done — `grep -rn "\.put(" apps packages` (excluding
  tests and the now-deleted `policy-apply.ts`) turns up exactly three call sites, all writing
  under one of three public-safe prefixes, none ever anything a human would consider private:

  | Call site | Key shape written | Prefix |
  |---|---|---|
  | `apps/admin/src/lib/products/image-queries.ts` (`uploadProductImage`) | `{keyPrefix}products/{productId}/{imageId}/{size}.webp` | `products/*` |
  | `apps/admin/src/lib/content/content-image-queries.ts` (`uploadContentImage`) | `{keyPrefix}content/{sectionKey}/{imageId}/{size}.webp` | `content/*` |
  | `packages/storage/src/check.ts` (healthcheck writer) | `{keyPrefix}healthcheck/{timestamp}.txt` | `healthcheck/*` |

  (`keyPrefix` is `local/`/`dev/`/`""` per `getStorageKeyPrefix()` — it varies the environment
  split, never the public-safety of what follows it.) **Conclusion: confirmed safe** — every write
  path lands under `products/*`, `content/*`, or `healthcheck/*`, matching exactly what a
  whole-bucket-public model requires. No code change results from the audit itself.
- **Cache-Control decision, applied.** Both image-upload call sites above generate a brand-new
  `imageId` (`randomUUID()`) on every upload and never overwrite an existing key — confirmed by
  reading `uploadProductImage`/`uploadContentImage`, which always mint a fresh `imageId` before
  calling `.put()`, and by `buildImageStorageKey`/`buildContentImageStorageKey`, which always fold
  that `imageId` into the key. The healthcheck writer's key is a timestamp, immediately deleted in
  the same run. No path reuses a key, so `S3StorageClient.put()` now unconditionally sets
  `Cache-Control: public, max-age=31536000, immutable` on every object it writes (see
  `packages/storage/src/s3-client.ts`'s `MEDIA_CACHE_CONTROL`) — no per-path exception needed.
- `git add packages/storage/scripts/s3-diagnose.mjs` (currently untracked) and commit it. Add one
  line to its header comment: this now also doubles as the pre-migration R2-vs-Cloudeka
  comparison tool, and remains useful post-migration for diagnosing any *future* provider's
  latency the same way.
- Tests: `pnpm --filter @ammari/storage test` and `pnpm --filter @ammari/storage typecheck`
  (removing `policy.ts` et al. must not break `s3-client.test.ts`/`memory-client.test.ts`, which
  don't import from it).

### Session 2 — Backup scripts read their own credentials

Today `pg-backup.sh` and `backup-check.sh` load `env/admin.env` to get `S3_*` (because backups
shared the media bucket's key). With a dedicated backups bucket, that coupling is no longer
correct and should be removed, not just left harmlessly redundant:

- `deploy-prod/env/backup.env.example`: add `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`,
  `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, with a comment
  explaining these are the `ammari-prod-backups`-scoped R2 token, deliberately separate from
  `env/admin.env`'s media-bucket credentials.
- `deploy-prod/backup/pg-backup.sh`: drop `load_env_file "env/admin.env"` entirely (nothing else
  in this script needs it — DB access is via `docker compose exec db`, not a connection string).
  Change the `require_var`/`S3OPS_SCRIPT` block to read `BACKUP_S3_*` instead of `S3_*`.
- `deploy-prod/monitoring/backup-check.sh`: same change — stop loading `env/admin.env`, read
  `BACKUP_S3_*` from `env/backup.env` for the bucket-listing check.
- `deploy-prod/restore-drill-local.sh` and `docs/runbooks/restore-drill.md`: update the comment/
  instructions that currently say "S3 credentials from `~/ammari-secrets/prod-admin.env`" to say
  `~/ammari-secrets/prod-backup.env`'s `BACKUP_S3_*` vars instead.
- Tests: these are bash scripts with no unit-test harness in this repo; verification is manual
  (owner runs `pg-backup.sh` once by hand against the real backups bucket during cutover — see
  "Switch order" below). This session is reviewed via `/code-review` (`security-reviewer` for the
  credential-handling change), not exercised automatically.

### Session 3 — `make-prod-env.sh` / `upload-prod-env.sh` generate R2 values

- `deploy-prod/make-prod-env.sh`:
  - Read the account ID once from `~/ammari-secrets/r2-account-id` (fail with a clear message if
    missing — mirrors the existing `prod-resend-api-key` required-file check).
  - Replace the hardcoded `S3_ENDPOINT="https://kencana.basic.box.cloudeka.id"` /
    `S3_REGION="kencana"` / `S3_BUCKET="ammariprod-cdy2yf"` lines with
    `https://${account_id}.r2.cloudflarestorage.com` / `auto` / `ammari-prod`.
  - Replace the two `prompt_secret "Enter prod S3 access key ID/secret ... (ammariprod-cdy2yf —
    NOT dev's key...)"` calls — instead, read `r2-prod-access-key-id`/`r2-prod-secret-access-key`
    from `~/ammari-secrets` the same way `prod-resend-api-key` is read (no prompt needed; the
    owner already created and saved these in the checklist above). Keep a prompt as a fallback
    only if the file is missing, same pattern as `resolve_from_dev_or_prompt`.
  - Add the same read (not prompt) for `r2-prod-backups-access-key-id`/
    `r2-prod-backups-secret-access-key`, and write `BACKUP_S3_ENDPOINT`/`BACKUP_S3_REGION`/
    `BACKUP_S3_BUCKET=ammari-prod-backups`/`BACKUP_S3_ACCESS_KEY_ID`/
    `BACKUP_S3_SECRET_ACCESS_KEY` into `prod-backup.env` (new `set_env_var` calls on `$BACKUP_DEST`,
    alongside the existing `PG_BACKUP_ENCRYPTION_KEY`/`ALERT_EMAIL_TO` ones).
  - Update the script's own header comment (currently documents the Cloudeka-specific behavior of
    the S3 prompts) to match.
- `deploy-prod/upload-prod-env.sh`: no change — it already uploads all four files generically;
  `prod-backup.env` just has more keys in it now.
- Tests: none automatable (writes real files under `$HOME`); the script already supports a
  throwaway `HOME=/tmp/fake-home` dry run per its own header comment — use that to confirm it
  writes without error, but this doesn't exercise real R2 credentials.

### Session 4 — `go-live-check.sh`

- Update the hardcoded `S3_ENDPOINT="https://kencana.basic.box.cloudeka.id"` /
  `S3_BUCKET="ammariprod-cdy2yf"` (lines 36–37) to the R2 account endpoint and
  `ammari-prod-backups`. This check (`check_backups_private`, §9) runs from the owner's Mac with
  no SSH, so it can't read the VPS's env file — these two values stay literal constants in the
  script, same as today, just pointed at the new bucket.
- No other check in this script needs to change — the admin/web health, AOP, header, and port
  checks are all storage-independent.
- Tests: none automatable against a real bucket; run the full script by hand during go-live
  verification (unchanged from existing practice).

### Session 5 — Docs

- `docs/SPEC.md` §2.3/2.4: "Object storage: S3-compatible, with separate dev and prod buckets."
  → "Object storage: Cloudflare R2 (S3-compatible), with separate dev and prod media buckets plus
  a dedicated, private prod backups bucket." Update the §2.3 Prod-database paragraph's mention of
  "the **same** prod object storage bucket used for product/content images... a deliberate,
  accepted scope-down" — it no longer applies; point it at this plan instead of
  `prod-deploy.md` §9.
- `docs/plans/prod-deploy.md` §9: mark the "Separate, private backup bucket with its own access
  key" entry as **done** (superseded by this plan), rather than deleting the paragraph — it
  explains *why* the original launch didn't have one, which is still useful history.
- `docs/deploy-prod.md` §0's Bucket row and §5 (Backups) — update to R2 details (new endpoint,
  region, three bucket names, which env file now holds which credential).
- `docs/deploy-prod.md`'s troubleshooting section — the long Cloudeka-slow-upload writeup stays
  (valuable history, and `s3-diagnose.mjs` remains a useful general tool), but add one line at its
  top: "Resolved by moving off Cloudeka entirely — see `docs/plans/storage-r2.md`." Don't delete
  the diagnosis; a future provider swap might need the same tool again.
- `docs/deploy.md`'s "Bucket policy: public-read for product/content images" section — replace
  with "Public access: Cloudflare custom domain" explaining the one-time dashboard step instead of
  `policy:apply`/`policy:show` (which no longer exist after Session 1).
- `apps/admin/.env.example` / `apps/web/.env.example`: update the sample `S3_ENDPOINT`/
  `S3_REGION`/`STORAGE_PUBLIC_BASE_URL` placeholder values to R2-shaped examples (`region=auto`,
  `https://<account-id>.r2.cloudflarestorage.com`) so a new local setup doesn't copy
  Cloudeka-shaped placeholders.

## Switch order: dev first, verify, then prod

**Dev:**
1. Complete the owner checklist's dev bucket + token + custom domain steps.
2. Land Sessions 1–5 above (merged to `dev`, deployed via the normal dev pipeline).
3. On the VPS, by hand: edit `/opt/ammari/env/admin.env` and `/opt/ammari/env/web.env` with the
   new `S3_ENDPOINT`/`S3_REGION=auto`/`S3_BUCKET=ammari-dev`/`S3_ACCESS_KEY_ID`/
   `S3_SECRET_ACCESS_KEY` (admin only) and `STORAGE_PUBLIC_BASE_URL=https://img.ammari.my.id`
   (both files) — keep `S3_KEY_PREFIX=dev/` unchanged.
4. `docker compose up -d --force-recreate admin web` (dev has no blue/green — this is the normal
   env-change recreate, `docs/deploy.md` has no numbered section for it but it's the same
   operation as prod's §3.2).
5. Verify: `pnpm --filter @ammari/storage storage:check` (point its `--env-file` at the updated
   `apps/admin/.env` if testing from a local checkout, or run it inside the admin container
   against the real env — same command either way) must print "Public read works." Then do one
   real upload through the admin UI (any product image) and confirm it renders on the storefront.
6. Only once that's confirmed, move to prod.

**Prod:**
1. Complete the owner checklist's prod media bucket + prod backups bucket + tokens + custom domain
   steps (if not already done alongside dev's).
2. `make-prod-env.sh --force` (Session 3's updated version) — regenerates `prod-admin.env`,
   `prod-web.env`, `prod-backup.env` with R2 values; existing secrets not derived from storage
   (auth secrets, OAuth, Resend) are preserved as today's script already guarantees via its
   backup-then-rewrite behavior... **check this carefully**: `make-prod-env.sh` as written today
   regenerates *every* secret fresh on each run (`openssl rand` for all of them), not just the
   storage ones — running it `--force` would rotate `STAFF_BETTER_AUTH_SECRET` etc. too, which is
   unnecessary churn and would log out every staff session. **Session 3 should also add a
   `--storage-only` mode** (or equivalent: read-and-preserve the existing non-storage secrets from
   the current `prod-*.env` files instead of regenerating them) so this run only touches the
   storage-related keys. Treat this as part of Session 3's scope, not a separate decision.
3. `deploy-prod/upload-prod-env.sh`.
4. `docker compose up -d --force-recreate "admin-$(cat active-slot-admin)" "web-$(cat
   active-slot-web)"` (docs/deploy-prod.md §3.2 — this already exists as the documented env-change
   procedure).
5. Verify, same as dev: `storage:check` against the new bucket, one real admin image upload
   rendering on `https://ammari.id`.
6. Run `cd /opt/ammari-prod/backup && ./pg-backup.sh` by hand once — confirms the new
   `BACKUP_S3_*` wiring actually reaches `ammari-prod-backups` before trusting the nightly timer
   with it. Check `cat last-backup-status.json` and list the bucket
   (`policy-show`-style `aws s3 ls`, or just the Cloudflare dashboard) to confirm the object landed.
7. `deploy-prod/restore-drill-local.sh` once, to confirm a backup written to the new bucket
   actually restores.
8. `deploy-prod/go-live-check.sh` (Session 4's updated version) — confirms `check_backups_private`
   passes against the new bucket.

## Rollback

Nothing is destructive until the final "cancel Cloudeka" step, so rollback at any point before
that is just reverting env vars:

- **Dev/prod app rollback:** restore the previous `S3_*`/`STORAGE_PUBLIC_BASE_URL` values
  (Cloudeka's) in the relevant env file(s), force-recreate the affected container(s) — same
  "change an env value" procedure as any other env rollback (`docs/deploy-prod.md` §3). No data
  was moved, so nothing to undo on the storage side itself.
- **Backup rollback:** revert `pg-backup.sh`/`backup-check.sh` to reading `env/admin.env`'s old
  `S3_*` (i.e., `git revert` Session 2's commit) and restore the Cloudeka credentials there if they
  were ever removed. Until Cloudeka is actually cancelled (last step below), its bucket and
  backups already uploaded to it are untouched and still restorable.
- There is no scenario in this plan where rolling back loses data, because the Cloudeka buckets
  are never written-to-zero or deleted until the very last step, after a soak period.

## Decommissioning Cloudeka

Only after prod has run on R2 through at least one full nightly backup cycle and one successful
`restore-drill-local.sh` against a *real* nightly (not just the manual dry run above), and after a
reasonable soak period (recommend ~1–2 weeks, owner's call):

1. Confirm no code or env file anywhere still references the Cloudeka endpoint/bucket names
   (`grep -rn "kencana\|cloudeka\|ammariprod-cdy2yf\|ammaridev-uc1gfp"` across the repo and both
   VPSes' `env/` directories should return nothing).
2. Download or otherwise confirm you no longer need anything in the Cloudeka buckets (test data —
   expected to be nothing worth keeping, but double-check the prod bucket's `backups/` prefix
   specifically, since those were real encrypted Postgres dumps even though the product data
   wasn't).
3. Delete both Cloudeka buckets via Cloudeka's console, revoke the S3 access key(s), and
   cancel/downgrade the Cloudeka account or plan.
4. Remove `~/ammari-secrets/dev-admin.env`'s/`prod-admin.env`'s old Cloudeka `S3_*` values if they
   were kept as a rollback reference rather than overwritten in place.

## Decisions

1. **Bucket/custom-domain naming — confirmed.** `ammari-dev`/`ammari-prod`/`ammari-prod-backups`
   and `img.ammari.my.id` (dev)/`img.ammari.id` (prod), exactly as used throughout this plan.
2. **`make-prod-env.sh` gets a storage-only mode (hard requirement, Session 3).** It must rewrite
   only the S3/storage-related env vars in an existing env file and never regenerate or touch any
   other secret (auth secrets, OAuth, Resend, etc.) — a full secret rotation as a side effect of
   this migration is unacceptable (would log out every staff session). This is scope for Session 3,
   not a separate decision to revisit there.
3. **Object `Cache-Control` metadata — set it, conditionally.** `S3StorageClient.put()` only sets
   `ContentType` today, no `Cache-Control`. Set `Cache-Control: public, max-age=31536000,
   immutable` on media uploads, but only because every write path was audited and confirmed to
   always generate a brand-new, never-reused object key per upload (see Session 1's write-path
   audit below) — an immutable cache header on a key that could ever be overwritten would serve
   stale content from Cloudflare's edge indefinitely. If any path is ever added that reuses a key,
   that path must use a short `max-age` instead, not the immutable header.
4. **No R2 lifecycle rules on `ammari-prod-backups`.** `pg-backup.sh` already does its own
   application-level pruning (14 daily/8 weekly). Retention stays entirely in the backup scripts;
   no second layer of defense in R2 itself.
5. **No CORS configuration.** Confirmed not needed: every image reference in both apps is a plain
   `<img>`/`unoptimized next/image` `src`, never `fetch`/`canvas`. Revisit only if a future feature
   fetches image bytes client-side.
