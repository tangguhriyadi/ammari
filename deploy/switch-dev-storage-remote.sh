#!/usr/bin/env bash
# Never executed directly (no +x needed). deploy/switch-dev-storage.sh prepends two literal
# `S3_ACCESS_KEY_ID=...`/`S3_SECRET_ACCESS_KEY=...` assignment lines (safely quoted with bash's
# `printf '%q'`) in front of this file's own bytes, and pipes the combined text, as ONE single
# document, never two separately-timed writes, to `ssh ... bash -s`. This file's own shebang is
# here only for editor/shellcheck syntax detection; it actually runs under whatever bash ships on
# the dev VPS (Ubuntu's default, bash 5.x) via that `bash -s`, so it has no bash-3.2 constraint.
# Kept in its own file rather than inlined in the Mac-side script for the same reason as
# deploy-prod/go-live-check-remote.sh (see that file's own header): a confirmed macOS-stock-bash
# (3.2) lexer bug around heredocs containing this kind of content.
#
# Earlier revision of this script tried to receive the two key values via `read` calls pulling
# extra lines appended AFTER this script on the same stdin stream. That trick is NOT reliable:
# bash reads piped script source into its own lookahead buffer, and a `read` later in the script
# can end up pulling from bytes already buffered rather than making a fresh read(): confirmed
# directly (a minimal repro handed `read -r A; read -r B` a script-line as `A`'s value instead of
# the intended first data line). Embedding the values as literal assignments that are part of the
# single script text bash parses top-to-bottom, like any other line below, has no such hazard.
# It's the same mechanism go-live-check.sh/go-live-check-remote.sh already rely on for sending a
# whole script over this exact channel, just with two more (safely-quoted) lines in it.
set -uo pipefail

if [ -z "${S3_ACCESS_KEY_ID:-}" ] || [ -z "${S3_SECRET_ACCESS_KEY:-}" ]; then
  echo "FATAL:empty-key"
  exit 1
fi

cd /opt/ammari || { echo "FATAL:cd"; exit 1; }

# Non-secret R2 constants for dev (same values as docs/plans/storage-r2.md and the owner
# checklist there). Only the two key values above travel over stdin; everything else is a
# literal here, same convention as deploy-prod/make-prod-env.sh's R2_* constants.
S3_ENDPOINT="https://d99c5045ed359887e8fdd591cc492ee9.r2.cloudflarestorage.com"
S3_REGION="auto"
S3_BUCKET="ammari-dev"
STORAGE_PUBLIC_BASE_URL="https://img.ammari.my.id"

for f in env/admin.env env/web.env; do
  if [ ! -f "$f" ]; then
    echo "FATAL:missing:$f"
    exit 1
  fi
done

ts="$(date -u +%Y%m%dT%H%M%SZ)"

backup_file() {
  local file="$1" backup
  backup="${file}.bak.${ts}"
  cp -p "$file" "$backup"
  chmod 600 "$backup"
  echo "BACKUP:$(basename "$file"):$(basename "$backup")"
}

# Sets KEY=VALUE in FILE in place, only if KEY already exists there and its current value
# differs. Prints only the key NAME when it actually changes, never a value. Silently does
# nothing if KEY isn't present in FILE at all (e.g. web.env has no S3_* vars other than
# STORAGE_PUBLIC_BASE_URL).
set_if_present() {
  local file="$1" key="$2" value="$3" old_line old tmp
  old_line="$(grep -m1 "^${key}=" "$file" 2>/dev/null || true)"
  if [ -z "$old_line" ]; then
    return 0
  fi
  old="${old_line#"${key}"=}"
  if [ "$old" = "$value" ]; then
    return 0
  fi
  tmp="$(mktemp "${file}.XXXXXX")"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "${key}="*) printf '%s=%s\n' "$key" "$value" >>"$tmp" ;;
      *) printf '%s\n' "$line" >>"$tmp" ;;
    esac
  done <"$file"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
  echo "CHANGED:$(basename "$file"):$key"
}

backup_file env/admin.env
backup_file env/web.env

set_if_present env/admin.env S3_ENDPOINT "$S3_ENDPOINT"
set_if_present env/admin.env S3_REGION "$S3_REGION"
set_if_present env/admin.env S3_BUCKET "$S3_BUCKET"
set_if_present env/admin.env S3_ACCESS_KEY_ID "$S3_ACCESS_KEY_ID"
set_if_present env/admin.env S3_SECRET_ACCESS_KEY "$S3_SECRET_ACCESS_KEY"
set_if_present env/admin.env STORAGE_PUBLIC_BASE_URL "$STORAGE_PUBLIC_BASE_URL"
set_if_present env/web.env STORAGE_PUBLIC_BASE_URL "$STORAGE_PUBLIC_BASE_URL"

echo "REMOTE_DONE:0"
