# shellcheck shell=bash
# Shared code for deploy-prod/monitoring/*.sh (docs/plans/prod-deploy.md §3 Session 6). Sourced,
# never executed directly — has no shebang/exec bit on purpose. Lives at
# /opt/ammari-prod/monitoring/lib/alert-lib.sh, same deliberately-excluded-from-rsync directory as
# the three check scripts (see .github/workflows/deploy-prod.yml's rsync excludes and this
# directory's own install-monitoring.sh).
#
# Reuses the EXACT Resend alerting mechanism deploy-prod/backup/pg-backup.sh (Session 5) already
# has installed and running in prod: a throwaway, pinned curl container; the API key and the JSON
# body are written to 0600 temp files and read by curl via `@file`, never argv, never a log line.
# pg-backup.sh itself is NOT changed by this session (it's already live on the server) — this file
# is a second, independent copy of that same pattern, factored out so the three NEW scripts below
# don't each duplicate it.
#
# A caller sources this file, then:
#   - sets STATE_DIR (each script sets it to "$SCRIPT_DIR/state" — see any of the three scripts)
#   - calls load_env_file for whatever env/*.env files it needs
#   - calls monitoring_alert_check for each condition it's tracking
#
# Dedup contract (docs/plans/prod-deploy.md §6): a condition that's already failing re-alerts at
# most once every 12h (ALERT_DEDUP_SECONDS below) while it stays failing, and sends exactly one
# "RECOVERED" email the first time it's next seen passing. State is one small text file per
# condition name under STATE_DIR — not JSON (no jq dependency assumed on the VPS), just two
# `KEY=value` lines, written only by this file itself so the format never needs external parsing.

ALERT_DEDUP_SECONDS=$((12 * 3600))

# Allows a local test harness to point the Resend call at a mock HTTP server instead of the real
# API — never set in production (no env file defines this key), so this always defaults to the
# real endpoint. Same override name/shape as pg-backup.sh's own RESEND_API_URL.
RESEND_API_URL="${RESEND_API_URL:-https://api.resend.com/emails}"

# Pinned, not :latest — same reasoning as every other image pin in this repo: an unattended check
# that runs every 10 minutes to every 24h must never silently pick up a breaking CLI change.
ALERT_CURL_IMAGE="curlimages/curl:8.11.1"

# Reads plain "KEY=value" lines (docker-compose env_file format — no quoting, no shell expansion)
# without ever invoking `source`/`.`, which would let a value containing `$` or backticks be
# interpreted as shell syntax during load. Identical in shape to pg-backup.sh's own copy.
load_env_file() {
  local file="$1" line key value
  if [ ! -f "$file" ]; then
    echo "Missing env file: $file" >&2
    return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|"#"*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    printf -v "$key" '%s' "$value"
    # shellcheck disable=SC2163 # $key holds a VARIABLE NAME here (just set via printf -v above),
    # not a literal — `export "$key"` exports the name it expands to, which is exactly the point.
    export "$key"
  done < "$file"
}

# Minimal JSON string escaping for the alert email body (plain log text, not attacker-controlled
# input) — backslash, double-quote, and newlines are the only characters that can actually appear
# in these scripts' own status/error messages and break the JSON.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/}"
  printf '%s' "$s"
}

# Sends ONE email via Resend, run inside a throwaway curl container. Degrades to a loud stderr
# warning (never a hard failure) when alerting isn't configured at all, so a missing
# ALERT_EMAIL_TO/RESEND_API_KEY/EMAIL_FROM never masks the real condition that triggered this call
# — the caller's own exit status/journal output is still the source of truth either way.
send_alert() {
  local subject="$1" body="$2"
  if [ -z "${ALERT_EMAIL_TO:-}" ] || [ -z "${RESEND_API_KEY:-}" ] || [ -z "${EMAIL_FROM:-}" ]; then
    echo "==> WARNING: cannot send alert email — ALERT_EMAIL_TO/RESEND_API_KEY/EMAIL_FROM not all set" >&2
    return 0
  fi

  local tmp_dir headers_file body_file to_json esc_subject esc_body addr
  tmp_dir="$(mktemp -d)"
  headers_file="$tmp_dir/headers.txt"
  body_file="$tmp_dir/body.json"

  {
    printf 'Authorization: Bearer %s\n' "$RESEND_API_KEY"
    printf 'Content-Type: application/json\n'
  } > "$headers_file"
  chmod 600 "$headers_file"

  to_json=""
  while IFS= read -r addr; do
    addr="${addr#"${addr%%[![:space:]]*}"}"
    addr="${addr%"${addr##*[![:space:]]}"}"
    [ -z "$addr" ] && continue
    if [ -n "$to_json" ]; then to_json="${to_json},"; fi
    to_json="${to_json}\"$(json_escape "$addr")\""
  done <<< "$(printf '%s' "$ALERT_EMAIL_TO" | tr ',' '\n')"

  esc_subject="$(json_escape "$subject")"
  esc_body="$(json_escape "$body")"

  printf '{"from":"%s","to":[%s],"subject":"%s","text":"%s"}' \
    "$EMAIL_FROM" "$to_json" "$esc_subject" "$esc_body" > "$body_file"
  chmod 600 "$body_file"

  if ! docker run --rm \
      -v "$tmp_dir:/alert:ro" \
      "$ALERT_CURL_IMAGE" \
      -sf -X POST "$RESEND_API_URL" \
      -H @/alert/headers.txt \
      --data-binary @/alert/body.json \
      -o /dev/null; then
    echo "==> WARNING: failed to send alert email via Resend" >&2
  fi

  rm -rf "$tmp_dir"
}

# Tracks one named condition (e.g. "disk", "backup", "health-db") across runs and decides whether
# this run should actually send an email:
#   ok=1 (condition is fine):
#     - a state file exists (it was previously failing)  -> send ONE "RECOVERED" email, delete
#       the state file.
#     - no state file (it was already fine)               -> nothing to do, no email.
#   ok=0 (condition is failing):
#     - no state file, OR the last alert for it was sent >= ALERT_DEDUP_SECONDS ago -> send the
#       alert, (re)write the state file with this run's timestamp.
#     - state file exists and is still within the dedup window                    -> log to
#       stdout/journal only, no repeat email.
# Never exits non-zero itself — a caller's own overall exit status is driven by whether the
# CHECK found a real problem, not by whether sending/suppressing an email succeeded.
monitoring_alert_check() {
  local name="$1" ok="$2" subject="$3" body="$4"
  local state_file="$STATE_DIR/$name.state"
  mkdir -p "$STATE_DIR"

  if [ "$ok" = "1" ]; then
    if [ -f "$state_file" ]; then
      send_alert "[Ammari] RECOVERED: $subject" "$body"$'\n\n'"(this condition has cleared)"
      rm -f "$state_file"
      echo "==> [$name] recovered"
    fi
    return 0
  fi

  local now last_alert_epoch first_fail_epoch
  now="$(date +%s)"
  last_alert_epoch=0
  first_fail_epoch="$now"
  if [ -f "$state_file" ]; then
    # `|| true` on each pipeline: under this script's `set -o pipefail`, a state file that's
    # somehow missing one of these lines would otherwise make grep's non-zero status abort the
    # whole run (set -e applies to a plain assignment statement, unlike an `if` condition) —
    # default to 0/$now instead, exactly like pg-backup.sh's own defensive fallbacks.
    last_alert_epoch="$(grep -m1 '^LAST_ALERT_EPOCH=' "$state_file" | cut -d= -f2 || true)"
    last_alert_epoch="${last_alert_epoch:-0}"
    first_fail_epoch="$(grep -m1 '^FIRST_FAIL_EPOCH=' "$state_file" | cut -d= -f2 || true)"
    first_fail_epoch="${first_fail_epoch:-$now}"
  fi

  if [ -f "$state_file" ] && [ "$(( now - last_alert_epoch ))" -lt "$ALERT_DEDUP_SECONDS" ]; then
    echo "==> [$name] still failing, suppressing repeat alert (last sent $(( (now - last_alert_epoch) / 60 )) min ago)"
    return 0
  fi

  send_alert "$subject" "$body"
  {
    echo "FIRST_FAIL_EPOCH=$first_fail_epoch"
    echo "LAST_ALERT_EPOCH=$now"
  } > "$state_file"
  echo "==> [$name] alert sent"
}
