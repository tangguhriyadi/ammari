#!/usr/bin/env bash
# Runs ON the prod VPS (docs/deploy-prod.md), as user `deploy`, every 10 minutes via
# health-check.timer (docs/plans/prod-deploy.md §3 Session 6, §6). Lives at
# /opt/ammari-prod/monitoring/health-check.sh — see disk-alert.sh's header comment for why this
# whole directory is excluded from deploy-prod.yml's routine rsync.
#
# Six independent conditions, each tracked and de-duplicated separately (alert-lib.sh) so one
# flapping check never masks or gets masked by another:
#   db               the `db` service container is running AND Docker's own HEALTHCHECK
#                     (docker-compose.yml's pg_isready test) reports "healthy".
#   caddy             the `caddy` service container is running (it has no HEALTHCHECK of its own
#                     — the two endpoint checks below are what actually proves it's serving).
#   admin-container   whichever of admin-blue/admin-green is recorded as ACTIVE in
#                     /opt/ammari-prod/active-slot-admin is running. admin/web services have no
#                     Docker HEALTHCHECK defined (see docker-compose.yml) — "running" is the
#                     container-level signal; the endpoint check below is the functional one.
#   web-container     same, for whichever of web-blue/web-green is active.
#   admin-endpoint    `/api/health` responds 200 through Caddy's internal-only :8081 listener —
#                     the SAME end-to-end path deploy-prod/remote-deploy.sh's own
#                     poll_health_through_caddy already uses during a deploy (Session 3).
#   web-endpoint      same, through :8080.
#
# Reads (never writes) /opt/ammari-prod/active-slot-{admin,web} — the same files
# deploy-prod/remote-deploy.sh (Session 3) writes on a successful flip. Defaults to "blue" when a
# file is absent, matching remote-deploy.sh's own default for an app that's never been deployed
# yet.
#
# Usage: health-check.sh   (no arguments; always targets this directory's own
#                           ../env/{admin,backup}.env and ../active-slot-{admin,web})
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./lib/alert-lib.sh
source "$SCRIPT_DIR/lib/alert-lib.sh"
STATE_DIR="$SCRIPT_DIR/state"

cd "$ROOT_DIR"

load_env_file "env/admin.env" || echo "==> WARNING: could not read env/admin.env" >&2
load_env_file "env/backup.env" || echo "==> WARNING: could not read env/backup.env" >&2

ADMIN_SLOT="$(cat active-slot-admin 2>/dev/null || echo blue)"
WEB_SLOT="$(cat active-slot-web 2>/dev/null || echo blue)"
echo "==> Active slots: admin=$ADMIN_SLOT web=$WEB_SLOT"

container_running() {
  local service="$1" cid
  cid="$(docker compose ps -q "$service" 2>/dev/null || true)"
  [ -n "$cid" ] && [ "$(docker inspect --format '{{.State.Running}}' "$cid" 2>/dev/null || echo false)" = "true" ]
}

container_healthy() {
  local service="$1" cid status
  cid="$(docker compose ps -q "$service" 2>/dev/null || true)"
  [ -n "$cid" ] || return 1
  status="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "")"
  [ "$status" = "healthy" ]
}

# Same reachability as deploy-prod/remote-deploy.sh's own poll_health_through_caddy: these are
# plain-HTTP, never-published internal listeners, reachable only via `docker compose exec caddy`
# from inside this one container (deploy-prod/Caddyfile, Session 2/3).
endpoint_healthy() {
  local port="$1"
  docker compose exec -T caddy curl -sf "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1
}

# `if cmd; then` (not `cmd && VAR=1`) deliberately — the latter's compound exit status is
# non-zero whenever the check fails, which would trip this script's own `set -e` the instant the
# first thing it finds is actually unhealthy.
if container_healthy "db"; then DB_OK=1; else DB_OK=0; fi
if container_running "caddy"; then CADDY_OK=1; else CADDY_OK=0; fi
if container_running "admin-$ADMIN_SLOT"; then ADMIN_CONTAINER_OK=1; else ADMIN_CONTAINER_OK=0; fi
if container_running "web-$WEB_SLOT"; then WEB_CONTAINER_OK=1; else WEB_CONTAINER_OK=0; fi
if endpoint_healthy 8081; then ADMIN_ENDPOINT_OK=1; else ADMIN_ENDPOINT_OK=0; fi
if endpoint_healthy 8080; then WEB_ENDPOINT_OK=1; else WEB_ENDPOINT_OK=0; fi

CHECK_CMDS="Check: SSH onto the VPS, cd /opt/ammari-prod, run \`docker compose ps\` and
\`docker compose logs --tail 100 <service>\` for the service named below. See
docs/deploy-prod.md's troubleshooting section."

monitoring_alert_check "health-db" "$DB_OK" \
  "[Ammari] db container is not healthy" \
  "The db container is not running or not passing its pg_isready healthcheck.

${CHECK_CMDS}"

monitoring_alert_check "health-caddy" "$CADDY_OK" \
  "[Ammari] caddy container is not running" \
  "The caddy container (the only one publishing 80/443) is not running — the whole site is
likely unreachable.

${CHECK_CMDS}"

monitoring_alert_check "health-admin-container" "$ADMIN_CONTAINER_OK" \
  "[Ammari] active admin slot (admin-${ADMIN_SLOT}) is not running" \
  "active-slot-admin says \"${ADMIN_SLOT}\" but that slot's container is not running.

${CHECK_CMDS}"

monitoring_alert_check "health-web-container" "$WEB_CONTAINER_OK" \
  "[Ammari] active web slot (web-${WEB_SLOT}) is not running" \
  "active-slot-web says \"${WEB_SLOT}\" but that slot's container is not running.

${CHECK_CMDS}"

monitoring_alert_check "health-admin-endpoint" "$ADMIN_ENDPOINT_OK" \
  "[Ammari] admin /api/health failed through Caddy" \
  "A request to admin's /api/health through Caddy's internal :8081 listener failed or did not
return 200 — this is the same end-to-end check remote-deploy.sh uses during a deploy.

${CHECK_CMDS}"

monitoring_alert_check "health-web-endpoint" "$WEB_ENDPOINT_OK" \
  "[Ammari] web /api/health failed through Caddy" \
  "A request to web's /api/health through Caddy's internal :8080 listener failed or did not
return 200 — this is the same end-to-end check remote-deploy.sh uses during a deploy.

${CHECK_CMDS}"

echo "==> health-check complete: db=$DB_OK caddy=$CADDY_OK admin_container=$ADMIN_CONTAINER_OK web_container=$WEB_CONTAINER_OK admin_endpoint=$ADMIN_ENDPOINT_OK web_endpoint=$WEB_ENDPOINT_OK"
