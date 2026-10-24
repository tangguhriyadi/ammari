#!/usr/bin/env bash
# check() evals its condition later on purpose, so single quotes and "unused" variables are fine.
# shellcheck disable=SC2016,SC2034
# Tests for deploy-prod/backup/proof-backup.sh, proof-backup-ops.sh and proof-backup-lib.sh (the
# nightly copy of private proof files into the backups bucket, docs/plans/purchase-payments.md A7).
# No network, no Docker, no real bucket: proof-backup.sh runs with PROOF_BACKUP_LOCAL_RUNNER=1 and a
# fake `aws` on PATH that keeps each "bucket" as a directory and enforces which token may do what.
# Run from the repo root with the stock macOS bash and with a modern one:
#   /bin/bash deploy-prod/tests/proof-backup.test.sh
#   bash deploy-prod/tests/proof-backup.test.sh
set -uo pipefail

BACKUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../backup" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# shellcheck source=../backup/proof-backup-lib.sh
. "$BACKUP_DIR/proof-backup-lib.sh"
TAB="$(printf '\t')"

# ---------------------------------------------------------------- lib: pure helpers

check "safe key: what buildPrivateFileKey produces" 'proof_key_is_safe "payment_proof/2026/10/0b5c1a52-6c1f-4c55-9b0e-4c9a3f3c2d11.jpg"'
check "safe key: with an S3_KEY_PREFIX" 'proof_key_is_safe "dev/purchase_invoice/2026/10/abc.pdf"'
for unsafe in "" "/abs/key.jpg" "a/../b.jpg" "a//b.jpg" "dir/" "has space.jpg" 'semi;colon.jpg' "quote\".jpg" "new
line.jpg"; do
  check "unsafe key refused: [$unsafe]" '! proof_key_is_safe "$unsafe"'
done

got="$(printf 'b/2.pdf\t20\r\nNone\n\na/1.jpg\t10\nweird line\n' | proof_normalize_listing)"
expected="$(printf 'a/1.jpg\t10\nb/2.pdf\t20\nweird line\t?')"
check "listing: sorted, None/blank/CR dropped, malformed line kept with size ?" '[ "$got" = "$expected" ]'
check "listing: empty bucket (a lone None) is empty" '[ -z "$(printf "None\n" | proof_normalize_listing)" ]'

printf 'a/1.jpg\t10\nb/2.pdf\t20\nc/3.jpg\t30\n' >"$WORK/src.list"
printf 'private-files/a/1.jpg\t10\nprivate-files/c/3.jpg\t99\nprivate-files/z/old.jpg\t5\n' >"$WORK/dst.list"
check "keys_to_copy: only keys the destination lacks (a present one is never re-copied, even at another size)" \
  '[ "$(proof_keys_to_copy "$WORK/src.list" "$WORK/dst.list" "private-files/")" = "b/2.pdf${TAB}20" ]'
: >"$WORK/empty.list"
check "keys_to_copy: an empty destination listing means everything (a first run)" \
  '[ "$(proof_keys_to_copy "$WORK/src.list" "$WORK/empty.list" "private-files/" | wc -l | tr -d " ")" = "3" ]'
check "verify: an empty destination listing reports every key missing" \
  '[ "$(proof_verify_copies "$WORK/src.list" "$WORK/empty.list" "private-files/" | grep -c "^missing")" = "3" ]'
got="$(proof_verify_copies "$WORK/src.list" "$WORK/dst.list" "private-files/")"
check "verify: reports the missing copy and the size mismatch, not the extra backup-only object" \
  '[ "$got" = "$(printf "missing: b/2.pdf\nsize differs: c/3.jpg (source 30, backup 99)")" ]'
check "verify: nothing to report when every copy matches" \
  '[ -z "$(proof_verify_copies "$WORK/src.list" "$WORK/src.list" "")" ]'

check "content type: jpg" '[ "$(proof_content_type a/b.jpg)" = "image/jpeg" ]'
check "content type: pdf" '[ "$(proof_content_type a/b.pdf)" = "application/pdf" ]'
check "content type: anything else" '[ "$(proof_content_type a/b.bin)" = "application/octet-stream" ]'

proof_status_json "2026-10-24_0245" 12 3 "s3://bk/private-files/" >"$WORK/status.json"
check "status json round-trips its timestamp" '[ "$(proof_status_timestamp "$WORK/status.json")" = "2026-10-24_0245" ]'
check "status json carries the counts" 'grep -q "\"source_objects\": 12" "$WORK/status.json" && grep -q "\"copied\": 3" "$WORK/status.json"'

epoch="$(proof_ts_to_epoch "2026-10-24_0245")"
check "timestamp parses as Asia/Jakarta (UTC+7)" '[ "$epoch" = "1792784700" ]'
check "garbage timestamp does not parse" '! proof_ts_to_epoch "yesterday" >/dev/null'
check "status issue: fresh run is fine" '[ -z "$(proof_status_issue "$WORK/status.json" $((epoch + 3600)) 26)" ]'
check "status issue: stale after 26h" '[[ "$(proof_status_issue "$WORK/status.json" $((epoch + 27 * 3600)) 26)" == *"is stale"* ]]'
check "status issue: missing file" '[[ "$(proof_status_issue "$WORK/nope.json" "$epoch" 26)" == *"missing"* ]]'
check "status issue: a timestamp in the future" '[[ "$(proof_status_issue "$WORK/status.json" $((epoch - 2 * 3600)) 26)" == *"in the future"* ]]'
check "status source_objects is read back" '[ "$(proof_status_source_objects "$WORK/status.json")" = "12" ]'
check "no status file, no previous count" '[ -z "$(proof_status_source_objects "$WORK/nope.json")" ]'
printf '{"timestamp": "soon"}' >"$WORK/bad.json"
check "status issue: unparseable timestamp" '[[ "$(proof_status_issue "$WORK/bad.json" "$epoch" 26)" == *"could not be parsed"* ]]'
printf '{}' >"$WORK/empty.json"
check "status issue: no timestamp field" '[[ "$(proof_status_issue "$WORK/empty.json" "$epoch" 26)" == *"no parseable"* ]]'

# ---------------------------------------------------------------- proof-backup.sh end to end

# Built at runtime, never real; the script's output must never contain any of them.
RO_KEY="ro-AKID-$RANDOM$RANDOM"
RO_SECRET="ro-SECRET-$RANDOM$RANDOM"
BK_KEY="bk-AKID-$RANDOM$RANDOM"
BK_SECRET="bk-SECRET-$RANDOM$RANDOM"

S3="$WORK/s3"
mkdir -p "$S3/ammari-prod-private" "$S3/ammari-prod-backups/backups/daily" "$WORK/bin" "$WORK/root/backup" "$WORK/root/env"
cp "$BACKUP_DIR/proof-backup.sh" "$BACKUP_DIR/proof-backup-ops.sh" "$BACKUP_DIR/proof-backup-lib.sh" "$WORK/root/backup/"
LOG="$WORK/aws.log"
: >"$LOG"

# The fake aws: bucket = directory. The private bucket only answers the read-only token and
# refuses every write; the backups bucket only answers the backups token. Anything that is not a
# list or a cp (rm, mv, sync, delete-object, put-object...) is logged as FORBIDDEN and fails.
cat >"$WORK/bin/aws" <<'FAKE'
#!/bin/bash
set -u
log() { printf '%s\n' "$*" >>"$FAKE_AWS_LOG"; }
key_for() { case "$1" in "$FAKE_SOURCE_BUCKET") echo "$FAKE_SOURCE_KEY" ;; "$FAKE_DEST_BUCKET") echo "$FAKE_DEST_KEY" ;; *) echo "-" ;; esac; }
deny_unless() { if [ "${AWS_ACCESS_KEY_ID:-}" != "$(key_for "$1")" ]; then log "DENIED $2 $1 with ${AWS_ACCESS_KEY_ID:-none}"; echo "AccessDenied" >&2; exit 255; fi; }
[ -n "${AWS_CONFIG_FILE:-}" ] && grep -q "addressing_style = path" "$AWS_CONFIG_FILE" || { log "NO-PATH-STYLE"; exit 3; }
args=()
content_type=""
while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint-url | --query | --output) shift 2 ;;
    --content-type) content_type="$2"; shift 2 ;;
    --only-show-errors) shift ;;
    *) args+=("$1"); shift ;;
  esac
done
if [ "${args[0]}" = "s3api" ] && [ "${args[1]}" = "list-objects-v2" ]; then
  bucket="" prefix=""
  i=2
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      --bucket) bucket="${args[$((i + 1))]}"; i=$((i + 2)) ;;
      --prefix) prefix="${args[$((i + 1))]}"; i=$((i + 2)) ;;
      *) i=$((i + 1)) ;;
    esac
  done
  deny_unless "$bucket" list
  log "LIST $bucket $prefix"
  found=0
  while IFS= read -r rel; do
    case "$rel" in "$prefix"*) ;; *) continue ;; esac
    printf '%s\t%s\n' "$rel" "$(wc -c <"$FAKE_S3_ROOT/$bucket/$rel" | tr -d ' ')"
    found=1
  done < <(cd "$FAKE_S3_ROOT/$bucket" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)
  [ "$found" -eq 0 ] && echo "None"
  exit 0
fi
if [ "${args[0]}" = "s3" ] && [ "${args[1]}" = "cp" ]; then
  src="${args[2]}" dst="${args[3]}"
  case "$src" in
    s3://*)
      path="${src#s3://}"; bucket="${path%%/*}"; key="${path#*/}"
      deny_unless "$bucket" read
      mkdir -p "$(dirname "$dst")"
      cp "$FAKE_S3_ROOT/$bucket/$key" "$dst" || exit 1
      log "GET $bucket $key"
      ;;
    *)
      path="${dst#s3://}"; bucket="${path%%/*}"; key="${path#*/}"
      if [ "$bucket" = "$FAKE_SOURCE_BUCKET" ]; then log "SOURCE-WRITE $key"; exit 1; fi
      deny_unless "$bucket" write
      [ -e "$FAKE_S3_ROOT/$bucket/$key" ] && log "OVERWRITE $bucket $key"
      mkdir -p "$(dirname "$FAKE_S3_ROOT/$bucket/$key")"
      cp "$src" "$FAKE_S3_ROOT/$bucket/$key" || exit 1
      log "PUT $bucket $key $content_type"
      ;;
  esac
  exit 0
fi
log "FORBIDDEN ${args[*]}"
exit 1
FAKE
chmod +x "$WORK/bin/aws"

write_backup_env() {
  {
    echo "# test env"
    echo "PG_BACKUP_ENCRYPTION_KEY=unused"
    echo "BACKUP_S3_ENDPOINT=https://fake.r2.example"
    echo "BACKUP_S3_REGION=auto"
    echo "BACKUP_S3_BUCKET=ammari-prod-backups"
    echo "BACKUP_S3_ACCESS_KEY_ID=$BK_KEY"
    echo "BACKUP_S3_SECRET_ACCESS_KEY=$BK_SECRET"
    echo "PROOF_BACKUP_SOURCE_BUCKET=${1-ammari-prod-private}"
    echo "PROOF_BACKUP_SOURCE_ACCESS_KEY_ID=${2-$RO_KEY}"
    echo "PROOF_BACKUP_SOURCE_SECRET_ACCESS_KEY=$RO_SECRET"
  } >"$WORK/root/env/backup.env"
}

put_source() {
  mkdir -p "$(dirname "$S3/ammari-prod-private/$1")"
  printf '%s' "$2" >"$S3/ammari-prod-private/$1"
}

STATUS="$WORK/root/backup/last-proof-backup-status.json"
run_backup() {
  PATH="$WORK/bin:$PATH" PROOF_BACKUP_LOCAL_RUNNER=1 \
    FAKE_AWS_LOG="$LOG" FAKE_S3_ROOT="$S3" \
    FAKE_SOURCE_BUCKET=ammari-prod-private FAKE_SOURCE_KEY="$RO_KEY" \
    FAKE_DEST_BUCKET=ammari-prod-backups FAKE_DEST_KEY="$BK_KEY" \
    bash "$WORK/root/backup/proof-backup.sh" "$@" 2>&1
}
no_secret_in() { [[ "$1" != *"$RO_SECRET"* && "$1" != *"$BK_SECRET"* && "$1" != *"$RO_KEY"* && "$1" != *"$BK_KEY"* ]]; }
backup_files() { (cd "$S3/ammari-prod-backups" && find . -type f | sed 's|^\./||' | LC_ALL=C sort); }

write_backup_env
put_source "payment_proof/2026/09/11111111-1111-4111-8111-111111111111.jpg" "jpeg-one"
put_source "payment_proof/2026/10/22222222-2222-4222-8222-222222222222.jpg" "jpeg-two!"
put_source "purchase_invoice/2026/10/33333333-3333-4333-8333-333333333333.pdf" "%PDF-1.7 nota"
printf 'dump' >"$S3/ammari-prod-backups/backups/daily/2026-10-24_0215.dump.enc"

# 1. Dry run: lists both sides, copies nothing, writes no status.
out="$(run_backup --dry-run)"
check "dry run exits 0" '[ $? -eq 0 ]'
check "dry run says what it would copy" '[[ "$out" == *"would copy 3 object(s)"* ]] && [[ "$out" == *"purchase_invoice/2026/10/33333333-3333-4333-8333-333333333333.pdf"* ]]'
check "dry run copies nothing" '[ "$(backup_files)" = "backups/daily/2026-10-24_0215.dump.enc" ] && ! grep -q "^PUT\|^GET" "$LOG"'
check "dry run writes no status file" '[ ! -e "$STATUS" ]'
check "dry run output carries no secret" 'no_secret_in "$out"'

# 2. Real run: everything lands under private-files/, with its content type, nothing else touched.
: >"$LOG"
out="$(run_backup)"
rc=$?
check "first run exits 0" '[ $rc -eq 0 ]'
check "first run copies all three under private-files/" \
  '[ "$(backup_files | grep -c "^private-files/")" = "3" ] && cmp -s "$S3/ammari-prod-private/purchase_invoice/2026/10/33333333-3333-4333-8333-333333333333.pdf" "$S3/ammari-prod-backups/private-files/purchase_invoice/2026/10/33333333-3333-4333-8333-333333333333.pdf"'
check "pg-backup's own objects are untouched" '[ "$(cat "$S3/ammari-prod-backups/backups/daily/2026-10-24_0215.dump.enc")" = "dump" ]'
check "uploads carry the content type" 'grep -q "^PUT ammari-prod-backups private-files/purchase_invoice/.*\.pdf application/pdf$" "$LOG" && grep -q "^PUT ammari-prod-backups private-files/payment_proof/.*\.jpg image/jpeg$" "$LOG"'
check "the private bucket is only ever read with the read-only token, never written" '! grep -q "^DENIED\|^SOURCE-WRITE\|^FORBIDDEN" "$LOG"'
check "status file written with the counts" '[ -f "$STATUS" ] && grep -q "\"source_objects\": 3" "$STATUS" && grep -q "\"copied\": 3" "$STATUS" && grep -q "s3://ammari-prod-backups/private-files/" "$STATUS"'
check "status timestamp is parseable" 'proof_ts_to_epoch "$(proof_status_timestamp "$STATUS")" >/dev/null'
check "run output carries no secret" 'no_secret_in "$out"'
check "temp files and the lock are gone" '[ ! -e "$WORK/root/backup/.proof-backup.lock" ]'

# 3. Idempotent: a second run copies nothing and overwrites nothing.
: >"$LOG"
out="$(run_backup)"
check "second run exits 0 and copies nothing" '[ $? -eq 0 ] && grep -q "\"copied\": 0" "$STATUS" && ! grep -q "^PUT\|^GET" "$LOG"'

# 4. Incremental: only the new object is copied.
put_source "payment_proof/2026/10/44444444-4444-4444-8444-444444444444.jpg" "jpeg-four"
: >"$LOG"
out="$(run_backup)"
check "new object: exactly one GET and one PUT" '[ $? -eq 0 ] && [ "$(grep -c "^GET" "$LOG")" = "1" ] && [ "$(grep -c "^PUT" "$LOG")" = "1" ] && grep -q "\"copied\": 1" "$STATUS"'
check "never an overwrite" '! grep -q "^OVERWRITE" "$LOG"'

# 5. Never deletes: an object gone from the source stays in the backup, and a shrinking source
#    (proofs are never deleted) fails the run instead of reporting a green backup.
before_status="$(cat "$STATUS")"
mv "$S3/ammari-prod-private/payment_proof/2026/09/11111111-1111-4111-8111-111111111111.jpg" "$WORK/held.jpg"
: >"$LOG"
out="$(run_backup)"
rc=$?
check "a shrinking source fails the run" '[ $rc -ne 0 ] && [[ "$out" == *"fewer than the 4 of the last successful run"* ]] && [ "$(cat "$STATUS")" = "$before_status" ]'
check "a source deletion is not mirrored" '[ -f "$S3/ammari-prod-backups/private-files/payment_proof/2026/09/11111111-1111-4111-8111-111111111111.jpg" ]'
check "no delete call ever issued" '! grep -q "^FORBIDDEN" "$LOG"'
mv "$WORK/held.jpg" "$S3/ammari-prod-private/payment_proof/2026/09/11111111-1111-4111-8111-111111111111.jpg"

# 6. A backup copy that differs from its source is never overwritten, and fails the run (alert).
before_status="$(cat "$STATUS")"
printf 'tampered-longer' >"$S3/ammari-prod-backups/private-files/payment_proof/2026/10/22222222-2222-4222-8222-222222222222.jpg"
: >"$LOG"
out="$(run_backup)"
rc=$?
check "size mismatch fails the run" '[ $rc -ne 0 ] && [[ "$out" == *"size differs: payment_proof/2026/10/22222222-2222-4222-8222-222222222222.jpg"* ]]'
check "the differing copy was left alone (no overwrite) and no status written" \
  '[ "$(cat "$S3/ammari-prod-backups/private-files/payment_proof/2026/10/22222222-2222-4222-8222-222222222222.jpg")" = "tampered-longer" ] && ! grep -q "^PUT" "$LOG" && [ "$(cat "$STATUS")" = "$before_status" ]'
printf 'jpeg-two!' >"$S3/ammari-prod-backups/private-files/payment_proof/2026/10/22222222-2222-4222-8222-222222222222.jpg"

# 7. An unexpected key is skipped (never put in a path or URL), the rest is copied, the run fails.
put_source "payment_proof/2026/10/has space.jpg" "odd"
put_source "payment_proof/2026/10/55555555-5555-4555-8555-555555555555.pdf" "%PDF five"
: >"$LOG"
out="$(run_backup)"
rc=$?
check "unsafe key fails the run" '[ $rc -ne 0 ] && [[ "$out" == *"unexpected key"* ]]'
check "the safe new key was still copied, the unsafe one not" \
  '[ -f "$S3/ammari-prod-backups/private-files/payment_proof/2026/10/55555555-5555-4555-8555-555555555555.pdf" ] && [ ! -e "$S3/ammari-prod-backups/private-files/payment_proof/2026/10/has space.jpg" ]'
rm "$S3/ammari-prod-private/payment_proof/2026/10/has space.jpg"
check "with the odd object gone the run succeeds again" '[ -n "$(run_backup)" ] && run_backup >/dev/null'

# 8. Configuration refusals, by NAME, never printing a value.
: >"$LOG"
write_backup_env "ammari-prod-private" ""
out="$(run_backup)"
check "missing read-only key id refused by name" '[ $? -ne 0 ] && [[ "$out" == *"missing required variable PROOF_BACKUP_SOURCE_ACCESS_KEY_ID"* ]] && no_secret_in "$out"'
write_backup_env "ammari-prod" "$RO_KEY"
out="$(run_backup)"
check "a non -private source bucket (the public media bucket) is refused" '[ $? -ne 0 ] && [[ "$out" == *"must be the private proof bucket"* ]]'
write_backup_env "ammari-prod-private" "$BK_KEY"
out="$(run_backup)"
check "the backups token as source token is refused" '[ $? -ne 0 ] && [[ "$out" == *"read-only token"* ]] && no_secret_in "$out"'
check "no S3 call made for a refused config" '[ ! -s "$LOG" ]'
write_backup_env

# 9. Wrong token on the source side is an AccessDenied, which fails the run.
out="$(PATH="$WORK/bin:$PATH" PROOF_BACKUP_LOCAL_RUNNER=1 FAKE_AWS_LOG="$LOG" FAKE_S3_ROOT="$S3" \
  FAKE_SOURCE_BUCKET=ammari-prod-private FAKE_SOURCE_KEY="other-token" \
  FAKE_DEST_BUCKET=ammari-prod-backups FAKE_DEST_KEY="$BK_KEY" \
  bash "$WORK/root/backup/proof-backup.sh" 2>&1)"
check "a token the private bucket refuses fails the run" '[ $? -ne 0 ] && [[ "$out" == *"could not list the private bucket"* ]]'

# 10. One run at a time: a live lock holder is respected, a dead one is taken over.
mkdir "$WORK/root/backup/.proof-backup.lock"
echo "$$" >"$WORK/root/backup/.proof-backup.lock/pid"
out="$(run_backup)"
check "a run in progress (live pid) blocks a second one" '[ $? -ne 0 ] && [[ "$out" == *"still in progress"* ]] && [ -d "$WORK/root/backup/.proof-backup.lock" ]'
touch -t 202001010000 "$WORK/root/backup/.proof-backup.lock"
out="$(run_backup)"
check "a lock older than 6h is taken over even if its pid is alive (recycled pid)" '[ $? -eq 0 ] && [[ "$out" == *"Taking over a stale lock"* ]] && [ ! -e "$WORK/root/backup/.proof-backup.lock" ]'
mkdir "$WORK/root/backup/.proof-backup.lock"
echo "999999" >"$WORK/root/backup/.proof-backup.lock/pid"
out="$(run_backup)"
check "a stale lock (dead pid) is taken over" '[ $? -eq 0 ] && [ ! -e "$WORK/root/backup/.proof-backup.lock" ]'

echo "bash ${BASH_VERSION}: ${FAILS} failure(s)"
[ "$FAILS" -eq 0 ]
