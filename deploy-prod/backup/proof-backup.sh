#!/usr/bin/env bash
# Runs ON the prod VPS, as user `deploy`, nightly via proof-backup.timer (docs/plans/
# purchase-payments.md A7, session S5). Lives at /opt/ammari-prod/backup/proof-backup.sh, next to
# pg-backup.sh and, like it, outside deploy-prod.yml's routine rsync (copy it over by hand,
# docs/deploy-prod.md §8.1; install the timer with install-backup-timer.sh).
#
# What it does: copies every object of the PRIVATE proof bucket (`ammari-prod-private`: payment
# proofs and supplier notas) that is not in the backups bucket yet into `ammari-prod-backups`,
# under private-files/<same key>. Incremental (only keys the destination lacks), idempotent (a
# second run copies nothing), and it never deletes or overwrites anything on either side: proof
# files are immutable and their keys never reused, so "the key exists in the backup" means "it is
# backed up". After copying it re-lists the destination and checks that EVERY source object has a
# copy of the same size; only then does it write backup/last-proof-backup-status.json, which
# monitoring/backup-check.sh checks every morning (no fresh status file = an alert email).
#
# Credentials (env/backup.env, never env/admin.env):
#   PROOF_BACKUP_SOURCE_BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY: a READ-ONLY R2 token scoped
#     to the private bucket (plan §5), so this host can never write or delete a proof.
#   BACKUP_S3_ENDPOINT / _REGION / _BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY: the backups
#     bucket's own token, the one pg-backup.sh already uses.
# Each S3 step runs in its own throwaway amazon/aws-cli container holding exactly one of the two
# tokens (proof-backup-ops.sh). Values travel only through 0600 env files, never argv or a log
# line. The downloaded files exist briefly in a 0700 temp dir, in batches, removed on exit.
#
# Usage: proof-backup.sh [--dry-run]
#   --dry-run  list both buckets and print what WOULD be copied; copies nothing, writes no status.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=./proof-backup-lib.sh
. "$SCRIPT_DIR/proof-backup-lib.sh"

# Same pin as pg-backup.sh: an unattended nightly job never picks up a CLI change by itself.
AWS_CLI_IMAGE="amazon/aws-cli:2.27.49"
OPS_SCRIPT="$SCRIPT_DIR/proof-backup-ops.sh"
STATUS_FILE="$SCRIPT_DIR/last-proof-backup-status.json"
LOCK_DIR="$SCRIPT_DIR/.proof-backup.lock"
BATCH_SIZE=100

# Test harness only (deploy-prod/tests/proof-backup.test.sh): run proof-backup-ops.sh directly on
# this machine, with a fake `aws` on PATH, instead of inside the aws-cli container. Read from the
# process environment BEFORE env/backup.env is loaded, so that file cannot turn it on; the systemd
# unit never sets it, so on the VPS every S3 step always runs in the container.
LOCAL_RUNNER="${PROOF_BACKUP_LOCAL_RUNNER:-0}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      echo "Usage: $0 [--dry-run]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (only --dry-run is supported)" >&2
      exit 2
      ;;
  esac
done

WORK_DIR=""
HAVE_LOCK=0
cleanup() {
  if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
  if [ "$HAVE_LOCK" -eq 1 ]; then rm -rf "$LOCK_DIR"; fi
}
trap cleanup EXIT

fail() {
  echo "==> FAILED: $1" >&2
  echo "==> No status file written; backup-check.sh will alert if no run succeeds within 26h." >&2
  exit 1
}

echo "==> Loading env/backup.env"
proof_load_env_file "env/backup.env" || fail "could not read env/backup.env"
for v in BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY \
  PROOF_BACKUP_SOURCE_BUCKET PROOF_BACKUP_SOURCE_ACCESS_KEY_ID PROOF_BACKUP_SOURCE_SECRET_ACCESS_KEY; do
  if [ -z "${!v:-}" ]; then
    fail "missing required variable $v in env/backup.env (docs/deploy-prod.md §15)"
  fi
done
SOURCE_BUCKET="$PROOF_BACKUP_SOURCE_BUCKET"
# The S3_KEY_PREFIX the prod admin writes under is empty, so the whole bucket is the source.
SOURCE_PREFIX="${PROOF_BACKUP_SOURCE_PREFIX:-}"
DEST_BUCKET="$BACKUP_S3_BUCKET"
DEST_PREFIX="$PROOF_BACKUP_DEST_PREFIX"
case "$SOURCE_BUCKET" in
  *-private) ;;
  *) fail "PROOF_BACKUP_SOURCE_BUCKET must be the private proof bucket (a name ending in -private)" ;;
esac
if [ "$SOURCE_BUCKET" = "$DEST_BUCKET" ]; then
  fail "PROOF_BACKUP_SOURCE_BUCKET and BACKUP_S3_BUCKET must be different buckets"
fi
if [ "$PROOF_BACKUP_SOURCE_ACCESS_KEY_ID" = "$BACKUP_S3_ACCESS_KEY_ID" ]; then
  fail "PROOF_BACKUP_SOURCE_ACCESS_KEY_ID must be the private bucket's read-only token, not the backups token"
fi

# One run at a time (the timer and a manual run could overlap). mkdir is atomic; a lock left by a
# run that was killed is taken over once its pid is gone, or once it is older than 6 hours (the
# unit's TimeoutStartSec is 2h, so no real run lives that long; this also covers a pid that was
# recycled by an unrelated process after a reboot).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  old_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null && [ -z "$(find "$LOCK_DIR" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then
    fail "another proof-backup.sh run (pid $old_pid) is still in progress"
  fi
  echo "==> Taking over a stale lock (pid ${old_pid:-unknown})"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" || fail "could not take the lock $LOCK_DIR"
fi
HAVE_LOCK=1
echo "$$" >"$LOCK_DIR/pid"

umask 077
WORK_DIR="$(mktemp -d)"
chmod 700 "$WORK_DIR"
mkdir -p "$WORK_DIR/home"

cat >"$WORK_DIR/aws-config" <<'CFG'
[default]
s3 =
    addressing_style = path
CFG

# One env file per token. The S3_*/AWS_* names are the container's own; when_required checksums:
# see pg-backup.sh (harmless against R2).
write_env_file() {
  local file="$1" key_id="$2" secret="$3"
  {
    printf 'AWS_ACCESS_KEY_ID=%s\n' "$key_id"
    printf 'AWS_SECRET_ACCESS_KEY=%s\n' "$secret"
    printf 'AWS_DEFAULT_REGION=%s\n' "$BACKUP_S3_REGION"
    printf 'S3_ENDPOINT=%s\n' "$BACKUP_S3_ENDPOINT"
    printf 'AWS_CONFIG_FILE=%s\n' "$WORK_DIR/aws-config"
    printf 'HOME=%s\n' "$WORK_DIR/home"
    printf 'AWS_REQUEST_CHECKSUM_CALCULATION=when_required\n'
    printf 'AWS_RESPONSE_CHECKSUM_VALIDATION=when_required\n'
  } >"$file"
  chmod 600 "$file"
}
SOURCE_ENV="$WORK_DIR/source.env"
DEST_ENV="$WORK_DIR/dest.env"
write_env_file "$SOURCE_ENV" "$PROOF_BACKUP_SOURCE_ACCESS_KEY_ID" "$PROOF_BACKUP_SOURCE_SECRET_ACCESS_KEY"
write_env_file "$DEST_ENV" "$BACKUP_S3_ACCESS_KEY_ID" "$BACKUP_S3_SECRET_ACCESS_KEY"

# run_ops ENV_FILE OPS_ARGS... — one S3 step with one token. The script dir is mounted read-only
# and the work dir read-write, each at the SAME path inside the container, so every path argument
# means the same thing on both sides. --user: the files it downloads stay owned by deploy (see
# pg-backup.sh's note on curlimages/curl), so this script can remove them.
run_ops() {
  local env_file="$1"
  shift
  if [ "$LOCAL_RUNNER" = "1" ]; then
    (
      proof_load_env_file "$env_file" >/dev/null
      bash "$OPS_SCRIPT" "$@"
    )
  else
    docker run --rm \
      --user "$(id -u):$(id -g)" \
      --env-file "$env_file" \
      -v "$SCRIPT_DIR:$SCRIPT_DIR:ro" \
      -v "$WORK_DIR:$WORK_DIR" \
      --entrypoint /bin/bash \
      "$AWS_CLI_IMAGE" \
      "$OPS_SCRIPT" "$@"
  fi
}

list_bucket() {
  local env_file="$1" bucket="$2" prefix="$3" out="$4"
  run_ops "$env_file" list "$bucket" "$prefix" "$out.raw" || return 1
  proof_normalize_listing <"$out.raw" >"$out"
}

echo "==> Listing the private bucket (read-only token)"
list_bucket "$SOURCE_ENV" "$SOURCE_BUCKET" "$SOURCE_PREFIX" "$WORK_DIR/source.all" || fail "could not list the private bucket"
echo "==> Listing ${DEST_PREFIX} in the backups bucket"
list_bucket "$DEST_ENV" "$DEST_BUCKET" "$DEST_PREFIX" "$WORK_DIR/dest.list" || fail "could not list the backups bucket"

# Unsafe keys (anything buildPrivateFileKey would never produce) are never copied, and they fail
# the run at the end so someone looks; every safe key is still backed up first.
: >"$WORK_DIR/source.list"
: >"$WORK_DIR/unsafe.list"
while IFS="$(printf '\t')" read -r key size || [ -n "${key:-}" ]; do
  [ -z "$key" ] && continue
  if proof_key_is_safe "$key" && [ "$size" != "?" ]; then
    printf '%s\t%s\n' "$key" "$size" >>"$WORK_DIR/source.list"
  else
    printf '%s\n' "$key" >>"$WORK_DIR/unsafe.list"
  fi
done <"$WORK_DIR/source.all"
UNSAFE_COUNT="$(wc -l <"$WORK_DIR/unsafe.list" | tr -d ' ')"
SOURCE_COUNT="$(wc -l <"$WORK_DIR/source.list" | tr -d ' ')"

proof_keys_to_copy "$WORK_DIR/source.list" "$WORK_DIR/dest.list" "$DEST_PREFIX" >"$WORK_DIR/todo.list"
TODO_COUNT="$(wc -l <"$WORK_DIR/todo.list" | tr -d ' ')"
echo "==> ${SOURCE_COUNT} object(s) in the private bucket, ${TODO_COUNT} not backed up yet"

# Proofs are never deleted (no delete path in the app, optional bucket lock on prod), so the
# private bucket can only grow. Fewer objects than the last successful run means the wrong bucket,
# prefix or token, or that proofs were removed: fail loudly rather than report a green backup.
PREVIOUS_COUNT="$(proof_status_source_objects "$STATUS_FILE")"
if [ -n "$PREVIOUS_COUNT" ] && [ "$SOURCE_COUNT" -lt "$PREVIOUS_COUNT" ]; then
  fail "the private bucket lists ${SOURCE_COUNT} object(s), fewer than the ${PREVIOUS_COUNT} of the last successful run: proofs are never deleted, check the bucket, prefix and token (and whether anything was removed)"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> DRY RUN: would copy ${TODO_COUNT} object(s) to s3://${DEST_BUCKET}/${DEST_PREFIX} (first 20 shown):"
  head -n 20 "$WORK_DIR/todo.list" | cut -f1 | sed 's/^/  /'
  if [ "$UNSAFE_COUNT" -gt 0 ]; then
    echo "==> DRY RUN: ${UNSAFE_COUNT} object(s) with an unexpected key would be skipped and fail the run"
  fi
  echo "==> DRY RUN: nothing copied, no status file written"
  exit 0
fi

COPIED=0
if [ "$TODO_COUNT" -gt 0 ]; then
  split -l "$BATCH_SIZE" "$WORK_DIR/todo.list" "$WORK_DIR/batch."
  for batch in "$WORK_DIR"/batch.*; do
    data="$WORK_DIR/data"
    mkdir -p "$data"
    run_ops "$SOURCE_ENV" download "$SOURCE_BUCKET" "$batch" "$data" || fail "downloading from the private bucket failed"
    run_ops "$DEST_ENV" upload "$DEST_BUCKET" "$DEST_PREFIX" "$batch" "$data" || fail "uploading to the backups bucket failed"
    COPIED=$((COPIED + $(wc -l <"$batch" | tr -d ' ')))
    rm -rf "$data"
  done
fi
echo "==> Copied ${COPIED} object(s)"

echo "==> Verifying: every private object has a same-size copy under ${DEST_PREFIX}"
list_bucket "$DEST_ENV" "$DEST_BUCKET" "$DEST_PREFIX" "$WORK_DIR/dest.after" || fail "could not re-list the backups bucket"
proof_verify_copies "$WORK_DIR/source.list" "$WORK_DIR/dest.after" "$DEST_PREFIX" >"$WORK_DIR/problems.list"
if [ -s "$WORK_DIR/problems.list" ]; then
  head -n 20 "$WORK_DIR/problems.list" | sed 's/^/  /' >&2
  fail "$(wc -l <"$WORK_DIR/problems.list" | tr -d ' ') object(s) have no matching copy in the backups bucket"
fi
if [ "$UNSAFE_COUNT" -gt 0 ]; then
  head -n 20 "$WORK_DIR/unsafe.list" | sed 's/^/  skipped: /' >&2
  fail "${UNSAFE_COUNT} object(s) in the private bucket have an unexpected key and were not copied"
fi

TIMESTAMP="$(TZ=Asia/Jakarta date +%Y-%m-%d_%H%M)"
proof_status_json "$TIMESTAMP" "$SOURCE_COUNT" "$COPIED" "s3://${DEST_BUCKET}/${DEST_PREFIX}" >"$STATUS_FILE.tmp"
chmod 644 "$STATUS_FILE.tmp"
mv "$STATUS_FILE.tmp" "$STATUS_FILE"
echo "==> Proof backup complete: ${SOURCE_COUNT} object(s) backed up, ${COPIED} new this run"
