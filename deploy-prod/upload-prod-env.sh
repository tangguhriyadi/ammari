#!/usr/bin/env bash
# Runs ON THE OWNER'S OWN MAC, after deploy-prod/make-prod-env.sh (docs/plans/prod-deploy.md §4
# step 12). Copies the four prod secrets files from ~/ammari-secrets onto the VPS at
# /opt/ammari-prod/env/ over scp, using the prod deploy SSH key, then chmod 600s them remotely.
# Never run on anything but your own Mac; never touches any other host.
#
# Usage: deploy-prod/upload-prod-env.sh
#
# Prints ONLY file names and permissions — never file contents, never a secret value.
set -euo pipefail

SECRETS_DIR="$HOME/ammari-secrets"
KEY_FILE="$SECRETS_DIR/ammari_prod_deploy_key"
REMOTE_USER="deploy"
REMOTE_HOST="43.173.52.121"
REMOTE_DIR="/opt/ammari-prod/env"

if [[ ! -f "$KEY_FILE" ]]; then
  echo "Missing deploy key: $KEY_FILE" >&2
  exit 1
fi

# local filename (under ~/ammari-secrets) : remote filename (what deploy-prod/docker-compose.yml
# actually reads via env_file, e.g. "./env/admin.env" — see Session 1's compose file).
local_to_remote_names="prod-admin.env:admin.env prod-web.env:web.env prod-db.env:db.env prod-backup.env:backup.env"

remote_paths=""
for pair in $local_to_remote_names; do
  local_name="${pair%%:*}"
  remote_name="${pair#*:}"
  local_path="$SECRETS_DIR/$local_name"
  if [[ ! -f "$local_path" ]]; then
    echo "Missing $local_path — run deploy-prod/make-prod-env.sh first." >&2
    exit 1
  fi
  echo "Uploading $local_name -> ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/${remote_name}"
  scp -i "$KEY_FILE" -o StrictHostKeyChecking=yes -p "$local_path" \
    "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/${remote_name}"
  remote_paths="$remote_paths ${REMOTE_DIR}/${remote_name}"
done

echo "Setting remote permissions (chmod 600)..."
# shellcheck disable=SC2086 # remote_paths is a controlled, space-separated list of fixed
# literal paths built above — no user input, nothing to word-split unsafely.
ssh -i "$KEY_FILE" -o StrictHostKeyChecking=yes "${REMOTE_USER}@${REMOTE_HOST}" \
  "chmod 600 $remote_paths"

echo
echo "Remote files now:"
# shellcheck disable=SC2086 # same controlled list as above.
ssh -i "$KEY_FILE" -o StrictHostKeyChecking=yes "${REMOTE_USER}@${REMOTE_HOST}" \
  "ls -l $remote_paths"
