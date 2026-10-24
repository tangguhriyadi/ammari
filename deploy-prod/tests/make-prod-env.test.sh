#!/usr/bin/env bash
# check() evals its condition later on purpose, so single quotes and "unused" variables are fine.
# shellcheck disable=SC2016,SC2034
# Tests for deploy-prod/make-prod-env.sh's private proof storage keys (docs/plans/
# purchase-payments.md §5, A7): PRIVATE_S3_* into prod-admin.env, PROOF_BACKUP_SOURCE_* into
# prod-backup.env, from ~/ammari-secrets files, never printing a value. Runs against a throwaway
# HOME (the script honors $HOME), no network, no server. Run from the repo root with the stock
# macOS bash and with a modern one:
#   /bin/bash deploy-prod/tests/make-prod-env.test.sh
#   bash deploy-prod/tests/make-prod-env.test.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/make-prod-env.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

SECRETS="$WORK/home/ammari-secrets"
mkdir -p "$SECRETS"
# Built at runtime, never real.
tok() { printf '%s-%s%s' "$1" "$RANDOM" "$RANDOM"; }
MEDIA_KEY="$(tok media-key)"
PRIV_KEY="$(tok priv-key)"
PRIV_SECRET="$(tok priv-secret)/+="
RO_KEY="$(tok ro-key)"
RO_SECRET="$(tok ro-secret)"
put() { (umask 077 && printf '%s' "$2" >"$SECRETS/$1"); }
put prod-resend-api-key "$(tok resend)"
put r2-prod-access-key "$MEDIA_KEY"
put r2-prod-secret-key "$(tok media-secret)"
put r2-backups-access-key "$(tok backups-key)"
put r2-backups-secret-key "$(tok backups-secret)"
put r2-prod-private-access-key "$PRIV_KEY"
put r2-prod-private-secret-key "$PRIV_SECRET"
put r2-prod-private-readonly-access-key "$RO_KEY"
put r2-prod-private-readonly-secret-key "$RO_SECRET"
printf 'GOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n' "$(tok gid)" "$(tok gsecret)" >"$SECRETS/dev-admin.env"

run() { HOME="$WORK/home" bash "$SCRIPT" "$@" </dev/null 2>&1; }
value_of() { grep "^$2=" "$1" | tail -n 1 | cut -d= -f2-; }
no_private_secret_in() { [[ "$1" != *"$PRIV_KEY"* && "$1" != *"$PRIV_SECRET"* && "$1" != *"$RO_KEY"* && "$1" != *"$RO_SECRET"* ]]; }

ADMIN="$SECRETS/prod-admin.env"
BACKUP="$SECRETS/prod-backup.env"

# 1. Default mode writes the three admin and three backup keys from the files.
out="$(run)"
rc=$?
check "default mode exits 0" '[ $rc -eq 0 ]'
check "admin: PRIVATE_S3_BUCKET is the private bucket" '[ "$(value_of "$ADMIN" PRIVATE_S3_BUCKET)" = "ammari-prod-private" ]'
check "admin: private read & write token written literally" '[ "$(value_of "$ADMIN" PRIVATE_S3_ACCESS_KEY_ID)" = "$PRIV_KEY" ] && [ "$(value_of "$ADMIN" PRIVATE_S3_SECRET_ACCESS_KEY)" = "$PRIV_SECRET" ]'
check "backup: source is the private bucket with the READ-ONLY token" \
  '[ "$(value_of "$BACKUP" PROOF_BACKUP_SOURCE_BUCKET)" = "ammari-prod-private" ] && [ "$(value_of "$BACKUP" PROOF_BACKUP_SOURCE_ACCESS_KEY_ID)" = "$RO_KEY" ] && [ "$(value_of "$BACKUP" PROOF_BACKUP_SOURCE_SECRET_ACCESS_KEY)" = "$RO_SECRET" ]'
check "the read-only token never lands in admin.env, the read & write one never in backup.env" \
  '! grep -q "$RO_KEY" "$ADMIN" && ! grep -q "$PRIV_KEY" "$BACKUP"'
check "validation lists the new keys as set" '[[ "$out" == *"PRIVATE_S3_SECRET_ACCESS_KEY: set"* ]] && [[ "$out" == *"PROOF_BACKUP_SOURCE_SECRET_ACCESS_KEY: set"* ]]'
check "output never contains a private-bucket value" 'no_private_secret_in "$out"'

# 2. --storage-only on files that predate this session: the new lines are appended, every other
#    line stays byte-for-byte, a rerun changes nothing.
grep -v '^PRIVATE_S3_' "$ADMIN" >"$WORK/a" && cat "$WORK/a" >"$ADMIN"
grep -v '^PROOF_BACKUP_' "$BACKUP" >"$WORK/b" && cat "$WORK/b" >"$BACKUP"
auth_before="$(value_of "$ADMIN" STAFF_BETTER_AUTH_SECRET)"
key_before="$(value_of "$BACKUP" PG_BACKUP_ENCRYPTION_KEY)"
out="$(run --storage-only)"
rc=$?
check "--storage-only exits 0" '[ $rc -eq 0 ]'
check "--storage-only adds PRIVATE_S3_* and PROOF_BACKUP_SOURCE_*" \
  '[ "$(value_of "$ADMIN" PRIVATE_S3_ACCESS_KEY_ID)" = "$PRIV_KEY" ] && [ "$(value_of "$BACKUP" PROOF_BACKUP_SOURCE_ACCESS_KEY_ID)" = "$RO_KEY" ]'
check "--storage-only reports names only" '[[ "$out" == *"PRIVATE_S3_ACCESS_KEY_ID: changed"* ]] && [[ "$out" == *"PROOF_BACKUP_SOURCE_SECRET_ACCESS_KEY: OK"* ]] && no_private_secret_in "$out"'
check "--storage-only leaves the auth secret and the backup encryption key alone" \
  '[ "$(value_of "$ADMIN" STAFF_BETTER_AUTH_SECRET)" = "$auth_before" ] && [ "$(value_of "$BACKUP" PG_BACKUP_ENCRYPTION_KEY)" = "$key_before" ]'
out="$(run --storage-only)"
check "--storage-only rerun changes nothing" '[ $? -eq 0 ] && [[ "$out" != *": changed"* ]]'

# 3. Refusals: a missing key file by name, the media token reused, the read & write token reused.
mv "$SECRETS/r2-prod-private-readonly-secret-key" "$WORK/held"
out="$(run --storage-only)"
check "missing read-only secret file refused, by file name" '[ $? -ne 0 ] && [[ "$out" == *"r2-prod-private-readonly-secret-key"* ]] && no_private_secret_in "$out"'
mv "$WORK/held" "$SECRETS/r2-prod-private-readonly-secret-key"
put r2-prod-private-access-key "$MEDIA_KEY"
out="$(run --storage-only)"
check "the media token as private token is refused" '[ $? -ne 0 ] && [[ "$out" == *"MEDIA token"* ]] && [[ "$out" != *"$MEDIA_KEY"* ]]'
put r2-prod-private-access-key "$PRIV_KEY"
put r2-prod-private-readonly-access-key "$PRIV_KEY"
out="$(run --storage-only)"
check "the read & write token as the backup host's token is refused" '[ $? -ne 0 ] && [[ "$out" == *"Object Read only"* ]] && no_private_secret_in "$out"'

put r2-prod-private-readonly-access-key "$RO_KEY"
put r2-prod-private-secret-key "$(printf '%s\nINJECTED=1' "$PRIV_SECRET")"
out="$(run --storage-only)"
check "a multi-line key file is refused (no line injection)" '[ $? -ne 0 ] && [[ "$out" == *"more than one line"* ]] && ! grep -q "^INJECTED=" "$ADMIN" && no_private_secret_in "$out"'

echo "bash ${BASH_VERSION}: ${FAILS} failure(s)"
[ "$FAILS" -eq 0 ]
