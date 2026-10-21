#!/bin/sh
# The internal cron service (docs/plans/cart-checkout.md §6.3, §11, D13), run by the `cron`
# service in this directory's docker-compose.yml from the pinned curlimages/curl image (busybox sh,
# curl, nothing else). Kept byte-identical in deploy/cron/ (dev) and deploy-prod/cron/ (prod):
# each directory is synced to its own server.
#
# Every 5 minutes: POST /api/internal/payments/sweep (the payment expiry sweep). Once when the
# container starts and then every 24 hours: POST /api/internal/retention. Both straight at the web
# container over the internal Docker network (`web` is the dev service name and prod's floating
# alias for the active slot, deploy-prod/remote-deploy.sh point_web_alias), never through Caddy,
# which answers 404 for /api/internal/* on the public hosts.
#
# Authenticated with INTERNAL_CRON_SECRET from env/cron.env (the same value as in env/web.env).
# Without it the service idles and says so once; the web routes also refuse every call while
# their own copy is missing, so nothing runs until both are set. The secret goes to curl through
# a header file readable only by this container's user, never on a command line.
#
# Never two runs at once: this loop waits for each call to finish (curl --max-time) before
# sleeping, and the web routes take a Postgres advisory lock per job, so a second caller (a prod
# slot flip, a manual call) is skipped rather than racing the first.

set -u

TARGET="http://web:3000"
SWEEP_EVERY=300
RETENTION_EVERY=86400
# Below SWEEP_EVERY; the sweep itself stops starting new orders after 4 minutes.
SWEEP_MAX_TIME=280
RETENTION_MAX_TIME=600
# A failed retention run is retried after an hour, not a day.
RETENTION_RETRY_AFTER=3600
# This many failed sweeps in a row (15 minutes) logs an ALERT line on every further failure.
SWEEP_ALERT_AFTER=3

log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') cron: $*"
}

# `docker stop` sends TERM; `sleep ... & wait` lets the trap run at once instead of after a sleep.
trap 'log "stopping"; exit 0' TERM INT
pause() {
  sleep "$1" &
  wait $!
}

# Whitespace or a CR from the env file would never match the web side (which trims): drop it.
INTERNAL_CRON_SECRET="$(printf '%s' "${INTERNAL_CRON_SECRET:-}" | tr -d ' \t\r\n')"
if [ -z "$INTERNAL_CRON_SECRET" ]; then
  log "INTERNAL_CRON_SECRET is not set in env/cron.env; idle (no sweep, no retention)"
  while :; do pause 3600; done
fi

umask 077
HEADER_FILE="$(mktemp)"
printf 'authorization: Bearer %s\n' "$INTERNAL_CRON_SECRET" > "$HEADER_FILE"
unset INTERNAL_CRON_SECRET

# call <path> <max seconds>: logs the HTTP status and the (small JSON) answer, never the secret.
# Returns 0 only for a 2xx answer.
call() {
  body="$(curl -sS -X POST -H "@$HEADER_FILE" --max-time "$2" -w '\n%{http_code}' "$TARGET$1" 2>&1)"
  rc=$?
  status="$(printf '%s' "$body" | tail -n 1)"
  answer="$(printf '%s' "$body" | sed '$d' | tr '\n' ' ' | cut -c 1-500)"
  case "$status" in
    2??)
      log "$1 -> $status $answer"
      return 0
      ;;
    401) log "ERROR $1 -> 401: INTERNAL_CRON_SECRET differs between env/cron.env and env/web.env" ;;
    503) log "ERROR $1 -> 503 $answer (web.env lacks INTERNAL_CRON_SECRET, or the payment provider is not configured: see web's logs)" ;;
    *) log "ERROR $1 -> ${status:-no answer} (curl exit $rc) $answer" ;;
  esac
  return 1
}

# Let the web container finish starting after a deploy.
pause 30
last_retention=0
sweep_failures=0
while :; do
  now="$(date +%s)"
  if [ $((now - last_retention)) -ge "$RETENTION_EVERY" ]; then
    if call /api/internal/retention "$RETENTION_MAX_TIME"; then
      last_retention="$now"
    else
      last_retention=$((now - RETENTION_EVERY + RETENTION_RETRY_AFTER))
    fi
  fi
  if call /api/internal/payments/sweep "$SWEEP_MAX_TIME"; then
    sweep_failures=0
  else
    sweep_failures=$((sweep_failures + 1))
    if [ "$sweep_failures" -ge "$SWEEP_ALERT_AFTER" ]; then
      log "ALERT: the payment expiry sweep has failed $sweep_failures times in a row; unpaid orders are not being expired"
    fi
  fi
  pause "$SWEEP_EVERY"
done
