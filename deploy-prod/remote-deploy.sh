#!/usr/bin/env bash
# Runs ON the prod VPS (docs/deploy-prod.md), as user `deploy` from /opt/ammari-prod, invoked
# over SSH by .github/workflows/deploy-prod.yml (Session 4 — not yet built) and by hand for a
# rollback. Never run with `set -x` in CI logs — image tags are fine to log, the full
# `docker run --env-file` command line is not.
#
# Usage: remote-deploy.sh <sha> [--skip-migrate]
#   <sha>            Target commit SHA — same images/tags dev already pushes to GHCR, reused
#                     as-is (docs/plans/prod-deploy.md §2 "Image tags" row). Validated below
#                     against the SAME strict hex-SHA regex deploy-dev.yml's "Resolve target SHA"
#                     step uses, for the same reason: this value ends up embedded directly in
#                     `docker run`/`docker pull` arguments, so a free-form string here is a
#                     command-injection sink, not just a cosmetic format check.
#   --skip-migrate   ROLLBACK ONLY. Re-running this script with an older <sha> and this flag
#                     redeploys the already-pushed images for that SHA without re-running the
#                     migrator — CLAUDE.md's migration backward-compatibility rule is exactly
#                     what makes an older app SHA safe against whatever schema is currently live.
#                     Never pass this on a normal forward deploy.
#
# Mechanics (docs/plans/prod-deploy.md §3 Session 3):
#   1. Verify all three images (admin/web/migrator) exist at <sha> in GHCR — before touching
#      anything, same pattern as deploy/remote-deploy.sh (dev).
#   2. Bring up `db` (idempotent — a no-op if it's already running) and wait for it to report
#      healthy via Docker's own HEALTHCHECK (docker-compose.yml's `pg_isready` test), not a
#      host-side pg_isready call — avoids needing Postgres credentials on the host at all.
#   3. Run the migrator once, against `db` over the `ammari-prod_internal` network, UNLESS
#      --skip-migrate — abort the whole deploy before touching any app container on failure.
#   4. Bring up `caddy` (idempotent) so every app slot — including a brand-new bootstrap slot —
#      can be verified end-to-end through Caddy's own routing, not just by curling the
#      container directly.
#   5. For admin, then web (SEQUENTIAL, never both at once — docs/plans/prod-deploy.md §1's
#      revised ~3.0 GiB usable-RAM budget is what makes this the default, not a fallback): if
#      that app is already running the target SHA, skip it entirely. Otherwise start the
#      inactive slot (or, on that app's first-ever deploy, its "blue" slot — there is no
#      "inactive" slot yet), health-check it directly, flip Caddy's generated upstream snippet
#      and reload, re-verify end-to-end through Caddy, then (only once that passes) stop the old
#      slot and commit the new active slot + deployed SHA to disk. A failed health check at
#      EITHER stage stops the new slot, leaves the old slot (if any) serving, leaves the upstream
#      snippet unchanged, and exits non-zero with the container's own logs attached — it never
#      silently limps forward.
#   6. Image retention: keep the current + previous 4 deployed SHAs (5 total) for admin/web/
#      migrator; never touches the `caddy`/`pgvector` images or any volume. Same logic as dev's
#      `deploy/remote-deploy.sh`, adapted for this script's own deploy-history file.
#
# Per-app state, under /opt/ammari-prod (this directory — never synced from the repo, never
# deleted by a normal rsync-without---delete the way env/ and caddy/certs/ already aren't):
#   active-slot-admin, active-slot-web     "blue" or "green" — which slot Caddy currently points
#                                           at for that app. Absence means that app has never
#                                           been deployed yet (first-ever deploy for it).
#   deployed-sha-admin, deployed-sha-web   The commit SHA currently live for that app — this is
#                                           how "whose image actually changed this deploy" (the
#                                           plan's own phrase for what gates a flip) is decided,
#                                           without needing to inspect running containers' image
#                                           tags by hand.
#   deploy-history.log                     One line per completed run's target SHA, newest
#                                           appended last — feeds image retention (cleanup_old_
#                                           images below), same shape as dev's own file.
#
# Why health checks can verify "through Caddy" at all despite zone-level Authenticated Origin
# Pulls: every PUBLIC site block in deploy-prod/Caddyfile requires the Cloudflare client
# certificate, which this VPS deliberately never holds (only the CA root does —
# deploy-prod/cloudflare/README.md). Caddyfile (Session 2) was extended with two bare-port,
# plain-HTTP, never-published internal listeners (`:8080` for web, `:8081` for admin) that import
# the SAME generated upstream snippet as the real public hosts — reachable only via
# `docker compose exec caddy curl ...` from inside this one container, never from outside it.
# That's what poll_health_through_caddy below actually hits.
#
# Memory check (docs/plans/prod-deploy.md §3 Session 3, required before this ships): verified
# locally against deploy-prod/docker-compose.yml (unmodified) with a deploy that changes both
# admin and web in the same run. Sampling `docker ps` every 0.2s through the whole run confirmed
# the set of simultaneously-RUNNING app-slot containers never exceeded 3 (admin's blue+green
# briefly overlapped while web stayed on its single old slot, then — after admin's old slot was
# already stopped — web's blue+green briefly overlapped while admin stayed on its single new
# slot; the 4-way admin-blue+admin-green+web-blue+web-green state never occurred). Byte-level
# RSS wasn't measured off a real Next.js build in this dry run (throwaway stand-in containers, a
# few MB each, aren't a meaningful proxy for that), but the bound that actually matters is this
# file's own `mem_limit`s, which cap usage regardless of what's inside: 3 × 450m (app) + 768m
# (db) + 128m (caddy) = 2246 MB ≈ 2.2 GiB peak-by-construction during the overlap window,
# comfortably under the ~2.4 GB target (docs/plans/prod-deploy.md §1).
set -euo pipefail

TARGET_SHA="${1:-}"
SKIP_MIGRATE=false
case "${2:-}" in
  "") ;;
  --skip-migrate) SKIP_MIGRATE=true ;;
  *)
    echo "Unknown argument: $2" >&2
    echo "Usage: $0 <sha> [--skip-migrate]" >&2
    exit 1
    ;;
esac

if [ -z "$TARGET_SHA" ]; then
  echo "Usage: $0 <sha> [--skip-migrate]" >&2
  exit 1
fi
# Same strict hex-SHA format check as deploy-dev.yml's "Resolve target SHA" step — this value is
# embedded directly into `docker pull`/`docker run` arguments below, so validating the shape
# closes an injection sink, not just a cosmetic format check.
if ! [[ "$TARGET_SHA" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "sha must be a hex commit SHA (7-40 lowercase hex chars), got: $TARGET_SHA" >&2
  exit 1
fi

REGISTRY="ghcr.io/tangguhriyadi"
# Matches docker-compose.yml's `name: ammari-prod` — Compose derives the actual network name as
# "<project name>_<network key>", and this script's migrator `docker run --network` call and
# every `point_web_alias` call below need the real name, not just "internal".
NETWORK="ammari-prod_internal"
cd "$(dirname "$0")"

echo "==> Verifying images exist before touching anything (sha=$TARGET_SHA)"
missing=0
for image in ammari-admin ammari-web ammari-migrator; do
  ref="$REGISTRY/$image:$TARGET_SHA"
  if ! DOCKER_CLI_EXPERIMENTAL=enabled docker manifest inspect "$ref" >/dev/null 2>&1; then
    echo "==> MISSING: $ref does not exist in GHCR" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "==> Aborting before pulling or touching anything: one or more images listed above are missing" >&2
  exit 1
fi

echo "==> Pulling images (sha=$TARGET_SHA)"
docker pull "$REGISTRY/ammari-admin:$TARGET_SHA"
docker pull "$REGISTRY/ammari-web:$TARGET_SHA"
docker pull "$REGISTRY/ammari-migrator:$TARGET_SHA"

echo "==> Bringing up db (no-op if already running)"
docker compose up -d db

wait_for_db_healthy() {
  local attempt cid status
  for attempt in $(seq 1 40); do
    cid="$(docker compose ps -q db || true)"
    if [ -n "$cid" ]; then
      status="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "")"
      if [ "$status" = "healthy" ]; then
        echo "==> db healthy"
        return 0
      fi
    fi
    echo "==> waiting for db to become healthy (attempt $attempt/40)..."
    sleep 2
  done
  echo "==> db FAILED to become healthy" >&2
  return 1
}
wait_for_db_healthy

if [ "$SKIP_MIGRATE" = true ]; then
  echo "==> --skip-migrate set: NOT running the migrator (rollback path — never re-run migrations on rollback, CLAUDE.md)"
else
  echo "==> Running migrations against db (network: $NETWORK)"
  # Foreground, no --rm race with `set -e`: a non-zero exit here aborts the whole deploy before
  # any app container is touched, same guarantee as dev's own migrator step (docs/deploy.md).
  if ! docker run --rm --network "$NETWORK" --env-file env/admin.env \
    "$REGISTRY/ammari-migrator:$TARGET_SHA"; then
    echo "==> Migrator FAILED — aborting the whole deploy before touching any app container" >&2
    exit 1
  fi
fi

echo "==> Bringing up caddy (no-op if already running)"
docker compose up -d caddy

write_snippet() {
  local admin_slot="$1" web_slot="$2"
  cat > caddy/active-upstream.caddy <<EOF
# GENERATED by deploy-prod/remote-deploy.sh on every deploy/slot flip — do not hand-edit, the
# next deploy overwrites this file. See the checked-in version of this file (git history) for
# the full explanation of what imports it and why.
(active_upstream_web) {
	reverse_proxy web-${web_slot}:3000
}

(active_upstream_admin) {
	reverse_proxy admin-${admin_slot}:3000
}
EOF
}

# Rewrites the snippet with ONE app's slot overridden, reading the other app's current slot from
# its own active-slot file (defaulting to "blue" — the checked-in default — for an app that
# hasn't been bootstrapped yet). Safe to call mid-flip: by the time web's flip runs, admin's
# active-slot file (if admin flipped this run) has already been committed, so this always
# reflects reality, never a stale in-memory value.
write_snippet_for() {
  local changed_app="$1" changed_slot="$2"
  local admin_slot web_slot
  admin_slot="$(cat active-slot-admin 2>/dev/null || echo blue)"
  web_slot="$(cat active-slot-web 2>/dev/null || echo blue)"
  if [ "$changed_app" = "admin" ]; then admin_slot="$changed_slot"; else web_slot="$changed_slot"; fi
  write_snippet "$admin_slot" "$web_slot"
}

# Persists this one slot's image tag into Compose's own `.env` file (auto-loaded from this
# directory — never synced from the repo, matches the root .gitignore's blanket `.env*` rule),
# which is what docker-compose.yml's `${ADMIN_BLUE_IMAGE_TAG}`-style image references actually
# resolve against. Rewrites only this one KEY=VALUE line, preserving every other slot's
# currently-recorded tag (including the one belonging to the slot NOT being touched by this
# deploy) so a later deploy that flips back to it still starts the right image.
set_image_tag_env() {
  local app="$1" slot="$2" sha="$3" key tmp
  key="$(printf '%s_%s_IMAGE_TAG' "$app" "$slot" | tr '[:lower:]' '[:upper:]')"
  tmp=".env.tmp.$$"
  if [ -f .env ]; then
    grep -v "^${key}=" .env > "$tmp" || true
  else
    : > "$tmp"
  fi
  echo "${key}=${sha}" >> "$tmp"
  mv "$tmp" .env
}

reload_caddy() {
  # Picks up the rewritten active-upstream.caddy with no downtime — same no-downtime reload
  # pattern dev already uses for any Caddyfile/config change (deploy/remote-deploy.sh).
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
}

dump_container_logs() {
  local service="$1" container
  container="$(docker compose ps -q "$service" || true)"
  if [ -n "$container" ]; then
    echo "==> $service: last 80 log lines" >&2
    docker logs --tail 80 "$container" >&2 2>&1 || true
    echo "==> $service: Docker's own HEALTHCHECK log" >&2
    docker inspect --format '{{json .State.Health.Log}}' "$container" >&2 2>&1 || true
  else
    echo "==> $service: no container found for 'docker compose ps -q $service'" >&2
  fi
}

poll_health_container() {
  local service="$1" attempt
  for attempt in $(seq 1 10); do
    if docker compose exec -T "$service" node -e \
      "require('http').get('http://127.0.0.1:3000/api/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
    then
      echo "==> $service healthy (direct)"
      return 0
    fi
    echo "==> $service not healthy yet (attempt $attempt/10), retrying..."
    sleep 3
  done
  echo "==> $service FAILED health check (direct)" >&2
  dump_container_logs "$service"
  return 1
}

poll_health_through_caddy() {
  local app="$1" port attempt
  # :8080/:8081 are the internal-only plain-HTTP listeners added to deploy-prod/Caddyfile
  # (Session 3) specifically so this script can verify its own just-flipped reverse_proxy
  # upstream end-to-end without the Cloudflare client certificate this VPS never holds.
  if [ "$app" = "web" ]; then port=8080; else port=8081; fi
  for attempt in $(seq 1 10); do
    if docker compose exec -T caddy curl -sf "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
      echo "==> $app healthy (through Caddy)"
      return 0
    fi
    echo "==> $app not healthy through Caddy yet (attempt $attempt/10), retrying..."
    sleep 3
  done
  echo "==> $app FAILED health check through Caddy" >&2
  dump_container_logs "caddy"
  return 1
}

# Repoints the floating internal "web" network alias (deploy-prod/env/admin.env's
# WEB_INTERNAL_URL=http://web:3000 — admin's /api/revalidate calls use this, never Caddy) at
# whichever web slot is now active. A container already attached to a network can't just have
# an alias added to it — Docker requires disconnect+reconnect to change aliases — but the
# container's own name/service-name alias (e.g. "web-green") is restored automatically on
# reconnect regardless, so this never breaks Caddy's OWN reverse_proxy, which always addresses
# slots by their literal "web-blue"/"web-green" name, never by this alias. Admin-only concept:
# nothing calls into "admin" over this kind of floating alias, so this is never called for app
# "admin".
point_web_alias() {
  # `docker network connect/disconnect` take an actual container name/ID, not a Compose SERVICE
  # name — Compose's own "web-blue"/"web-green" aliases (what Caddy's reverse_proxy addresses,
  # confirmed working above) are a separate mechanism it sets up automatically and are unrelated
  # to this call's own argument requirements, hence resolving the real container ID here via
  # `compose ps -q` rather than passing $1/$2 straight through.
  local new_c="$1" old_c="${2:-}" new_cid old_cid
  new_cid="$(docker compose ps -q "$new_c")"
  echo "==> repointing internal 'web' alias to $new_c"
  docker network disconnect "$NETWORK" "$new_cid" >/dev/null 2>&1 || true
  # Explicitly re-add the service-name alias ("web-blue"/"web-green") too — Compose set that one
  # up at container-create time as part of its own network attachment, and a manual disconnect+
  # reconnect does NOT restore it automatically; losing it would break Caddy's own reverse_proxy
  # (which always addresses slots by this literal name) on any LATER reload, even though this
  # particular deploy's own already-passed through-Caddy check ran before this disconnect.
  docker network connect --alias web --alias "$new_c" "$NETWORK" "$new_cid"
  if [ -n "$old_c" ]; then
    old_cid="$(docker compose ps -q "$old_c")"
    if [ -n "$old_cid" ]; then
      # Drop the "web" alias from the old slot by disconnecting and reconnecting it WITHOUT that
      # alias — but it must be reconnected, not left fully detached: $old_c is only stopped, not
      # removed, and a stopped container's network attachment is NOT restored by a later
      # `docker compose up -d` the next time this slot is reused (compose just calls `docker
      # start` on an existing container; it doesn't re-attach networks). Leaving it fully
      # disconnected here would make a future flip BACK to this slot pass its own direct
      # health-check (that one runs `docker compose exec`, inside the container's own network
      # namespace, unaffected) while failing invisibly through Caddy, which needs real DNS/network
      # reachability to reach it by name. Confirmed by hitting exactly this failure mode before
      # this comment was written.
      docker network disconnect "$NETWORK" "$old_cid" >/dev/null 2>&1 || true
      docker network connect --alias "$old_c" "$NETWORK" "$old_cid"
    fi
  fi
}

# Handles both a routine blue<->green flip AND that app's first-ever deploy (bootstrap) with the
# same logic: bootstrap is just "flip from no slot to blue" — there is no old slot to health-check
# against beforehand, to stop afterward, or to revert to on failure, but every other step
# (start -> health-check direct -> flip Caddy -> health-check through Caddy -> commit state) is
# identical. See the file-level comment's §5 for the full step list this implements.
process_app() {
  local app="$1"
  local active_file="active-slot-$app" sha_file="deployed-sha-$app"
  local old_slot="" old_c=""

  if [ -f "$active_file" ]; then
    local deployed_sha
    deployed_sha="$(cat "$sha_file" 2>/dev/null || echo "")"
    if [ "$deployed_sha" = "$TARGET_SHA" ]; then
      echo "==> [$app] already at $TARGET_SHA, nothing to do"
      return 0
    fi
    old_slot="$(cat "$active_file")"
    if [ "$old_slot" != "blue" ] && [ "$old_slot" != "green" ]; then
      echo "==> [$app] $active_file contains '$old_slot', not 'blue'/'green' — refusing to guess which slot is really active" >&2
      exit 1
    fi
    old_c="${app}-${old_slot}"
  else
    echo "==> [$app] no active slot on record — first-ever deploy for this app"
  fi

  local new_slot new_c
  if [ "$old_slot" = "blue" ]; then new_slot=green; else new_slot=blue; fi
  new_c="${app}-${new_slot}"

  echo "==> [$app] starting $new_c on $TARGET_SHA"
  set_image_tag_env "$app" "$new_slot" "$TARGET_SHA"
  docker compose up -d "$new_c"

  if ! poll_health_container "$new_c"; then
    echo "==> [$app] health check FAILED on $new_c (direct) — stopping it$( [ -n "$old_c" ] && echo ", $old_c keeps serving" ), upstream left unchanged" >&2
    docker compose stop "$new_c" >/dev/null 2>&1 || true
    exit 1
  fi

  echo "==> [$app] pointing Caddy upstream at $new_c"
  write_snippet_for "$app" "$new_slot"
  reload_caddy

  if ! poll_health_through_caddy "$app"; then
    echo "==> [$app] health check FAILED through Caddy" >&2
    if [ -n "$old_c" ]; then
      echo "==> [$app] reverting upstream to $old_c" >&2
      write_snippet_for "$app" "$old_slot"
      reload_caddy
    fi
    echo "==> [$app] stopping $new_c" >&2
    docker compose stop "$new_c" >/dev/null 2>&1 || true
    exit 1
  fi

  if [ "$app" = "web" ]; then
    point_web_alias "$new_c" "$old_c"
  fi

  if [ -n "$old_c" ]; then
    echo "==> [$app] stopping old slot $old_c"
    docker compose stop "$old_c"
  fi

  echo "$new_slot" > "$active_file"
  echo "$TARGET_SHA" > "$sha_file"
  echo "==> [$app] now serving from $new_c ($TARGET_SHA)"
}

# SEQUENTIAL by design (docs/plans/prod-deploy.md §1/§3): admin is fully resolved — including
# the old slot being stopped — before web's flip starts. At most one app ever runs two slots at
# once; peak is 3 app containers (the other app's single slot + this app's old+new), never 4.
process_app admin
process_app web

echo "==> Deploy complete: sha=$TARGET_SHA (admin=$(cat active-slot-admin), web=$(cat active-slot-web))"

# --- Image cleanup (runs only after both apps above have already resolved successfully) --------
# Keeps local disk from filling up. Keeps the currently-deployed SHA plus the previous
# KEEP_COUNT-1 deployed SHAs (for fast rollback), removes older ammari-admin/web/migrator images
# plus dangling layers. Never touches volumes, never runs `docker system prune --volumes`, and
# never touches `caddy`/`pgvector` (not `ammari-*` images, so outside every command below by
# construction). Same logic as deploy/remote-deploy.sh (dev), adapted for this directory's own
# history file.
DEPLOY_HISTORY_FILE="deploy-history.log"
KEEP_COUNT=5

cleanup_old_images() (
  set +e
  set -u

  echo "$TARGET_SHA" >> "$DEPLOY_HISTORY_FILE"

  # Most-recent-first, deduplicated, capped at KEEP_COUNT: `tac` walks the history newest-line-
  # first, so the first time a given SHA is seen is always its MOST RECENT deploy — exactly
  # right for a rollback re-deploying an older SHA: it gets promoted back to "current".
  keep_shas="$(tac "$DEPLOY_HISTORY_FILE" | awk '!seen[$0]++' | head -n "$KEEP_COUNT")"

  printf '%s\n' "$keep_shas" > "${DEPLOY_HISTORY_FILE}.tmp" && mv "${DEPLOY_HISTORY_FILE}.tmp" "$DEPLOY_HISTORY_FILE"

  echo "==> Keeping images for SHAs: $(tr '\n' ' ' <<< "$keep_shas")"

  failed=0
  for image in ammari-admin ammari-web ammari-migrator; do
    while IFS=: read -r repo tag; do
      [ -z "$tag" ] && continue
      if [ "$tag" = "prod-latest" ]; then
        continue # this script never pulls :prod-latest, but skip it defensively anyway
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
  if ! docker image prune -f >/dev/null 2>&1; then
    echo "==> WARNING: docker image prune failed" >&2
    failed=1
  fi

  exit "$failed"
)

echo "==> Cleaning up old local images (keeping current + previous $((KEEP_COUNT - 1)) deployed SHAs)"
if ! cleanup_old_images; then
  echo "==> WARNING: image cleanup had errors — deploy still succeeded; check disk usage manually" >&2
fi
