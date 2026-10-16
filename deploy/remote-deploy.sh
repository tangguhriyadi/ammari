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

# Picks up a changed Caddyfile/cert volume without restarting the caddy container — `up -d`
# alone won't notice a bind-mounted file changed on disk (only an image/env/command diff
# triggers a recreate), so a deploy that touched deploy/Caddyfile would otherwise silently keep
# serving the OLD config until something else restarted the container. Safe to run every
# deploy even when nothing changed (reload is a no-op against an identical config).
echo "==> Reloading Caddy config"
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile

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
