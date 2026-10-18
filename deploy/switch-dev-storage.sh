#!/usr/bin/env bash
# Runs ON THE OWNER'S OWN MAC (macOS, stock bash 3.2: never rely on bash-4+ syntax in THIS
# file). Switches dev's object storage from Cloudeka to Cloudflare R2 by editing env/admin.env
# and env/web.env directly on the dev VPS over SSH, in place. Dev keeps no local
# ~/ammari-secrets/dev-*.env source of truth the way prod does (docs/plans/storage-r2.md), so
# there is no local file to regenerate and this script is the one place that performs the edit.
#
# Changes ONLY: S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and
# STORAGE_PUBLIC_BASE_URL in env/admin.env; STORAGE_PUBLIC_BASE_URL in env/web.env. Every other
# line, including S3_KEY_PREFIX (stays dev/) and every non-storage secret, is left byte-for-byte
# untouched. Backs up each file on the VPS first, as <name>.env.bak.<UTC timestamp>, mode 600.
#
# Never prints a secret value and never passes one as a command-line argument to any external
# program (so it never shows up in `ps` on either side). The R2 dev access/secret key are read
# from local files into shell variables, quoted with bash's own `printf '%q'` builtin (never the
# external printf(1)), and prepended as two literal assignment lines directly in front of
# switch-dev-storage-remote.sh's own text. The whole combined document is piped to `ssh ... bash
# -s` as ONE write, the same proven channel go-live-check.sh already uses to send a whole script
# remotely. See switch-dev-storage-remote.sh's own header for why an earlier revision's
# "send the script, then read two more lines from the same stdin" idea was dropped as unreliable.
#
# Usage: deploy/switch-dev-storage.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REMOTE_SCRIPT_FILE="$SCRIPT_DIR/switch-dev-storage-remote.sh"

SECRETS_DIR="$HOME/ammari-secrets"
KEY_FILE="$SECRETS_DIR/ammari_deploy_key"
ACCESS_KEY_FILE="$SECRETS_DIR/r2-dev-access-key"
SECRET_KEY_FILE="$SECRETS_DIR/r2-dev-secret-key"
REMOTE_USER="deploy"
REMOTE_HOST="43.129.55.61"

for f in "$KEY_FILE" "$ACCESS_KEY_FILE" "$SECRET_KEY_FILE" "$REMOTE_SCRIPT_FILE"; do
  if [ ! -f "$f" ]; then
    echo "Missing $f" >&2
    exit 1
  fi
done

access_key="$(cat "$ACCESS_KEY_FILE")"
secret_key="$(cat "$SECRET_KEY_FILE")"
if [ -z "$access_key" ] || [ -z "$secret_key" ]; then
  echo "r2-dev-access-key / r2-dev-secret-key must not be empty" >&2
  exit 1
fi

quoted_access_key=""
quoted_secret_key=""
printf -v quoted_access_key '%q' "$access_key"
printf -v quoted_secret_key '%q' "$secret_key"

echo "Switching dev object storage to R2 on ${REMOTE_USER}@${REMOTE_HOST}:/opt/ammari ..."
{
  printf 'S3_ACCESS_KEY_ID=%s\n' "$quoted_access_key"
  printf 'S3_SECRET_ACCESS_KEY=%s\n' "$quoted_secret_key"
  cat "$REMOTE_SCRIPT_FILE"
} | ssh -i "$KEY_FILE" -o StrictHostKeyChecking=yes "${REMOTE_USER}@${REMOTE_HOST}" bash -s

echo
echo "Done. See the BACKUP:/CHANGED: lines above for exactly what was touched (never a value)."
echo "Next (manual, by the owner):"
echo "  ssh -i $KEY_FILE ${REMOTE_USER}@${REMOTE_HOST}"
echo "  cd /opt/ammari && docker compose up -d --force-recreate admin web"
echo "Then verify per docs/plans/storage-r2.md's dev switch-order steps (storage:check, a real upload, upload-timing log)."
