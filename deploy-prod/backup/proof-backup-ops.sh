#!/bin/bash
# The S3 half of proof-backup.sh. Never run by hand: proof-backup.sh runs it inside a throwaway,
# pinned amazon/aws-cli container (the host only needs Docker, same as pg-backup.sh), once per
# step, each time with ONE token's credentials in the environment: the private bucket's
# read-only token for `list`/`download` of the source, the backups bucket's token for `list`/
# `upload` of the destination. So the step that writes can never see the proof bucket's
# credentials, and the step that reads the proof bucket holds a token that cannot write or delete
# there. There is no delete, sync or move here, by design.
#
#   proof-backup-ops.sh list BUCKET PREFIX OUT_FILE
#   proof-backup-ops.sh download BUCKET LIST_FILE DIR          (LIST_FILE: "KEY<TAB>SIZE" lines)
#   proof-backup-ops.sh upload BUCKET DEST_PREFIX LIST_FILE DIR
#
# S3_ENDPOINT and AWS_* come from the env file proof-backup.sh passes; AWS_CONFIG_FILE points at a
# config forcing path-style addressing (same reason as pg-backup.sh). Bash 3.2 compatible: the
# tests run it on macOS with a fake `aws`.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./proof-backup-lib.sh
. "$SELF_DIR/proof-backup-lib.sh"

: "${S3_ENDPOINT:?S3_ENDPOINT is not set}"

cmd="${1:-}"
case "$cmd" in
  list)
    aws s3api list-objects-v2 --bucket "$2" --prefix "$3" --query 'Contents[].[Key,Size]' --output text \
      --endpoint-url "$S3_ENDPOINT" >"$4"
    ;;
  download)
    while IFS="$(printf '\t')" read -r key _size || [ -n "${key:-}" ]; do
      [ -z "$key" ] && continue
      proof_key_is_safe "$key" || { echo "refusing unsafe key" >&2; exit 1; }
      aws s3 cp "s3://$2/$key" "$4/$key" --only-show-errors --endpoint-url "$S3_ENDPOINT"
    done <"$3"
    ;;
  upload)
    while IFS="$(printf '\t')" read -r key _size || [ -n "${key:-}" ]; do
      [ -z "$key" ] && continue
      proof_key_is_safe "$key" || { echo "refusing unsafe key" >&2; exit 1; }
      aws s3 cp "$5/$key" "s3://$2/$3$key" --content-type "$(proof_content_type "$key")" --only-show-errors \
        --endpoint-url "$S3_ENDPOINT"
      echo "copied $key"
    done <"$4"
    ;;
  *)
    echo "usage: proof-backup-ops.sh list|download|upload ..." >&2
    exit 2
    ;;
esac
