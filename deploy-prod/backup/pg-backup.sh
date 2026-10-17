#!/usr/bin/env bash
# Runs ON the prod VPS (docs/deploy-prod.md), as user `deploy`, nightly via pg-backup.timer
# (docs/plans/prod-deploy.md §3 Session 5, §6). Lives at /opt/ammari-prod/backup/pg-backup.sh —
# this directory is deliberately excluded from deploy-prod.yml's routine rsync (same reason
# env/ is excluded), so a normal app deploy never silently overwrites this script or the
# last-backup-status.json file it writes. See docs/runbooks/restore-drill.md for how a backup
# this script produces gets restored, and install-backup-timer.sh for the one-time systemd setup.
#
# Mechanics: pg_dump (inside the already-running `db` container, over its own unix socket, so no
# Postgres password ever needs to leave that container) -> openssl aes-256-cbc-pbkdf2 encrypt
# (key from env/backup.env's PG_BACKUP_ENCRYPTION_KEY, passed to openssl via `-pass env:`, never
# argv, never echoed) -> upload to the SAME prod bucket's private backups/ prefix, using the S3
# credentials already in env/admin.env (docs/plans/prod-deploy.md §4 step 7 / §9 "Later" list —
# one bucket, one access key, not duplicated into backup.env). The encrypted dump briefly exists
# at a mktemp path; the unencrypted dump NEVER touches disk at all (it only ever exists inside
# the pg_dump|openssl pipe). Every temp file this script creates is removed by the EXIT trap
# below, on success or failure alike.
#
# Nothing extra is installed on the host for this: pg_dump runs via `docker compose exec` into
# the already-running `db` container, and the S3 upload/prune and the Resend alert each run
# inside their own throwaway, pinned, --rm container (amazon/aws-cli, curlimages/curl) — the host
# itself only ever needs Docker, which is already required for everything else on this VPS.
#
# Usage: pg-backup.sh   (no arguments; always targets this directory's own
#                        ../docker-compose.yml / ../env/{admin,backup,db}.env)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Pinned, not :latest — same reasoning as every other image pin in this repo (Caddy, Postgres
# major version): a nightly unattended job must never silently pick up a breaking CLI change.
AWS_CLI_IMAGE="amazon/aws-cli:2.27.49"
CURL_IMAGE="curlimages/curl:8.11.1"

KEEP_DAILY=14
KEEP_WEEKLY=8

STATUS_FILE="$SCRIPT_DIR/last-backup-status.json"

# Allow a local test harness to point the Resend call at a mock HTTP server instead of the real
# API — never set in production (env/backup.env has no such key), so this always defaults to the
# real endpoint on the VPS.
RESEND_API_URL="${RESEND_API_URL:-https://api.resend.com/emails}"

TMP_FILES=()
cleanup() {
  local f
  for f in "${TMP_FILES[@]:-}"; do
    [ -n "$f" ] && rm -f "$f"
  done
}
trap cleanup EXIT

track_tmp() { TMP_FILES+=("$1"); }

file_size() {
  stat -c%s "$1" 2>/dev/null || stat -f%z "$1"
}

# Minimal JSON string escaping for the alert email body (plain log text, not attacker-controlled
# input) — backslash, double-quote, and newlines are the only characters that can actually appear
# in this script's own error messages and break the JSON.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/}"
  printf '%s' "$s"
}

# Reads plain "KEY=value" lines (docker-compose env_file format — no quoting, no shell
# expansion) without ever invoking `source`/`.`, which would let a value containing `$` or
# backticks be interpreted as shell syntax during load.
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
    export "$key"
  done < "$file"
}

# Sends ONE alert email via Resend, run inside a throwaway curl container. The API key and the
# JSON body never touch argv or a log line — both are written to 0600 temp files, mounted
# read-only into the container, and read by curl via `@file`. Degrades to a loud stderr warning
# (never a hard failure of its own) when alerting isn't configured at all, so a missing
# ALERT_EMAIL_TO/RESEND_API_KEY/EMAIL_FROM never masks the real failure that triggered this call.
send_alert() {
  local subject="$1" body="$2"
  if [ -z "${ALERT_EMAIL_TO:-}" ] || [ -z "${RESEND_API_KEY:-}" ] || [ -z "${EMAIL_FROM:-}" ]; then
    echo "==> WARNING: cannot send alert email — ALERT_EMAIL_TO/RESEND_API_KEY/EMAIL_FROM not all set" >&2
    return 0
  fi

  local tmp_dir headers_file body_file to_json esc_subject esc_body addr
  tmp_dir="$(mktemp -d)"
  track_tmp "$tmp_dir"
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
      "$CURL_IMAGE" \
      -sf -X POST "$RESEND_API_URL" \
      -H @/alert/headers.txt \
      --data-binary @/alert/body.json \
      -o /dev/null; then
    echo "==> WARNING: failed to send alert email via Resend" >&2
  fi

  rm -rf "$tmp_dir"
}

fail() {
  local msg="$1"
  echo "==> FAILED: $msg" >&2
  send_alert "[Ammari] Nightly backup FAILED" "$msg"
  exit 1
}

require_var() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "missing required variable $name in env/backup.env or env/admin.env"
  fi
}

echo "==> Loading env/backup.env and env/admin.env"
load_env_file "env/backup.env" || fail "could not read env/backup.env"
load_env_file "env/admin.env" || fail "could not read env/admin.env"

for v in PG_BACKUP_ENCRYPTION_KEY S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  require_var "$v"
done
# ALERT_EMAIL_TO / RESEND_API_KEY / EMAIL_FROM are intentionally NOT required here — send_alert
# degrades gracefully (a stderr warning, not a fail()) when any is missing, so a misconfigured
# alert path never blocks or masks the backup itself.

TIMESTAMP="$(TZ=Asia/Jakarta date +%Y-%m-%d_%H%M)"
DOW="$(TZ=Asia/Jakarta date +%u)" # 1=Monday .. 7=Sunday
DAILY_KEY="backups/daily/${TIMESTAMP}.dump.enc"
WEEKLY_KEY=""
if [ "$DOW" = "7" ]; then
  WEEKLY_KEY="backups/weekly/${TIMESTAMP}.dump.enc"
fi

echo "==> Checking db container health"
db_healthy=0
for attempt in $(seq 1 6); do
  cid="$(docker compose ps -q db || true)"
  if [ -n "$cid" ]; then
    status="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "")"
    if [ "$status" = "healthy" ]; then
      db_healthy=1
      break
    fi
  fi
  echo "==> db not healthy yet (attempt $attempt/6), retrying..."
  sleep 10
done
if [ "$db_healthy" -ne 1 ]; then
  fail "db container is not healthy — refusing to dump from a database that may not be ready"
fi

ENC_FILE="$(mktemp)"
track_tmp "$ENC_FILE"

echo "==> Dumping + encrypting (pg_dump --format=custom | openssl enc -aes-256-cbc -pbkdf2)"
# Single-quoted so $POSTGRES_USER/$POSTGRES_DB expand INSIDE the container, from its own
# env_file (env/db.env) — never from this script's own environment, which doesn't have them.
# `set -o pipefail` (part of this script's own `set -euo pipefail`) makes a pg_dump failure fail
# this whole statement even though openssl, the last command in the pipe, might otherwise exit 0
# on empty input.
if ! docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
    | openssl enc -aes-256-cbc -pbkdf2 -pass env:PG_BACKUP_ENCRYPTION_KEY \
    > "$ENC_FILE"; then
  fail "pg_dump or encryption failed"
fi

ENC_SIZE="$(file_size "$ENC_FILE")"
if [ "$ENC_SIZE" -lt 100 ]; then
  fail "encrypted dump is suspiciously small (${ENC_SIZE} bytes) — refusing to upload a likely-empty backup"
fi
echo "==> Encrypted dump: ${ENC_SIZE} bytes"

echo "==> Uploading to S3 and pruning old backups"
# Single-quoted heredoc ('EOS') — nothing here expands on the HOST; every ${VAR} below is
# resolved inside the throwaway container, from the env file built right after this block. Keeps
# every value (bucket, keys, retention counts) out of the script text itself, so this block never
# needs editing when any of those change.
S3OPS_SCRIPT="$(mktemp)"
track_tmp "$S3OPS_SCRIPT"
cat > "$S3OPS_SCRIPT" <<'EOS'
#!/bin/bash
set -euo pipefail

# Forces path-style addressing (bucket as a path segment, not a DNS subdomain of the endpoint) —
# same reason packages/storage/src/s3-client.ts hardcodes forcePathStyle:true for this same
# Cloudeka endpoint: a self-hosted/S3-compatible provider isn't guaranteed wildcard DNS for
# virtual-hosted-style addressing.
mkdir -p "$HOME/.aws"
cat > "$HOME/.aws/config" <<'CFG'
[default]
s3 =
    addressing_style = path
CFG

echo "Uploading s3://${S3_BUCKET}/${DAILY_KEY}"
aws s3 cp /backup/dump.enc "s3://${S3_BUCKET}/${DAILY_KEY}" --endpoint-url "${S3_ENDPOINT}"

if [ -n "${WEEKLY_KEY:-}" ]; then
  echo "Also uploading s3://${S3_BUCKET}/${WEEKLY_KEY}"
  aws s3 cp /backup/dump.enc "s3://${S3_BUCKET}/${WEEKLY_KEY}" --endpoint-url "${S3_ENDPOINT}"
fi

prune() {
  local prefix="$1" keep="$2" key total to_delete
  echo "Pruning s3://${S3_BUCKET}/${prefix} (keep newest ${keep})"
  # `aws s3 ls` lists one object per line ("DATE TIME SIZE NAME"); object names
  # (YYYY-MM-DD_HHMM.dump.enc) sort lexicographically == chronologically, so a plain `sort` on
  # column 4 is a correct oldest-first ordering without parsing the LastModified column at all.
  # This function NEVER touches any prefix other than the one literal argument it's called
  # with below (backups/daily/, backups/weekly/) — it can't reach products/*/content/* by
  # construction.
  mapfile -t all_keys < <(aws s3 ls "s3://${S3_BUCKET}/${prefix}" --endpoint-url "${S3_ENDPOINT}" 2>/dev/null | awk '{print $4}' | sort)
  total=${#all_keys[@]}
  if [ "$total" -le "$keep" ]; then
    echo "  only $total object(s) present, nothing to prune"
    return 0
  fi
  to_delete=$(( total - keep ))
  for ((i = 0; i < to_delete; i++)); do
    key="${all_keys[$i]}"
    [ -z "$key" ] && continue
    echo "  deleting s3://${S3_BUCKET}/${prefix}${key}"
    aws s3 rm "s3://${S3_BUCKET}/${prefix}${key}" --endpoint-url "${S3_ENDPOINT}"
  done
}

prune "backups/daily/" "${KEEP_DAILY}"
prune "backups/weekly/" "${KEEP_WEEKLY}"
echo "S3 operations complete"
EOS

AWS_ENV_FILE="$(mktemp)"
track_tmp "$AWS_ENV_FILE"
chmod 600 "$AWS_ENV_FILE"
cat > "$AWS_ENV_FILE" <<ENVEOF
AWS_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}
AWS_DEFAULT_REGION=${S3_REGION}
S3_BUCKET=${S3_BUCKET}
S3_ENDPOINT=${S3_ENDPOINT}
DAILY_KEY=${DAILY_KEY}
WEEKLY_KEY=${WEEKLY_KEY}
KEEP_DAILY=${KEEP_DAILY}
KEEP_WEEKLY=${KEEP_WEEKLY}
ENVEOF

if ! docker run --rm \
    --env-file "$AWS_ENV_FILE" \
    -v "$ENC_FILE:/backup/dump.enc:ro" \
    -v "$S3OPS_SCRIPT:/s3ops.sh:ro" \
    --entrypoint /bin/bash \
    "$AWS_CLI_IMAGE" \
    /s3ops.sh; then
  fail "upload/prune to S3 failed"
fi

cat > "$STATUS_FILE" <<STATUSEOF
{
  "timestamp": "${TIMESTAMP}",
  "size_bytes": ${ENC_SIZE},
  "daily_key": "${DAILY_KEY}",
  "weekly_key": $( [ -n "$WEEKLY_KEY" ] && printf '"%s"' "$WEEKLY_KEY" || printf 'null' )
}
STATUSEOF

if [ -n "$WEEKLY_KEY" ]; then
  echo "==> Backup complete: ${DAILY_KEY} (${ENC_SIZE} bytes), also ${WEEKLY_KEY}"
else
  echo "==> Backup complete: ${DAILY_KEY} (${ENC_SIZE} bytes)"
fi
