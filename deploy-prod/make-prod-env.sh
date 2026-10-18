#!/usr/bin/env bash
# Runs ON THE OWNER'S OWN MAC (macOS, zsh login shell, LibreSSL `openssl` — this script's
# shebang pins bash regardless), never on a server (docs/plans/prod-deploy.md §4 step 10).
# Builds ~/ammari-secrets/prod-admin.env, prod-web.env, prod-db.env and prod-backup.env from
# deploy-prod/env/*.example, generating fresh secrets with `openssl rand` and reusing a few
# already-provisioned values instead of prompting for them again. Never prints a secret value to
# the terminal and never writes one into this repo.
#
# Usage: deploy-prod/make-prod-env.sh [--force]
#   (no args)  Refuses to touch any ~/ammari-secrets/prod-*.env that already exists.
#   --force    Overwrites an existing prod-*.env, but backs it up first as
#              prod-<name>.env.bak.<UTC timestamp> in the same directory.
#
# $HOME is honored as-is (not hardcoded) so this can be dry-run against a throwaway HOME, e.g.:
#   HOME=/tmp/fake-home deploy-prod/make-prod-env.sh
#
# What it reads (never echoed):
#   ~/ammari-secrets/prod-resend-api-key   Required. Raw key value, no "KEY=" prefix, no
#                                          trailing newline required either way (step 8).
#   ~/ammari-secrets/dev-admin.env         Optional, and ONLY for Google OAuth. If
#                                          GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET exist there with
#                                          non-empty values, reused as-is (same Google OAuth
#                                          client — docs/plans/prod-deploy.md §4 step 9). Either
#                                          one not found there is asked for interactively with a
#                                          hidden prompt (`read -s`) instead — never echoed,
#                                          never logged.
#
#                                          S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY are NEVER read
#                                          from this file, even if present — prod's Cloudeka
#                                          bucket (step 7) has its OWN access key, separate from
#                                          dev's. These two are ALWAYS asked for interactively
#                                          with a hidden prompt, every run.
#
# What it generates fresh (openssl rand), one secret, many destinations where the plan requires
# the SAME value in more than one file:
#   STAFF_BETTER_AUTH_SECRET, CUSTOMER_BETTER_AUTH_SECRET   independent, admin-only/web-only
#   REVALIDATE_SECRET, PREVIEW_SECRET                       generated ONCE each, written
#                                                            identically to admin.env AND web.env
#   Postgres password                                       generated ONCE, written to
#                                                            prod-db.env's POSTGRES_PASSWORD and
#                                                            into DATABASE_URL in BOTH
#                                                            prod-admin.env and prod-web.env (the
#                                                            migrator reuses admin.env's
#                                                            DATABASE_URL at run time — see
#                                                            deploy-prod/remote-deploy.sh — so
#                                                            there is no separate migrator file)
#   PG_BACKUP_ENCRYPTION_KEY                                prod-backup.env only
#
# The Postgres password is generated with `openssl rand -hex 24`, not -base64, specifically
# because it gets embedded directly inside a postgresql:// URL below — base64's `+`, `/`, `=`
# alphabet would need percent-encoding there and a stray `/` risks confusing a naive URL parser;
# hex has no such characters.
#
# At the end, runs a validation pass that prints ONLY key names and whether each is set, still
# empty, or still a placeholder — plus a SHA-256 hash comparison (never the values themselves)
# confirming REVALIDATE_SECRET and PREVIEW_SECRET actually match between admin and web.
set -euo pipefail

# Never let a secret value leak into argv (visible to other local users via `ps`) or into a
# debug trace. If anyone ever adds `set -x` to this file during debugging, remove it before the
# next real run — every `openssl`/file write below assumes secrets travel only through stdin,
# variables, and file content, never a command-line argument.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_EXAMPLE_DIR="$REPO_ROOT/deploy-prod/env"
SECRETS_DIR="$HOME/ammari-secrets"
DEV_ADMIN_ENV="$SECRETS_DIR/dev-admin.env"
RESEND_KEY_FILE="$SECRETS_DIR/prod-resend-api-key"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force)
      FORCE=1
      ;;
    -h | --help)
      echo "Usage: $0 [--force]"
      echo "Builds ~/ammari-secrets/prod-{admin,web,db,backup}.env. See the header comment in"
      echo "this file for exactly what it reads, generates, and writes."
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (only --force is supported)" >&2
      exit 1
      ;;
  esac
done

# Everything this script creates must start life as owner-only (0600 files, 0700 dirs) — belt
# and suspenders alongside the explicit chmod calls below, which cover files copied via `cp`
# (cp's own default mode is umask-filtered from 0666, not inherited from the source).
umask 077

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

for example in admin.env.example web.env.example db.env.example backup.env.example; do
  if [[ ! -f "$ENV_EXAMPLE_DIR/$example" ]]; then
    echo "Missing $ENV_EXAMPLE_DIR/$example — can't continue." >&2
    exit 1
  fi
done

if [[ ! -f "$RESEND_KEY_FILE" ]]; then
  echo "Missing $RESEND_KEY_FILE — put the prod Resend API key there first (plan §4 step 8)." >&2
  exit 1
fi

ADMIN_DEST="$SECRETS_DIR/prod-admin.env"
WEB_DEST="$SECRETS_DIR/prod-web.env"
DB_DEST="$SECRETS_DIR/prod-db.env"
BACKUP_DEST="$SECRETS_DIR/prod-backup.env"

# --- Overwrite protection -----------------------------------------------------------------
backup_if_forcing() {
  local dest="$1"
  if [[ ! -e "$dest" ]]; then
    return 0
  fi
  if [[ "$FORCE" -ne 1 ]]; then
    echo "Refusing to overwrite existing $dest (pass --force to overwrite; a timestamped backup is made first)." >&2
    exit 1
  fi
  local ts backup_path
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_path="${dest}.bak.${ts}"
  cp -p "$dest" "$backup_path"
  chmod 600 "$backup_path"
  echo "Backed up existing $(basename "$dest") -> $(basename "$backup_path")"
}

for dest in "$ADMIN_DEST" "$WEB_DEST" "$DB_DEST" "$BACKUP_DEST"; do
  backup_if_forcing "$dest"
done

# --- Helpers -------------------------------------------------------------------------------

# Replaces the whole line "KEY=..." in FILE with "KEY=VALUE", by rewriting line-by-line into a
# temp file rather than sed/awk — avoids ANY special-character escaping (a base64 value can
# contain "/", "+", "=", none of which need to be safe for this to work). Never prints VALUE.
set_env_var() {
  local file="$1" key="$2" value="$3"
  local tmp found
  tmp="$(mktemp "${file}.XXXXXX")"
  found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${key}="* ]]; then
      printf '%s=%s\n' "$key" "$value" >>"$tmp"
      found=1
    else
      printf '%s\n' "$line" >>"$tmp"
    fi
  done <"$file"
  if [[ "$found" -ne 1 ]]; then
    rm -f "$tmp"
    echo "set_env_var: $key not found in $file" >&2
    return 1
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# Reads KEY's value out of FILE (plain "KEY=value" lines) without ever printing it — the caller
# captures stdout via command substitution. Empty value or missing key both return non-zero.
get_env_value() {
  local file="$1" key="$2"
  local line value
  if [[ ! -f "$file" ]]; then
    return 1
  fi
  line="$(grep -m1 "^${key}=" "$file" || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi
  value="${line#"${key}"=}"
  if [[ -z "$value" ]]; then
    return 1
  fi
  printf '%s' "$value"
}

# Hidden prompt (read -s) — the prompt text goes to stderr, the typed value is returned on
# stdout for the caller to capture; it is never echoed to the terminal.
prompt_secret() {
  local msg="$1" value
  printf '%s: ' "$msg" >&2
  read -r -s value
  printf '\n' >&2
  printf '%s' "$value"
}

# Tries dev-admin.env first (same Google client / same Cloudeka account, per the plan), then
# falls back to a hidden prompt. Logs ONLY which source was used, never the value.
resolve_from_dev_or_prompt() {
  local label="$1" dev_key="$2" value
  if value="$(get_env_value "$DEV_ADMIN_ENV" "$dev_key")"; then
    echo "Reusing $label from dev-admin.env." >&2
    printf '%s' "$value"
    return 0
  fi
  prompt_secret "Enter $label (not found in dev-admin.env, won't echo)"
}

# --- Resend key (required, never prompted) --------------------------------------------------
resend_key="$(cat "$RESEND_KEY_FILE")"
if [[ -z "$resend_key" ]]; then
  echo "$RESEND_KEY_FILE is empty." >&2
  exit 1
fi

# --- Google OAuth (reused from dev-admin.env if present, else hidden prompt) ----------------
google_client_id="$(resolve_from_dev_or_prompt "Google OAuth client ID" "GOOGLE_CLIENT_ID")"
google_client_secret="$(resolve_from_dev_or_prompt "Google OAuth client secret" "GOOGLE_CLIENT_SECRET")"

# --- S3 (prod's OWN Cloudeka access key — NEVER dev's, always a hidden prompt) ---------------
s3_access_key_id="$(prompt_secret "Enter prod S3 access key ID (ammariprod-cdy2yf — NOT dev's key, won't echo)")"
s3_secret_access_key="$(prompt_secret "Enter prod S3 secret access key (ammariprod-cdy2yf — NOT dev's key, won't echo)")"

# --- Fresh secrets (openssl rand, generated ONCE where shared across files) ----------------
staff_better_auth_secret="$(openssl rand -base64 32)"
customer_better_auth_secret="$(openssl rand -base64 32)"
revalidate_secret="$(openssl rand -base64 32)"
preview_secret="$(openssl rand -base64 32)"
postgres_password="$(openssl rand -hex 24)"
backup_encryption_key="$(openssl rand -base64 48)"

postgres_user="ammari"
postgres_db="ammari"
database_url="postgresql://${postgres_user}:${postgres_password}@db:5432/${postgres_db}?sslmode=disable"

# --- Build the four files from their .example templates ------------------------------------
echo "Writing $ADMIN_DEST"
cp "$ENV_EXAMPLE_DIR/admin.env.example" "$ADMIN_DEST"
chmod 600 "$ADMIN_DEST"
set_env_var "$ADMIN_DEST" "DATABASE_URL" "$database_url"
set_env_var "$ADMIN_DEST" "BETTER_AUTH_URL" "https://admin.ammari.id"
set_env_var "$ADMIN_DEST" "MAIN_SITE_URL" "https://ammari.id"
set_env_var "$ADMIN_DEST" "STAFF_BETTER_AUTH_SECRET" "$staff_better_auth_secret"
set_env_var "$ADMIN_DEST" "GOOGLE_CLIENT_ID" "$google_client_id"
set_env_var "$ADMIN_DEST" "GOOGLE_CLIENT_SECRET" "$google_client_secret"
set_env_var "$ADMIN_DEST" "RESEND_API_KEY" "$resend_key"
set_env_var "$ADMIN_DEST" "WEB_INTERNAL_URL" "http://web:3000"
set_env_var "$ADMIN_DEST" "REVALIDATE_SECRET" "$revalidate_secret"
set_env_var "$ADMIN_DEST" "PREVIEW_SECRET" "$preview_secret"
set_env_var "$ADMIN_DEST" "S3_ENDPOINT" "https://kencana.basic.box.cloudeka.id"
set_env_var "$ADMIN_DEST" "S3_REGION" "kencana"
set_env_var "$ADMIN_DEST" "S3_BUCKET" "ammariprod-cdy2yf"
set_env_var "$ADMIN_DEST" "S3_ACCESS_KEY_ID" "$s3_access_key_id"
set_env_var "$ADMIN_DEST" "S3_SECRET_ACCESS_KEY" "$s3_secret_access_key"
set_env_var "$ADMIN_DEST" "S3_KEY_PREFIX" ""

echo "Writing $WEB_DEST"
cp "$ENV_EXAMPLE_DIR/web.env.example" "$WEB_DEST"
chmod 600 "$WEB_DEST"
set_env_var "$WEB_DEST" "DATABASE_URL" "$database_url"
set_env_var "$WEB_DEST" "BETTER_AUTH_URL" "https://ammari.id"
set_env_var "$WEB_DEST" "CUSTOMER_BETTER_AUTH_SECRET" "$customer_better_auth_secret"
set_env_var "$WEB_DEST" "GOOGLE_CLIENT_ID" "$google_client_id"
set_env_var "$WEB_DEST" "GOOGLE_CLIENT_SECRET" "$google_client_secret"
set_env_var "$WEB_DEST" "RESEND_API_KEY" "$resend_key"
set_env_var "$WEB_DEST" "REVALIDATE_SECRET" "$revalidate_secret"
set_env_var "$WEB_DEST" "PREVIEW_SECRET" "$preview_secret"
set_env_var "$WEB_DEST" "DEPLOY_ENV" "production"
set_env_var "$WEB_DEST" "STOREFRONT_CART_ENABLED" "false"

echo "Writing $DB_DEST"
cp "$ENV_EXAMPLE_DIR/db.env.example" "$DB_DEST"
chmod 600 "$DB_DEST"
set_env_var "$DB_DEST" "POSTGRES_USER" "$postgres_user"
set_env_var "$DB_DEST" "POSTGRES_PASSWORD" "$postgres_password"
set_env_var "$DB_DEST" "POSTGRES_DB" "$postgres_db"

echo "Writing $BACKUP_DEST"
cp "$ENV_EXAMPLE_DIR/backup.env.example" "$BACKUP_DEST"
chmod 600 "$BACKUP_DEST"
set_env_var "$BACKUP_DEST" "PG_BACKUP_ENCRYPTION_KEY" "$backup_encryption_key"
set_env_var "$BACKUP_DEST" "ALERT_EMAIL_TO" "ammariofc@gmail.com,mtangguh97@gmail.com"
# TODO(docs/plans/storage-r2.md Session 3): this leaves BACKUP_S3_ENDPOINT/BACKUP_S3_REGION/
# BACKUP_S3_BUCKET/BACKUP_S3_ACCESS_KEY_ID/BACKUP_S3_SECRET_ACCESS_KEY at backup.env.example's
# empty placeholders — fill them by hand (or via Session 3's --storage-only mode, once it exists)
# rather than adding real prompts/reads here now. Deliberately NOT wired up in this session:
# doing so would mean every `--force` run of this script (which currently regenerates EVERY
# secret, not just storage ones) also re-prompts for/rewrites the backup bucket's credentials —
# exactly the unnecessary-secret-rotation risk Session 3 exists to fix with a storage-only mode.
# See the plan's "Decisions" §2 (hard requirement, not optional) before adding anything here.

unset staff_better_auth_secret customer_better_auth_secret revalidate_secret preview_secret \
  postgres_password backup_encryption_key resend_key google_client_id google_client_secret \
  s3_access_key_id s3_secret_access_key database_url

# --- Validation (key names and status ONLY — never a value) --------------------------------

# Some keys are deliberately left for the owner to fill by hand (either this script has no
# confirmed value for them yet, or an empty value is the intended one) — flagged as such rather
# than as a plain, alarming "EMPTY".
is_known_optional() {
  case "$1" in
    S3_KEY_PREFIX | OTP_GLOBAL_HOURLY_CAP | STORE_WHATSAPP_NUMBER | EMAIL_FROM | STORAGE_PUBLIC_BASE_URL)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

validate_file() {
  local file="$1" key value
  echo "  $(basename "$file"):"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    if [[ -z "$value" ]]; then
      if is_known_optional "$key"; then
        echo "    $key: empty (optional / fill by hand if needed)"
      else
        echo "    $key: EMPTY — needs a value"
      fi
    elif [[ "$value" == *"<"*">"* ]]; then
      echo "    $key: PLACEHOLDER — needs a value"
    else
      echo "    $key: set"
    fi
  done <"$file"
}

echo
echo "=== Validation (key names only — no secret values are ever printed) ==="
validate_file "$ADMIN_DEST"
validate_file "$WEB_DEST"
validate_file "$DB_DEST"
validate_file "$BACKUP_DEST"

hash_of() {
  openssl dgst -sha256 <<<"$1" | awk '{print $NF}'
}

echo
echo "  Shared-secret consistency:"
for shared_key in REVALIDATE_SECRET PREVIEW_SECRET; do
  admin_value="$(get_env_value "$ADMIN_DEST" "$shared_key" || true)"
  web_value="$(get_env_value "$WEB_DEST" "$shared_key" || true)"
  if [[ -z "$admin_value" || -z "$web_value" ]]; then
    echo "    $shared_key: cannot compare (empty in admin.env or web.env)"
    continue
  fi
  if [[ "$(hash_of "$admin_value")" == "$(hash_of "$web_value")" ]]; then
    echo "    $shared_key: MATCH between prod-admin.env and prod-web.env"
  else
    echo "    $shared_key: MISMATCH between prod-admin.env and prod-web.env"
  fi
  unset admin_value web_value
done

echo
echo "Done. Next: deploy-prod/upload-prod-env.sh to copy these four files to the VPS (plan §4 step 12)."
