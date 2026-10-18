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
3. **Account ID / endpoint** (same for every bucket, not secret, but account-specific) —
   Cloudflare dashboard → R2 → the account ID shown on the R2 overview page builds the endpoint
   `https://<account-id>.r2.cloudflarestorage.com`. No separate file for this: the endpoint is
   non-secret and short-lived to look up, so it's a literal constant everywhere it's needed
   (`deploy-prod/env/backup.env.example`'s `BACKUP_S3_ENDPOINT`, `deploy-prod/make-prod-env.sh`'s
   `R2_ENDPOINT`) rather than a file read at runtime.
4. **API tokens** (R2 → Manage R2 API Tokens → Create API Token → "Permissions: Object Read &
   Write" → "Specify bucket(s)" → the one bucket). Create three, one per bucket — one value per
   file, named to match what `deploy-prod/make-prod-env.sh` and `docs/deploy-prod.md` §8.3
   actually read:
   - `ammari-dev-rw` scoped to `ammari-dev` →
     `pbpaste > ~/ammari-secrets/r2-dev-access-key` and
     `pbpaste > ~/ammari-secrets/r2-dev-secret-key`.
   - `ammari-prod-rw` scoped to `ammari-prod` →
     `pbpaste > ~/ammari-secrets/r2-prod-access-key` and
     `pbpaste > ~/ammari-secrets/r2-prod-secret-key`.
   - `ammari-prod-backups-rw` scoped to `ammari-prod-backups` →
     `pbpaste > ~/ammari-secrets/r2-backups-access-key` and
     `pbpaste > ~/ammari-secrets/r2-backups-secret-key`.
   - `chmod 600 ~/ammari-secrets/r2-*` once all six files exist.

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

### Session 2 — Backup scripts read their own credentials (done)

Today `pg-backup.sh` and `backup-check.sh` load `env/admin.env` to get `S3_*` (because backups
shared the media bucket's key). With a dedicated backups bucket, that coupling is no longer
correct and should be removed, not just left harmlessly redundant:

- `deploy-prod/env/backup.env.example`: adds `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`,
  `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, with a comment
  explaining these are the `ammari-prod-backups`-scoped R2 token, deliberately separate from
  `env/admin.env`'s media-bucket credentials. The non-secret values (endpoint, region, bucket
  name — account-wide constants, not secrets) are pre-filled directly in the `.example` file
  itself (unlike the media bucket's `S3_*`, which `make-prod-env.sh` fills programmatically) —
  simplest for the one-time manual server switch documented in `docs/deploy-prod.md` §8.3, since
  Session 3 hasn't wired `make-prod-env.sh` up for this yet (see below).
- `deploy-prod/backup/pg-backup.sh`: drops `load_env_file "env/admin.env"` entirely (nothing else
  in this script needs it — DB access is via `docker compose exec db`, not a connection string).
  The `require_var`/`S3OPS_SCRIPT` block now reads `BACKUP_S3_*` instead of `S3_*`.
- `deploy-prod/monitoring/backup-check.sh`: same change — stops loading `env/admin.env`, reads
  `BACKUP_S3_*` from `env/backup.env` for the bucket-listing check.
- `deploy-prod/restore-drill-local.sh`: no longer takes an `--admin-env` flag at all (it never
  needed anything else from `prod-admin.env`) — reads `BACKUP_S3_*` and
  `PG_BACKUP_ENCRYPTION_KEY` both from `--backup-env` (`~/ammari-secrets/prod-backup.env`).
  `docs/runbooks/restore-drill.md` updated to match.
- **Object prefix layout — kept unchanged.** `backups/daily/`+`backups/weekly/` still live
  *inside* the new dedicated bucket, exactly as they did inside the old shared one. Simplest
  consistent choice: zero changes needed to `pg-backup.sh`'s key-naming/prune logic, and
  `restore-drill-local.sh`/`backup-check.sh` keep listing the same paths. The prefix is no longer
  load-bearing for privacy (the whole bucket is private now), but removing it would be change for
  its own sake.
- `deploy-prod/make-prod-env.sh` / `upload-prod-env.sh`: **deliberately left untouched beyond a
  TODO comment** pointing at Session 3. Wiring real prompts/reads for `BACKUP_S3_ACCESS_KEY_ID`/
  `BACKUP_S3_SECRET_ACCESS_KEY` into `make-prod-env.sh` now isn't small or safe on its own — this
  script's `--force` path currently regenerates *every* secret, not just storage ones, and
  Decision 2 below requires a `--storage-only` mode before any script run should be trusted not
  to rotate `STAFF_BETTER_AUTH_SECRET` etc. as a side effect. `upload-prod-env.sh` needed no
  change — it already uploads `prod-backup.env` generically.
- `deploy-prod/env/admin.env.example`'s comment claiming the media bucket "ALSO holds nightly
  encrypted Postgres backups under its own backups/ prefix... reuses these SAME credentials" is
  now false and was corrected in the same session.
- Switch-over procedure for the real server documented in `docs/deploy-prod.md` §8.3: edit
  `prod-backup.env` on the Mac, `upload-prod-env.sh`, `scp` the updated `backup/`/`monitoring/`
  scripts (§8.1), then run `pg-backup.sh` + `backup-check.sh` manually once and
  `restore-drill-local.sh` once against the new bucket before trusting the nightly timer.
- Tests: these are bash scripts with no unit-test harness in this repo. `bash -n` on every
  changed script passed; `shellcheck` (where available) passed with only pre-existing/expected
  disables. A local dry run with a fake `env/backup.env` missing `BACKUP_S3_*` confirmed
  `pg-backup.sh`/`backup-check.sh` fail loudly with a clear message and never fall back to
  `env/admin.env` (that file was never even created in the dry-run sandbox). Real-bucket
  verification is manual, per the switch-over procedure above — this session is reviewed via
  `/code-review` (`security-reviewer` for the credential-handling change), not exercised
  automatically.

### Session 3 — `make-prod-env.sh` / `upload-prod-env.sh` generate R2 values (done)

- `deploy-prod/make-prod-env.sh`:
  - No `~/ammari-secrets/r2-account-id` file after all — the R2 endpoint already fully encodes
    the account ID and is non-secret (same literal value already committed in
    `deploy-prod/env/backup.env.example`'s `BACKUP_S3_ENDPOINT`), so it's a hardcoded constant
    in the script (`R2_ENDPOINT`), same as `R2_REGION="auto"`/`R2_PROD_MEDIA_BUCKET="ammari-prod"`/
    `R2_PROD_BACKUPS_BUCKET="ammari-prod-backups"` — no per-run file read needed for these.
  - Replaced the hardcoded Cloudeka `S3_ENDPOINT`/`S3_REGION`/`S3_BUCKET` lines and the two
    `prompt_secret "Enter prod S3 access key ID/secret..."` calls with reads (never a prompt,
    never a command-line argument) from `~/ammari-secrets/r2-prod-access-key` and
    `r2-prod-secret-key` — matching the naming already established by
    `deploy-prod/env/backup.env.example`'s own comment and `docs/deploy-prod.md` §8.3 for the
    backups bucket (`r2-backups-access-key`/`r2-backups-secret-key`), not the `-access-key-id`/
    `r2-account-id` naming this section originally sketched. No prompt fallback: a missing or
    empty key file is a hard failure, by design (these are machine credentials, not something
    to type from memory).
  - Added the same reads for `r2-backups-access-key`/`r2-backups-secret-key`, and the default/
    `--force` path now writes `BACKUP_S3_ENDPOINT`/`BACKUP_S3_REGION`/
    `BACKUP_S3_BUCKET=ammari-prod-backups`/`BACKUP_S3_ACCESS_KEY_ID`/`BACKUP_S3_SECRET_ACCESS_KEY`
    into `prod-backup.env`, closing the Session 2 TODO.
  - **Added `--storage-only` mode** (Decision 2 below): edits the *existing*
    `prod-admin.env`/`prod-web.env`/`prod-backup.env` in place, touching only the storage
    variables (`S3_*` / `BACKUP_S3_*`) and leaving every other line — every non-storage secret —
    byte-for-byte identical. Backs up each file it actually edits first
    (`<name>.env.bak.<UTC timestamp>`, mode 600), and prints only the names of variables that
    changed, never a value. Refuses to run if a target file doesn't exist yet, or if `--force`
    is also passed (mutually exclusive). This is the mode the real prod cutover (below) actually
    uses — plain `--force` still regenerates every secret and is for the first-time build or a
    deliberate full rotation, not this migration.
  - Updated the script's own header comment to match (no more Cloudeka-specific language).
- `deploy-prod/upload-prod-env.sh`: no change — it already uploads all four files generically;
  `prod-backup.env` just has more keys in it now.
- Tests: no real-bucket test (none automatable without real credentials). Verified with fake env
  files and fake key files under a throwaway `HOME` in a temp directory: default mode builds all
  four files with the right R2 constants; `--storage-only` changes only the five `S3_*` lines in
  an admin env that still had old Cloudeka-shaped values (confirmed via `diff` — every other
  line, including `STAFF_BETTER_AUTH_SECRET`/`DATABASE_URL`/`REVALIDATE_SECRET`, byte-for-byte
  identical) and only the matching `BACKUP_S3_*` lines in the backup env; it refuses when a
  required key file is missing or empty, and when the target files don't exist yet; `--force`
  and `--storage-only` together are rejected. Re-ran the same `--storage-only` case under
  `/bin/bash` (confirmed macOS's stock bash 3.2) to confirm no bash-4+-only syntax crept in —
  the script uses no GNU-only `sed` (it never calls `sed` at all) and no bash-4+ constructs.
  `shellcheck` and `bash -n` both pass.

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
2. Land Sessions 1–3 above (merged to `dev`, deployed via the normal dev pipeline) — Sessions 4
   and 5 touch only prod-only scripts (`go-live-check.sh`) and docs, neither blocks the dev
   switch.
3. **On the VPS, by hand — the owner only, no Claude Code session touches this.** Dev's env
   files live only on the VPS (unlike prod, there's no local `~/ammari-secrets/dev-*.env` source
   of truth or a `make-dev-env.sh` generator) — edit them in place over SSH:
   1. On your Mac, get the dev R2 credentials' *values* without ever typing or echoing them to a
      terminal — open `~/ammari-secrets/r2-dev-access-key` and `r2-dev-secret-key` in a local
      editor (or `pbcopy < ~/ammari-secrets/r2-dev-access-key`, then paste) and keep them ready
      to paste into `env/admin.env` below. Same convention `docs/deploy-prod.md` §8.3 already
      uses for the prod backups-bucket switch: paste with an editor, never `cat`/`echo` a key to
      a terminal.
   2. SSH in and switch to the `deploy` user — dev's own access pattern (`docs/deploy.md`
      §"Reading logs and health status"), since dev keeps no dedicated `deploy`-user SSH key on
      the Mac the way prod does:
      ```bash
      ssh ubuntu@43.129.55.61
      sudo -iu deploy
      cd /opt/ammari
      $EDITOR env/admin.env
      ```
   3. In `env/admin.env`, change only these lines (every other line, including every
      non-storage secret, stays as-is):
      ```
      S3_ENDPOINT=https://d99c5045ed359887e8fdd591cc492ee9.r2.cloudflarestorage.com
      S3_REGION=auto
      S3_BUCKET=ammari-dev
      S3_ACCESS_KEY_ID=<paste the value from r2-dev-access-key>
      S3_SECRET_ACCESS_KEY=<paste the value from r2-dev-secret-key>
      S3_KEY_PREFIX=dev/                              # unchanged — same local/dev prefix split
      STORAGE_PUBLIC_BASE_URL=https://img.ammari.my.id
      ```
   4. `$EDITOR env/web.env` and change only the one line it has (must match admin.env's value
      exactly — `apps/web` holds no S3 credential at all, only this base URL):
      ```
      STORAGE_PUBLIC_BASE_URL=https://img.ammari.my.id
      ```
   5. `exit` back to `ubuntu`, then to your Mac, once both files are saved.
4. `docker compose up -d --force-recreate admin web` (as `deploy`, still in `/opt/ammari` — dev
   has no blue/green, so this is the normal env-change recreate; `docs/deploy.md` has no
   numbered section for it, but it's the same operation as prod's §3.2).
5. Verify, in order:
   1. `docker compose logs --tail 50 admin` — confirm no `S3_*`/storage error on startup.
   2. `pnpm --filter @ammari/storage storage:check` (point its `--env-file` at a local copy of
      the updated `apps/admin/.env` values, or run it inside the admin container against the
      real env — same command either way) must print "Public read works."
   3. Do one real upload through the admin UI (any product image) and confirm it renders on
      `https://ammari.my.id` — the `<img src>` should now resolve under `img.ammari.my.id`, not
      the old Cloudeka host.
   4. `docker compose logs admin | grep upload-timing` for that upload's `[upload-timing]`
      line — confirm it's now low-hundreds-of-milliseconds, not the multi-second-to-two-minute
      Cloudeka stalls `docs/deploy-prod.md`'s troubleshooting section documents. This is the
      actual regression check for the reason this migration exists (see "Summary" above).
6. **Existing DB rows that still point at the old Cloudeka bucket:** nothing to migrate, per
   "Existing data" above — every `product_images`/content-image row keeps whatever Cloudeka
   `storageKey` it already has, and its `<img>` now 404s (broken image icon) until someone
   re-uploads that specific image through the admin UI, which mints a fresh key in the new R2
   bucket and deletes the old row. Expected and fine for dev's test data; no bulk fix, script,
   or migration needed — just re-upload each broken image once, same action an owner would take
   for any broken image today.
7. Only once step 5 is confirmed, move to prod.

**Prod:**
1. Complete the owner checklist's prod media bucket + prod backups bucket + tokens + custom domain
   steps (if not already done alongside dev's).
2. `make-prod-env.sh --storage-only` (Session 3's new mode) — edits the EXISTING
   `prod-admin.env`/`prod-web.env`/`prod-backup.env` in place, changing only the `S3_*`/
   `BACKUP_S3_*` lines to the R2 values (reading `r2-prod-access-key`/`r2-prod-secret-key`/
   `r2-backups-access-key`/`r2-backups-secret-key` from `~/ammari-secrets`, never prompted).
   Every other line — every auth/session/encryption secret, `PG_BACKUP_ENCRYPTION_KEY` — stays
   byte-for-byte identical; a timestamped backup of each file it touches is made first. **Do
   not** use `--force` here: that mode regenerates *every* secret fresh (`openssl rand` for all
   of them, not just the storage ones), which would rotate `STAFF_BETTER_AUTH_SECRET` etc. too
   and log out every staff session for no reason. `--force` is only for building the four files
   from scratch the first time (or deliberately rotating everything); `--storage-only` is the
   one that exists specifically for this migration.
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
