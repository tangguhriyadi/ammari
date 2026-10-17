#!/usr/bin/env bash
# Automates docs/runbooks/restore-drill.md's "Drill: restore into a disposable local Postgres"
# section (docs/plans/prod-deploy.md §4 step 20, §6 "Restore drill", Session 8). Run this ON THE
# OWNER'S OWN MAC, with Docker Desktop running — NEVER against the real prod `db` container, and
# NEVER touches the real `ammari` database (CLAUDE.md's local-safety rule). This script never even
# reads a prod DATABASE_URL — it only needs S3 read access (to fetch a backup object) and the
# backup encryption key, so there is no code path by which it could reach the real prod database.
#
# What it does:
#   1. Reads S3 credentials from ~/ammari-secrets/prod-admin.env and PG_BACKUP_ENCRYPTION_KEY from
#      ~/ammari-secrets/prod-backup.env — loaded into THIS SCRIPT's own environment only. Never
#      printed, never passed as a command-line argument to anything (same `-pass env:` /
#      `--env-file` discipline deploy-prod/backup/pg-backup.sh itself uses to encrypt these dumps).
#   2. Lists s3://<bucket>/backups/daily/ via a throwaway, pinned aws-cli container (path-style
#      addressing, same as pg-backup.sh/backup-check.sh) and downloads the newest object.
#   3. Decrypts it with openssl (the same aes-256-cbc/pbkdf2 pg-backup.sh used to encrypt it).
#   4. Starts a throwaway pgvector/pg16 container, published on a RANDOM local port (Docker picks
#      an ephemeral host port via `-p 127.0.0.1:0:5432` — never a fixed port that could collide
#      with a developer's own local Postgres), and restores the dump into it.
#   5. Prints row counts for the tables docs/plans/prod-deploy.md §4 step 20 names: staff users,
#      products, product variants, homepage sections, info pages, store settings.
#   6. Removes the container, its network, and every temp file this script created — on success
#      OR failure (EXIT trap) — nothing from this drill is left running or on disk afterward.
#
# Usage: deploy-prod/restore-drill-local.sh [--admin-env PATH] [--backup-env PATH] [--object KEY]
#   --admin-env PATH    override ~/ammari-secrets/prod-admin.env (testing only)
#   --backup-env PATH   override ~/ammari-secrets/prod-backup.env (testing only)
#   --object KEY        restore this exact backups/daily/<KEY> or backups/weekly/<KEY> object
#                        instead of auto-picking the newest backups/daily/ one
set -uo pipefail

AWS_CLI_IMAGE="amazon/aws-cli:2.27.49"
PG_IMAGE="pgvector/pgvector:pg16"

ADMIN_ENV="$HOME/ammari-secrets/prod-admin.env"
BACKUP_ENV="$HOME/ammari-secrets/prod-backup.env"
OBJECT_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --admin-env)
      ADMIN_ENV="$2"
      shift 2
      ;;
    --backup-env)
      BACKUP_ENV="$2"
      shift 2
      ;;
    --object)
      OBJECT_OVERRIDE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--admin-env PATH] [--backup-env PATH] [--object KEY]" >&2
      exit 2
      ;;
  esac
done

DB_USER="ammari"
DB_NAME="ammari_scratch"
DB_PASSWORD="$(openssl rand -hex 16)"
RUN_ID="$$-$(date +%s)"
CONTAINER_NAME="ammari-restore-drill-db-${RUN_ID}"
NETWORK_NAME="ammari-restore-drill-${RUN_ID}"

TMP_FILES=()
track_tmp() { TMP_FILES+=("$1"); }

cleanup() {
  local f
  echo "==> Cleaning up (container, network, temp files)..."
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  for f in "${TMP_FILES[@]:-}"; do
    [ -n "$f" ] && rm -rf "$f"
  done
  # Never leave the decryption key (or anything else loaded from the two env files) sitting in
  # this shell's environment past the point this script actually needs it.
  unset PG_BACKUP_ENCRYPTION_KEY S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_ENDPOINT S3_REGION S3_BUCKET 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "==> FAILED: $1" >&2
  exit 1
}

# Reads plain "KEY=value" lines without ever invoking `source`/`.` — same discipline as
# deploy-prod/backup/pg-backup.sh's own copy of this function (a value containing `$` or
# backticks must never be interpreted as shell syntax during load).
load_env_file() {
  local file="$1" line key value
  if [ ! -f "$file" ]; then
    echo "Missing env file: $file" >&2
    return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "" | "#"*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    printf -v "$key" '%s' "$value"
    # shellcheck disable=SC2163 # $key holds a VARIABLE NAME here (just set via printf -v above),
    # not a literal — `export "$key"` exports the name it expands to, which is exactly the point.
    export "$key"
  done <"$file"
}

command -v docker >/dev/null 2>&1 || fail "docker is not on PATH — install/start Docker Desktop first"
docker info >/dev/null 2>&1 || fail "docker daemon is not reachable — is Docker Desktop running?"

echo "==> Loading S3 credentials from $ADMIN_ENV and the backup key from $BACKUP_ENV"
load_env_file "$ADMIN_ENV" || fail "could not read $ADMIN_ENV (run deploy-prod/make-prod-env.sh first if this is a fresh machine)"
load_env_file "$BACKUP_ENV" || fail "could not read $BACKUP_ENV"

for v in S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  [ -n "${!v:-}" ] || fail "missing $v in $ADMIN_ENV"
done
[ -n "${PG_BACKUP_ENCRYPTION_KEY:-}" ] || fail "missing PG_BACKUP_ENCRYPTION_KEY in $BACKUP_ENV"

WORKDIR="$(mktemp -d)"
track_tmp "$WORKDIR"

# Single 0600 env file for every throwaway aws-cli container below — never passed via `-e` on
# argv (which would show up in `docker inspect`/`ps`), same pattern pg-backup.sh itself uses.
AWS_ENV_FILE="$WORKDIR/aws.env"
cat >"$AWS_ENV_FILE" <<ENVEOF
AWS_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}
AWS_DEFAULT_REGION=${S3_REGION}
ENVEOF
chmod 600 "$AWS_ENV_FILE"

# Forces path-style addressing — same reason pg-backup.sh/backup-check.sh and
# packages/storage/src/s3-client.ts all hardcode this for this same Cloudeka endpoint.
AWS_CONFIG_SCRIPT="$WORKDIR/aws-config.sh"
cat >"$AWS_CONFIG_SCRIPT" <<'EOS'
mkdir -p "$HOME/.aws"
cat > "$HOME/.aws/config" <<'CFG'
[default]
s3 =
    addressing_style = path
CFG
EOS

OBJECT_KEY="$OBJECT_OVERRIDE"
if [ -z "$OBJECT_KEY" ]; then
  echo "==> Listing s3://${S3_BUCKET}/backups/daily/ to find the newest backup"
  LISTING="$(docker run --rm \
    --env-file "$AWS_ENV_FILE" \
    -v "$AWS_CONFIG_SCRIPT:/aws-config.sh:ro" \
    --entrypoint /bin/bash \
    "$AWS_CLI_IMAGE" \
    -c "source /aws-config.sh && aws s3 ls 's3://${S3_BUCKET}/backups/daily/' --endpoint-url '${S3_ENDPOINT}'" 2>/dev/null || true)"

  if [ -z "$LISTING" ]; then
    fail "no objects found under s3://${S3_BUCKET}/backups/daily/ — has pg-backup.timer run at least once yet? See docs/deploy-prod.md §5.2"
  fi

  # Object names (YYYY-MM-DD_HHMM.dump.enc) sort lexicographically == chronologically — same
  # technique pg-backup.sh's own prune() function relies on.
  NEWEST_NAME="$(printf '%s\n' "$LISTING" | awk '{print $4}' | sort | tail -n1)"
  OBJECT_KEY="backups/daily/${NEWEST_NAME}"
fi
echo "==> Using backup object: s3://${S3_BUCKET}/${OBJECT_KEY}"

echo "==> Downloading and decrypting"
DOWNLOAD_SCRIPT="$WORKDIR/download.sh"
cat >"$DOWNLOAD_SCRIPT" <<EOS
source /aws-config.sh
aws s3 cp "s3://${S3_BUCKET}/${OBJECT_KEY}" /out/dump.enc --endpoint-url "${S3_ENDPOINT}"
EOS

if ! docker run --rm \
  --env-file "$AWS_ENV_FILE" \
  -v "$AWS_CONFIG_SCRIPT:/aws-config.sh:ro" \
  -v "$DOWNLOAD_SCRIPT:/download.sh:ro" \
  -v "$WORKDIR:/out" \
  --entrypoint /bin/bash \
  "$AWS_CLI_IMAGE" \
  /download.sh; then
  fail "download of s3://${S3_BUCKET}/${OBJECT_KEY} failed"
fi
[ -s "$WORKDIR/dump.enc" ] || fail "downloaded dump.enc is empty"

# `-pass env:PG_BACKUP_ENCRYPTION_KEY` — the key is already exported into THIS script's own
# environment only (load_env_file above); it never appears in a command's argv, same rule
# pg-backup.sh itself follows for the encrypt side.
if ! openssl enc -d -aes-256-cbc -pbkdf2 -pass env:PG_BACKUP_ENCRYPTION_KEY \
  -in "$WORKDIR/dump.enc" -out "$WORKDIR/dump.custom"; then
  fail "decryption failed — wrong PG_BACKUP_ENCRYPTION_KEY, or the object is not a dump pg-backup.sh produced"
fi
[ -s "$WORKDIR/dump.custom" ] || fail "decrypted dump.custom is empty"
echo "==> Decrypted $(du -h "$WORKDIR/dump.custom" | cut -f1) custom-format dump"

echo "==> Starting a disposable Postgres (never the real 'ammari' database)"
docker network create "$NETWORK_NAME" >/dev/null || fail "could not create docker network $NETWORK_NAME"

if ! docker run -d --name "$CONTAINER_NAME" \
  --network "$NETWORK_NAME" \
  -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB="$DB_NAME" \
  -p 127.0.0.1:0:5432 \
  "$PG_IMAGE" >/dev/null; then
  fail "could not start the disposable Postgres container"
fi

HOST_PORT="$(docker port "$CONTAINER_NAME" 5432/tcp | head -n1 | cut -d: -f2)"
echo "==> Disposable Postgres listening on 127.0.0.1:${HOST_PORT:-unknown} (container: $CONTAINER_NAME, db: $DB_NAME)"

ready=0
for attempt in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    ready=1
    break
  fi
  echo "==> waiting for Postgres to accept connections (attempt $attempt/30)..."
  sleep 2
done
[ "$ready" -eq 1 ] || fail "disposable Postgres never became ready"

echo "==> Restoring the dump"
docker cp "$WORKDIR/dump.custom" "$CONTAINER_NAME:/tmp/dump.custom"
if ! docker exec "$CONTAINER_NAME" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl /tmp/dump.custom; then
  fail "pg_restore failed — see its own output above"
fi

echo "==> Row counts (restored copy, docs/plans/prod-deploy.md §4 step 20):"
ROW_COUNTS="$(docker exec "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -At -F'|' -c "
  select 'staff_auth_users (staff users)', count(*) from staff_auth_users
  union all select 'products', count(*) from products
  union all select 'product_variants', count(*) from product_variants
  union all select 'storefront_homepage_sections (homepage sections)', count(*) from storefront_homepage_sections
  union all select 'info_pages', count(*) from info_pages
  union all select 'store_settings', count(*) from store_settings;
")" || fail "row count query failed"

printf '%s\n' "$ROW_COUNTS" | while IFS='|' read -r table count; do
  printf '  %-50s %s\n' "$table" "$count"
done

echo "==> Restore drill complete — s3://${S3_BUCKET}/${OBJECT_KEY} restores cleanly."
