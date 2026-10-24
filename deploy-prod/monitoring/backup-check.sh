#!/usr/bin/env bash
# Runs ON the prod VPS (docs/deploy-prod.md), as user `deploy`, daily at 09:00 Asia/Jakarta via
# backup-check.timer (docs/plans/prod-deploy.md §3 Session 6, §6). Lives at
# /opt/ammari-prod/monitoring/backup-check.sh — see disk-alert.sh's header comment for why this
# whole directory is excluded from deploy-prod.yml's routine rsync.
#
# Two independent sources are checked, and disagreeing between them is itself treated as a
# failure (not just staleness of either one alone):
#   1. LOCAL:  /opt/ammari-prod/backup/last-backup-status.json, written by
#      deploy-prod/backup/pg-backup.sh (Session 5) only after a fully successful dump + encrypt +
#      upload. Missing entirely, or older than STALE_HOURS, is a problem.
#   2. BUCKET: the newest object actually under backups/daily/ in the DEDICATED `ammari-prod-backups`
#      R2 bucket, listed with the SAME throwaway aws-cli container approach pg-backup.sh itself
#      uses (pinned image, path-style S3 addressing, credentials from env/backup.env's
#      BACKUP_S3_* passed via a 0600 env file, never argv). Missing entirely, or older than
#      STALE_HOURS, is a problem. This guards against a scenario the local status file alone
#      could never catch: the status file says a backup completed, but the object it claims to
#      have written doesn't actually match what's live in the bucket.
# A brand-new install that has never run pg-backup.sh even once has NEITHER a status file NOR any
# bucket object — that alerts immediately too (not a "staleness" check that could never trigger
# with nothing to compare against yet).
#   3. PROOF FILES: /opt/ammari-prod/backup/last-proof-backup-status.json, written by
#      deploy-prod/backup/proof-backup.sh (docs/plans/purchase-payments.md A7) only after every
#      private proof object was verified copied into the backups bucket. Missing or older than
#      STALE_HOURS is a problem, but only once the proof backup is configured
#      (PROOF_BACKUP_SOURCE_BUCKET set in env/backup.env): before that release there is nothing to
#      back up, and this check stays silent rather than alerting every morning.
#
# Usage: backup-check.sh   (no arguments; always targets this directory's own
#                           ../env/backup.env and ../backup/last-backup-status.json)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./lib/alert-lib.sh
source "$SCRIPT_DIR/lib/alert-lib.sh"
STATE_DIR="$SCRIPT_DIR/state"

cd "$ROOT_DIR"

load_env_file "env/backup.env" || echo "==> WARNING: could not read env/backup.env" >&2

# Pinned, not :latest — same reasoning as pg-backup.sh's own copy of this same pin: an unattended
# daily job must never silently pick up a breaking CLI change.
AWS_CLI_IMAGE="amazon/aws-cli:2.27.49"

STATUS_FILE="$ROOT_DIR/backup/last-backup-status.json"
STALE_HOURS=26
STALE_SECONDS=$((STALE_HOURS * 3600))
NOW_EPOCH="$(date +%s)"

# "YYYY-MM-DD_HHMM" (exactly how pg-backup.sh's TIMESTAMP/DAILY_KEY are formatted) -> epoch
# seconds, interpreted in Asia/Jakarta (the same zone pg-backup.sh generated it in). Returns empty
# on anything that doesn't parse, so callers can tell "bad timestamp" apart from "epoch 0".
parse_backup_timestamp() {
  local ts="$1" date_part time_part hh mm
  date_part="${ts%_*}"
  time_part="${ts#*_}"
  if [ "$time_part" = "$ts" ] || [ "${#time_part}" -ne 4 ]; then
    return 1
  fi
  hh="${time_part:0:2}"
  mm="${time_part:2:2}"
  TZ=Asia/Jakarta date -d "$date_part $hh:$mm" +%s 2>/dev/null
}

ISSUES=()

echo "==> Checking local status file: $STATUS_FILE"
LOCAL_TS=""
if [ ! -f "$STATUS_FILE" ]; then
  ISSUES+=("local status file is missing entirely ($STATUS_FILE) — the nightly backup may never have run")
else
  LOCAL_TS="$(grep -o '"timestamp"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" | sed -E 's/.*"([^"]+)"[[:space:]]*$/\1/' || true)"
  if [ -z "$LOCAL_TS" ]; then
    ISSUES+=("local status file exists but has no parseable \"timestamp\" field")
  else
    LOCAL_EPOCH="$(parse_backup_timestamp "$LOCAL_TS" || true)"
    if [ -z "$LOCAL_EPOCH" ]; then
      ISSUES+=("local status file's timestamp ($LOCAL_TS) could not be parsed")
    elif [ "$((NOW_EPOCH - LOCAL_EPOCH))" -gt "$STALE_SECONDS" ]; then
      ISSUES+=("local status file is stale: last successful backup was $LOCAL_TS (over ${STALE_HOURS}h ago)")
    fi
  fi
fi

echo "==> Listing s3://\${BACKUP_S3_BUCKET}/backups/daily/ via throwaway aws-cli container"
for v in BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY; do
  if [ -z "${!v:-}" ]; then
    ISSUES+=("cannot list the bucket: $v is not set (check env/backup.env)")
  fi
done

BUCKET_TS=""
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  AWS_ENV_FILE="$(mktemp)"
  chmod 600 "$AWS_ENV_FILE"
  # when_required (not the aws-cli default): see pg-backup.sh's own comment above its matching
  # AWS_ENV_FILE block — originally forced to work around the prior Cloudeka provider; harmless
  # to leave on against R2.
  #
  # S3_*/AWS_* below are this script's own internal/container-local names, populated from the
  # host-side BACKUP_S3_* variables loaded from env/backup.env above.
  cat > "$AWS_ENV_FILE" <<ENVEOF
AWS_ACCESS_KEY_ID=${BACKUP_S3_ACCESS_KEY_ID:-}
AWS_SECRET_ACCESS_KEY=${BACKUP_S3_SECRET_ACCESS_KEY:-}
AWS_DEFAULT_REGION=${BACKUP_S3_REGION:-}
S3_BUCKET=${BACKUP_S3_BUCKET:-}
S3_ENDPOINT=${BACKUP_S3_ENDPOINT:-}
AWS_REQUEST_CHECKSUM_CALCULATION=when_required
AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
ENVEOF

  LIST_SCRIPT="$(mktemp)"
  cat > "$LIST_SCRIPT" <<'EOS'
#!/bin/bash
set -euo pipefail
mkdir -p "$HOME/.aws"
cat > "$HOME/.aws/config" <<CFG
[default]
s3 =
    addressing_style = path
CFG
aws s3 ls "s3://${S3_BUCKET}/backups/daily/" --endpoint-url "${S3_ENDPOINT}" 2>/dev/null || true
EOS

  LISTING="$(docker run --rm \
      --env-file "$AWS_ENV_FILE" \
      -v "$LIST_SCRIPT:/list.sh:ro" \
      --entrypoint /bin/bash \
      "$AWS_CLI_IMAGE" \
      /list.sh || true)"
  rm -f "$AWS_ENV_FILE" "$LIST_SCRIPT"

  if [ -z "$LISTING" ]; then
    ISSUES+=("no objects found under backups/daily/ in the bucket — a brand-new install with no backup ever run looks exactly like this")
  else
    BUCKET_NEWEST_KEY="$(printf '%s\n' "$LISTING" | awk '{print $4}' | sort | tail -n1)"
    BUCKET_TS="${BUCKET_NEWEST_KEY%.dump.enc}"
    BUCKET_EPOCH="$(parse_backup_timestamp "$BUCKET_TS" || true)"
    if [ -z "$BUCKET_EPOCH" ]; then
      ISSUES+=("newest bucket object ($BUCKET_NEWEST_KEY) has an unparseable name")
    elif [ "$((NOW_EPOCH - BUCKET_EPOCH))" -gt "$STALE_SECONDS" ]; then
      ISSUES+=("newest object under backups/daily/ is stale: $BUCKET_NEWEST_KEY (over ${STALE_HOURS}h ago)")
    fi
  fi
fi

if [ -n "$LOCAL_TS" ] && [ -n "$BUCKET_TS" ] && [ "$LOCAL_TS" != "$BUCKET_TS" ]; then
  ISSUES+=("local status file ($LOCAL_TS) disagrees with the newest bucket object (${BUCKET_TS:-none}) — the status file may not reflect what's actually live in the bucket")
fi

echo "==> Checking the proof-file backup"
PROOF_STATUS_FILE="$ROOT_DIR/backup/last-proof-backup-status.json"
PROOF_TS=""
if [ -z "${PROOF_BACKUP_SOURCE_BUCKET:-}" ]; then
  # Not configured yet is fine; configured BEFORE and now missing (a status file exists, or the
  # timer is enabled) means the setting was lost and the backup silently stopped.
  if [ -f "$PROOF_STATUS_FILE" ] || [ "$(systemctl is-enabled proof-backup.timer 2>/dev/null || true)" = "enabled" ]; then
    ISSUES+=("PROOF_BACKUP_SOURCE_BUCKET is missing from env/backup.env although the proof-file backup was set up (status file or enabled proof-backup.timer): the nightly proof copy is not running")
  else
    echo "==> Proof-file backup not configured (no PROOF_BACKUP_SOURCE_BUCKET in env/backup.env), skipped"
  fi
elif [ ! -f "$ROOT_DIR/backup/proof-backup-lib.sh" ]; then
  ISSUES+=("the proof-file backup is configured but $ROOT_DIR/backup/proof-backup-lib.sh is missing (copy deploy-prod/backup over, docs/deploy-prod.md §8.1)")
else
  # shellcheck source=../backup/proof-backup-lib.sh
  . "$ROOT_DIR/backup/proof-backup-lib.sh"
  PROOF_ISSUE="$(proof_status_issue "$PROOF_STATUS_FILE" "$NOW_EPOCH" "$STALE_HOURS")"
  if [ -n "$PROOF_ISSUE" ]; then
    ISSUES+=("$PROOF_ISSUE")
  fi
  PROOF_TS="$(proof_status_timestamp "$PROOF_STATUS_FILE")"
fi

OK=1
SUMMARY="(no issues)"
if [ "${#ISSUES[@]}" -gt 0 ]; then
  OK=0
  SUMMARY="$(printf '  - %s\n' "${ISSUES[@]}")"
fi
echo "==> Backup check result:"
printf '%s\n' "$SUMMARY"

BODY="The nightly backup check found the following:
${SUMMARY}

Local status file: ${STATUS_FILE} (last timestamp: ${LOCAL_TS:-none})
Newest backups/daily/ object in the bucket: ${BUCKET_TS:-none}
Proof-file backup status: ${PROOF_STATUS_FILE} (last timestamp: ${PROOF_TS:-none})

Check: SSH onto the VPS, run \`journalctl -u pg-backup.service -n 100\` to see the last backup
attempt's own output, and \`docker compose exec db pg_isready\` to confirm the database itself is
up. For the proof files: \`journalctl -u proof-backup.service -n 100\`, then
\`cd /opt/ammari-prod/backup && ./proof-backup.sh --dry-run\` to see what is not copied yet. See docs/runbooks/restore-drill.md for how a backup gets restored once one exists."

monitoring_alert_check "backup" "$OK" "[Ammari] Nightly backup check FAILED" "$BODY"
