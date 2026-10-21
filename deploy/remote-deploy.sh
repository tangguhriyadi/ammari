#!/usr/bin/env bash
# Runs ON the VPS (docs/deploy.md), invoked over SSH by .github/workflows/deploy-dev.yml (and by
# hand, for a manual rollback: re-run with an older SHA — see the runbook). Expects to be run
# from /opt/ammari, with this repo's deploy/ directory already synced there. Never run with
# `set -x` in CI logs — image tags are fine to log, but there's no reason to also echo the full
# `docker run --env-file` command line.
#
# ADMIN_IMAGE_TAG / WEB_IMAGE_TAG / MIGRATOR_IMAGE_TAG: the commit SHA to deploy. For a normal
# deploy these are all the same SHA; a rollback passes an older SHA for all three (never a mix —
# CLAUDE.md's new migration backward-compatibility rule exists so that an older app SHA is
# always safe against whatever the CURRENT schema is, and the migrator for that older SHA is
# never re-run on rollback, only the app images are swapped back).
#
# The workflow's `retag` job (docs/deploy.md's "Image tagging scheme") guarantees all three
# images exist under the same SHA for any commit that reached this script via a normal deploy —
# but we still verify before pulling: a hand-run rollback to a SHA from before that job existed,
# or any other way this script gets invoked outside the workflow, could still name a SHA that's
# missing one of the three.
set -euo pipefail

: "${ADMIN_IMAGE_TAG:?set ADMIN_IMAGE_TAG to the commit SHA to deploy}"
: "${WEB_IMAGE_TAG:?set WEB_IMAGE_TAG to the commit SHA to deploy}"
: "${MIGRATOR_IMAGE_TAG:?set MIGRATOR_IMAGE_TAG to the commit SHA to deploy}"

REGISTRY="ghcr.io/tangguhriyadi"
cd "$(dirname "$0")"

# The cron service's env file (docker-compose.yml `cron`, docs/plans/cart-checkout.md §6.3) lives
# only on this server, like env/web.env. Compose refuses to load the project at all when an
# env_file is missing, so a deploy that arrives before the owner created it must not break every
# other service: create it empty (owner-only), which just idles the cron loop until
# INTERNAL_CRON_SECRET is filled in. Never overwrites an existing file.
if [ ! -e env/cron.env ]; then
  echo "==> env/cron.env missing: creating it empty (the cron service idles until INTERNAL_CRON_SECRET is set)"
  (umask 077 && : > env/cron.env)
fi

echo "==> Verifying images exist before touching anything (admin=$ADMIN_IMAGE_TAG web=$WEB_IMAGE_TAG migrator=$MIGRATOR_IMAGE_TAG)"
missing=0
for ref in \
  "$REGISTRY/ammari-admin:$ADMIN_IMAGE_TAG" \
  "$REGISTRY/ammari-web:$WEB_IMAGE_TAG" \
  "$REGISTRY/ammari-migrator:$MIGRATOR_IMAGE_TAG"
do
  if ! DOCKER_CLI_EXPERIMENTAL=enabled docker manifest inspect "$ref" >/dev/null 2>&1; then
    echo "==> MISSING: $ref does not exist in GHCR" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "==> Aborting before pulling or touching anything: one or more images listed above are missing" >&2
  exit 1
fi

echo "==> Pulling images (admin=$ADMIN_IMAGE_TAG web=$WEB_IMAGE_TAG migrator=$MIGRATOR_IMAGE_TAG)"
docker pull "$REGISTRY/ammari-admin:$ADMIN_IMAGE_TAG"
docker pull "$REGISTRY/ammari-web:$WEB_IMAGE_TAG"
docker pull "$REGISTRY/ammari-migrator:$MIGRATOR_IMAGE_TAG"

# Migrations run as a separate step BEFORE the new app containers start, and a non-zero exit
# here aborts the whole deploy — the running containers (old images, old schema expectations)
# are never touched if this fails (docs/SPEC.md §2.3).
echo "==> Running migrations"
docker run --rm --env-file env/admin.env "$REGISTRY/ammari-migrator:$MIGRATOR_IMAGE_TAG"

echo "==> Updating image tags"
{
  echo "ADMIN_IMAGE_TAG=$ADMIN_IMAGE_TAG"
  echo "WEB_IMAGE_TAG=$WEB_IMAGE_TAG"
} > .env

echo "==> docker compose up -d"
docker compose up -d
# Recreated every deploy (a tiny curl container): picks up a changed cron/cron.sh or env/cron.env,
# which a plain `up -d` would not notice for a bind-mounted script.
# --no-deps: never restart web a second time (cron depends_on web).
docker compose up -d --no-deps --force-recreate cron

# Picks up a changed Caddyfile/cert volume without restarting the caddy container — `up -d`
# alone won't notice a bind-mounted file changed on disk (only an image/env/command diff
# triggers a recreate), so a deploy that touched deploy/caddy/Caddyfile would otherwise silently
# keep serving the OLD config until something else restarted the container. Safe to run every
# deploy even when nothing changed (reload is a no-op against an identical config).
#
# Session 10: a plain `caddy reload` is NOT enough to trust on its own — confirmed real on THIS
# environment: the host file had new content, `caddy reload` reported success, but the caddy
# CONTAINER's own `/etc/caddy/Caddyfile` still had the old content, because the Caddyfile used
# to be a single-file bind mount (binds to that file's INODE, not its path — rsync's default
# replace-via-rename swaps the inode, and a single-file mount never re-resolves to the new one).
# Fixed structurally by mounting `./caddy` as a whole DIRECTORY (docker-compose.yml), which
# doesn't have this problem — but this script still verifies that before trusting a reload, and
# recreates the container instead if it's ever wrong again for any other reason: compare the
# container's own sha256 of these files against the host's; if they already match, trust a plain
# reload; if they don't, a reload would just re-read the same stale path, so recreate instead;
# then verify again (fatal if it still doesn't match — this is the one check in here that can
# ever abort the deploy), and finally cross-check Caddy's actual in-memory running config via
# its admin API (`http://127.0.0.1:2019/config/` — loopback-only inside the container; nothing
# to do with the public ammari.my.id/admin.ammari.my.id site blocks' client_auth, so AOP is not
# a problem for this check the way it would be for curling a real public path). Checks the LIVE
# config contains the expected header VALUES, rather than a byte-for-byte hash against a
# freshly-`caddy adapt`ed copy — tried the hash approach first and it produced false mismatches
# against this real Caddyfile even right after a clean reload, with no actual problem: Caddy's
# provisioned runtime graph restructures `handle_errors` nesting in a way plain re-adapting
# doesn't reproduce, so an exact hash compare is the wrong tool here. This second check is
# advisory only, never fatal: the sha256 content-match above is the authoritative signal (it
# directly confirms the running container's filesystem holds byte-identical content to what's
# on disk); if the admin API cross-check can't independently confirm the expected headers are
# actually live, that's logged as inconclusive, not as a broken deploy.
caddy_hash="$(cat caddy/Caddyfile cloudflare/*.caddy 2>/dev/null | sha256sum | cut -d' ' -f1)"
caddy_container_matches_host() {
  local container_hash
  container_hash="$(docker compose exec -T caddy sh -c \
    'cat /etc/caddy/Caddyfile /etc/caddy/cloudflare/*.caddy 2>/dev/null | sha256sum | cut -d" " -f1' \
    2>/dev/null || true)"
  [ -n "$container_hash" ] && [ "$container_hash" = "$caddy_hash" ]
}
caddy_live_config_has_expected_headers() {
  local live
  live="$(docker compose exec -T caddy curl -s http://127.0.0.1:2019/config/ 2>/dev/null || true)"
  [ -n "$live" ] || return 1
  grep -q '"Strict-Transport-Security":\["max-age=31536000; includeSubDomains"\]' <<<"$live" || return 1
  grep -q '"X-Frame-Options":\["SAMEORIGIN"\]' <<<"$live" || return 1  # ammari.my.id
  grep -q '"X-Frame-Options":\["DENY"\]' <<<"$live" || return 1        # admin.ammari.my.id
}
echo "==> Reloading Caddy config"
if ! docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
  echo "==> Caddyfile is INVALID — aborting before touching the live config (the currently-running config is untouched)" >&2
  exit 1
fi
if caddy_container_matches_host; then
  echo "==> caddy container's own filesystem already matches the host — reloading"
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
else
  echo "==> caddy container's own filesystem does NOT match the host — a reload would just re-read the same (possibly stale) bind-mounted path, so recreating the caddy container instead"
  docker compose up -d --force-recreate caddy
fi
if ! caddy_container_matches_host; then
  echo "==> FATAL: caddy container still doesn't see the current config even after a recreate — something deeper is wrong with the caddy volume mounts, not just a one-off staleness. The deploy is broken, not just inconclusive." >&2
  exit 1
fi
echo "==> Caddy's own filesystem matches the current config (verified via sha256) — deploy state is confirmed live"
if caddy_live_config_has_expected_headers; then
  echo "==> Caddy's live in-memory config (via the admin API) actually contains the expected per-host security headers — fully confirmed, not just inconclusive"
else
  echo "==> NOTE: verification inconclusive — could not independently confirm via Caddy's admin API that the live in-memory config has the expected headers (the file-level check above already passed, which is the authoritative signal here; this does not mean the deploy is broken)"
fi

poll_health() {
  local service="$1" attempt
  for attempt in $(seq 1 10); do
    if docker compose exec -T "$service" node -e \
      "require('http').get('http://127.0.0.1:3000/api/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
    then
      echo "==> $service healthy"
      return 0
    fi
    echo "==> $service not healthy yet (attempt $attempt/10), retrying..."
    sleep 3
  done
  echo "==> $service FAILED health check after deploy" >&2
  # Without this, the Actions log just shows "FAILED" with no way to tell WHY from CI — the
  # first real dev deploy hit exactly this (both services unhealthy) and the actual cause
  # (HOSTNAME binding, see apps/admin/Dockerfile's/apps/web/Dockerfile's own comments) only
  # became visible by SSHing in and running these two commands by hand.
  local container
  container="$(docker compose ps -q "$service" || true)"
  if [ -n "$container" ]; then
    echo "==> $service: last 80 log lines" >&2
    docker logs --tail 80 "$container" >&2 2>&1 || true
    echo "==> $service: Docker's own HEALTHCHECK log" >&2
    docker inspect --format '{{json .State.Health.Log}}' "$container" >&2 2>&1 || true
  else
    echo "==> $service: no container found for 'docker compose ps -q $service'" >&2
  fi
  return 1
}

poll_health admin
poll_health web

echo "==> Deploy complete: admin=$ADMIN_IMAGE_TAG web=$WEB_IMAGE_TAG"

# --- Image cleanup (runs only after the health checks above have already passed) --------------
# Keeps local disk from filling up: every deploy pulls three fresh SHA-tagged images and nothing
# ever removed the old ones (observed: 34 images, ~10GB, 9.4GB reclaimable after one day of dev
# deploys on this VPS's 40GB disk). Keeps the currently-deployed SHA plus the previous
# KEEP_COUNT-1 deployed SHAs (for fast rollback, see docs/deploy.md's Rollback section), and
# removes older ammari-admin/web/migrator images plus dangling layers. Never touches volumes,
# never runs `docker system prune --volumes`, and never touches `caddy` (not an `ammari-*`
# image, so it's outside every command below by construction).
#
# "Previously deployed" is tracked explicitly in DEPLOY_HISTORY_FILE (one SHA per successful
# deploy, appended below) rather than inferred from image creation/pull date: a rollback
# re-pulls an OLDER sha, which would otherwise look "newest by pull time" and evict the actually-
# newest images still needed for a fast roll-forward — exactly backwards from what rollback
# needs. `$(dirname "$0")` at the top of this script already `cd`s here, so this relative path
# resolves to /opt/ammari/deploy-history.log in the real deploy layout; it's never in the repo
# (deploy/ has no such file to sync), so the deploy job's `rsync` (no `--delete`) leaves it alone
# on every sync, same as env/ and caddy/certs/.
DEPLOY_HISTORY_FILE="deploy-history.log"
KEEP_COUNT=5

# A failure anywhere in here must only warn, never fail an already-successful deploy — the
# whole thing runs in its own subshell with `set +e` so no internal command can trip this
# script's own `set -e`, regardless of how `cleanup_old_images` ends up being invoked below.
cleanup_old_images() (
  set +e
  set -u

  # ADMIN_IMAGE_TAG is the canonical deployed SHA for this run: a normal deploy and a rollback
  # both set all three *_IMAGE_TAG vars to the same SHA (see the file-level comment on why a mix
  # is never valid), so recording just this one identifies "this deploy" in history.
  echo "$ADMIN_IMAGE_TAG" >> "$DEPLOY_HISTORY_FILE"

  # Most-recent-first, deduplicated, capped at KEEP_COUNT: `tac` walks the history newest-line-
  # first, so the first time a given SHA is seen is always its MOST RECENT deploy — which is
  # exactly right for a rollback re-deploying an older SHA: it gets promoted back to "current".
  keep_shas="$(tac "$DEPLOY_HISTORY_FILE" | awk '!seen[$0]++' | head -n "$KEEP_COUNT")"

  # Trim the history file to just what retention needs going forward, so it never grows
  # unbounded either.
  printf '%s\n' "$keep_shas" > "${DEPLOY_HISTORY_FILE}.tmp" && mv "${DEPLOY_HISTORY_FILE}.tmp" "$DEPLOY_HISTORY_FILE"

  echo "==> Keeping images for SHAs: $(tr '\n' ' ' <<< "$keep_shas")"

  failed=0
  for image in ammari-admin ammari-web ammari-migrator; do
    # Only ever lists LOCAL images already tagged "ghcr.io/tangguhriyadi/$image:<sha>" by a
    # previous `docker pull` in this script — this is what keeps the scope to exactly the three
    # images this script itself manages.
    while IFS=: read -r repo tag; do
      [ -z "$tag" ] && continue
      if [ "$tag" = "dev-latest" ]; then
        continue # this script never pulls :dev-latest, but skip it defensively anyway
      fi
      if ! grep -qx "$tag" <<< "$keep_shas"; then
        echo "==> Removing old image $repo:$tag"
        if ! docker rmi "$repo:$tag" >/dev/null 2>&1; then
          echo "==> WARNING: could not remove $repo:$tag (may still be in use)" >&2
          failed=1
        fi
      fi
    done < <(docker images --format '{{.Repository}}:{{.Tag}}' "ghcr.io/tangguhriyadi/$image")
  done

  echo "==> Pruning dangling (untagged) images"
  # No `-a`/`--all` and no `--volumes`: only ever removes dangling images, never a tagged image
  # (like `caddy:2.10.2` or anything just kept above) and never a volume.
  if ! docker image prune -f >/dev/null 2>&1; then
    echo "==> WARNING: docker image prune failed" >&2
    failed=1
  fi

  exit "$failed"
)

echo "==> Cleaning up old local images (keeping current + previous $((KEEP_COUNT - 1)) deployed SHAs)"
if ! cleanup_old_images; then
  echo "==> WARNING: image cleanup had errors — deploy still succeeded; check disk usage manually (docs/deploy.md's 'Image retention and disk space')" >&2
fi
