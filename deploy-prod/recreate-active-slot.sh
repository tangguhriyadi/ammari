#!/usr/bin/env bash
# Recreates the ACTIVE admin or web slot so it re-reads its env file (docs/deploy-prod.md §3.2,
# docs/launch/checkout-prod.md). Runs ON THE PROD VPS as `deploy`, from /opt/ammari-prod (synced
# there by every prod deploy, like remote-deploy.sh). Prints no env value.
#
# Usage: ./recreate-active-slot.sh admin|web
#
# Why not a bare `docker compose up -d --force-recreate web-<slot>`: the floating internal `web`
# network alias (admin's WEB_INTERNAL_URL=http://web:3000 for storefront revalidation, and the cron
# service's sweep, email and retention calls) is attached by remote-deploy.sh's point_web_alias
# with `docker network connect`, not by Compose. A recreated container comes back with only its
# Compose aliases, so after a bare recreate `web` resolves to nothing: the cron calls log
# "no answer" every 5 minutes and admin's revalidation fails, until the next deploy. This script
# re-attaches the alias the same way point_web_alias does, then proves it resolves.
#
# A brief single-slot restart (a few seconds), not a blue-green flip: fine for a planned env
# change, never a substitute for the deploy workflow.
set -euo pipefail

APP="${1:-}"
if [ "$APP" != "admin" ] && [ "$APP" != "web" ]; then
  echo "Usage: $0 admin|web" >&2
  exit 1
fi

# Matches docker-compose.yml's `name: ammari-prod` (remote-deploy.sh uses the same name).
NETWORK="ammari-prod_internal"
cd "$(dirname "$0")"

SLOT="$(cat "active-slot-$APP" 2>/dev/null || true)"
if [ "$SLOT" != "blue" ] && [ "$SLOT" != "green" ]; then
  echo "==> active-slot-$APP is '$SLOT', not blue/green: refusing to guess which slot is live" >&2
  exit 1
fi
SERVICE="$APP-$SLOT"

echo "==> recreating $SERVICE (the active $APP slot) so it re-reads env/$APP.env"
docker compose up -d --no-deps --force-recreate "$SERVICE"

# The alias first, before anything that can fail: a recreated web container has no `web` alias, so
# cron and admin revalidation are broken from this moment until it is back.
if [ "$APP" = "web" ]; then
  cid="$(docker compose ps -q "$SERVICE")"
  if [ -z "$cid" ]; then
    echo "==> $SERVICE has no container after the recreate; nothing serves web. Check: docker compose ps; docker compose logs --tail 60 $SERVICE" >&2
    exit 1
  fi
  echo "==> re-attaching the internal 'web' alias to $SERVICE"
  docker network disconnect "$NETWORK" "$cid" >/dev/null 2>&1 || true
  if ! docker network connect --alias web --alias "$SERVICE" "$NETWORK" "$cid"; then
    echo "==> FAILED to reconnect $SERVICE to $NETWORK: Caddy, cron and admin cannot reach it. Run ./recreate-active-slot.sh web again; if that fails too, run the Deploy (prod) workflow." >&2
    exit 1
  fi
fi

healthy=0
for attempt in $(seq 1 20); do
  if docker compose exec -T "$SERVICE" node -e \
    "require('http').get('http://127.0.0.1:3000/api/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" \
    </dev/null >/dev/null 2>&1; then
    healthy=1
    break
  fi
  echo "==> $SERVICE not healthy yet (attempt $attempt/20), retrying..."
  sleep 3
done
if [ "$healthy" -ne 1 ]; then
  echo "==> $SERVICE FAILED its health check after the recreate. Last log lines:" >&2
  docker compose logs --tail 60 "$SERVICE" >&2 || true
  echo "==> Undo the env change on your Mac, upload-prod-env.sh, then run this script again." >&2
  [ "$APP" = "web" ] && echo "==> (the internal 'web' alias is attached to $SERVICE; it serves again once healthy)" >&2
  exit 1
fi
echo "==> $SERVICE healthy (direct)"

port=8081
[ "$APP" = "web" ] && port=8080
ok=0
for attempt in $(seq 1 10); do
  if docker compose exec -T caddy curl -sf "http://127.0.0.1:${port}/api/health" </dev/null >/dev/null 2>&1; then
    ok=1
    break
  fi
  echo "==> $APP not reachable through Caddy yet (attempt $attempt/10), retrying..."
  sleep 3
done
if [ "$ok" -ne 1 ]; then
  echo "==> $APP FAILED its health check through Caddy (:${port})" >&2
  exit 1
fi
echo "==> $APP healthy through Caddy"

if [ "$APP" = "web" ]; then
  if docker compose exec -T caddy curl -sf "http://web:3000/api/health" </dev/null >/dev/null 2>&1; then
    echo "==> internal alias http://web:3000 answers (cron and admin revalidation reach $SERVICE)"
  else
    echo "==> internal alias http://web:3000 does NOT answer: cron and admin revalidation are broken until fixed" >&2
    exit 1
  fi
  # The cron service reads env/cron.env only at start: recreate it too, so a changed
  # INTERNAL_CRON_SECRET takes effect in the same step (remote-deploy.sh does the same after a flip).
  echo "==> recreating the cron service"
  docker compose up -d --no-deps --force-recreate cron
  sleep 5
  if [ -z "$(docker compose ps --status running -q cron)" ]; then
    echo "==> cron is NOT running after the recreate: no expiry sweep, no order emails. Check: docker compose logs --tail 30 cron" >&2
    exit 1
  fi
  if docker compose logs --no-log-prefix --tail 5 cron </dev/null 2>/dev/null | grep -q 'idle (no sweep'; then
    echo "==> WARNING: cron is running but IDLE: env/cron.env has no INTERNAL_CRON_SECRET (expected only before the checkout setup)" >&2
  else
    echo "==> cron is running; its first calls come after ~30 s: docker compose logs --tail 20 cron"
  fi
fi

echo "==> done: $SERVICE recreated with the current env/$APP.env"
