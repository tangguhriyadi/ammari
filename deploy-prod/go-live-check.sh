#!/usr/bin/env bash
# Read-only go-live verification against the REAL prod stack (docs/plans/prod-deploy.md §7 "Go-live
# checklist", Session 8). Run this ON THE OWNER'S OWN MAC — never on the VPS, never by an agent
# session (CLAUDE.md: "No agent session has touched the real VPS, GitHub secrets, or Cloudflare
# settings"). Prints one PASS/FAIL/SKIP line per check plus a final summary, and exits non-zero if
# any check FAILed. Never prints a secret value — every env-file check below either prints a
# non-secret key=value pair explicitly called out as safe to show, or only a key NAME, never a
# value (see the "env-forbidden-keys" section).
#
# Two independent groups of checks:
#   1. EXTERNAL (curl/nc, no SSH) — against the real public hosts and the public S3 endpoint,
#      exactly as any visitor/bot/payment-gateway reviewer or port-scanner would see them.
#   2. SSH (as `deploy`, no sudo, via ~/ammari-secrets/ammari_prod_deploy_key) — internal state
#      only visible from inside the VPS: container health, env file values, monitoring timers,
#      backup freshness, disk/memory. Skipped (not failed) if the key isn't on this machine, or
#      if --skip-ssh is passed.
#
# Facts hardcoded below (VPS IP, S3 endpoint/bucket) are public/non-secret, taken from
# docs/deploy-prod.md §0's own facts table — update both places together if they ever change.
#
# Usage: deploy-prod/go-live-check.sh [--skip-ssh]
set -uo pipefail # NOT -e: every check must run and report, even if an earlier one fails

WEB_HOST="ammari.id"
ADMIN_HOST="admin.ammari.id"
VPS_IP="43.173.52.121"
S3_ENDPOINT="https://kencana.basic.box.cloudeka.id"
S3_BUCKET="ammariprod-cdy2yf"
SSH_KEY="$HOME/ammari-secrets/ammari_prod_deploy_key"
SSH_USER="deploy"
SSH_HOST="$VPS_IP"
CURL_TIMEOUT=10

SKIP_SSH=0
for arg in "$@"; do
  case "$arg" in
    --skip-ssh) SKIP_SSH=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--skip-ssh]" >&2
      exit 2
      ;;
  esac
done

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FAILED_CHECKS=()

pass() {
  echo "PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "FAIL: $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_CHECKS+=("$1")
}

skip() {
  echo "SKIP: $1"
  SKIP_COUNT=$((SKIP_COUNT + 1))
}

info() {
  echo "INFO: $1"
}

BODY_FILE="$(mktemp)"
HEADERS_FILE="$(mktemp)"
# shellcheck disable=SC2329 # invoked indirectly via the EXIT trap below
cleanup() { rm -f "$BODY_FILE" "$HEADERS_FILE"; }
trap cleanup EXIT

# Fetches a URL (any extra curl args are passed through, e.g. -L, -k, --resolve ...), writing the
# response body to $BODY_FILE and headers to $HEADERS_FILE (both overwritten each call — this
# script is single-threaded and always reads them immediately after fetching), and prints the
# HTTP status code on stdout ("000" if the connection/handshake itself failed).
fetch() {
  local url="$1"
  shift
  curl -s -o "$BODY_FILE" -D "$HEADERS_FILE" -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$@" "$url" 2>/dev/null || echo "000"
}

echo "===== EXTERNAL CHECKS (curl/nc, no SSH) ====="

# --- 1. Both hosts reachable over HTTPS and return 200 (following redirects — admin.ammari.id's
#     "/" redirects an unauthenticated visitor to /login by design, see
#     apps/admin/src/app/(shell)/layout.tsx) ---
check_site_up() {
  local host="$1" code
  code="$(fetch "https://${host}/" -L)"
  if [ "$code" = "200" ]; then
    pass "https://${host}/ is reachable over HTTPS and returns 200 (following redirects)"
  else
    fail "https://${host}/ returned $code (expected 200, following redirects)"
  fi
}
check_site_up "$WEB_HOST"
check_site_up "$ADMIN_HOST"

# --- /api/health returns 200 and {"ok":true} on both hosts ---
check_health_ok() {
  local host="$1" code
  code="$(fetch "https://${host}/api/health")"
  if [ "$code" = "200" ] && grep -q '"ok":true' "$BODY_FILE"; then
    pass "https://${host}/api/health returns 200 {\"ok\":true}"
  else
    fail "https://${host}/api/health returned $code (expected 200 {\"ok\":true}; body: $(tr -d '\n' < "$BODY_FILE" | head -c 200))"
  fi
}
check_health_ok "$WEB_HOST"
check_health_ok "$ADMIN_HOST"

# --- 2. Direct-to-origin TLS must be rejected (Cloudflare zone-level Authenticated Origin Pulls —
#     docs/deploy-prod.md §7 troubleshooting's own curl example). `-k` only skips verifying the
#     SERVER's cert; it supplies no CLIENT cert, so the handshake itself must still fail. ---
check_aop_rejected() {
  local host="$1" code rc
  code="$(curl -sk --connect-timeout 10 --max-time "$CURL_TIMEOUT" --resolve "${host}:443:${VPS_IP}" "https://${host}/" -o /dev/null -w '%{http_code}' 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ] && [ "$code" != "200" ]; then
    pass "direct TLS to ${VPS_IP}:443 (Host: ${host}) is rejected (curl exit $rc, no HTTP response) — AOP cert boundary holds"
  else
    fail "direct TLS to ${VPS_IP}:443 (Host: ${host}) was NOT rejected — got HTTP $code (curl exit $rc). Zone-level AOP may be off — see docs/deploy-prod.md §7"
  fi
}
check_aop_rejected "$WEB_HOST"
check_aop_rejected "$ADMIN_HOST"

# --- 3. Internal-only ports must not be reachable from outside the VPS ---
check_port_closed() {
  local port="$1"
  if nc -z -w 5 "$VPS_IP" "$port" 2>/dev/null; then
    fail "TCP port ${port} on ${VPS_IP} IS reachable from outside (expected closed/filtered)"
  else
    pass "TCP port ${port} on ${VPS_IP} is not reachable from outside"
  fi
}
check_port_closed 8080
check_port_closed 8081
check_port_closed 5432

# --- 4. www.ammari.id -> 301 to the apex, preserving path+query (deploy-prod/Caddyfile's
#     `redir https://ammari.id{uri} 301`) ---
check_www_redirect() {
  local probe="/robots.txt?probe=1" code location
  code="$(fetch "https://www.${WEB_HOST}${probe}")"
  location="$(grep -i '^location:' "$HEADERS_FILE" | tr -d '\r' | awk '{print $2}')"
  if [ "$code" = "301" ] && [ "$location" = "https://${WEB_HOST}${probe}" ]; then
    pass "https://www.${WEB_HOST}${probe} -> 301 https://${WEB_HOST}${probe} (path+query preserved)"
  else
    fail "https://www.${WEB_HOST}${probe} returned $code, Location=${location:-<none>} (expected 301 to https://${WEB_HOST}${probe})"
  fi
}
check_www_redirect

# --- 5. /robots.txt allows indexing (confirms DEPLOY_ENV=production took effect at runtime —
#     apps/web/src/app/robots.ts) ---
check_robots() {
  local code
  code="$(fetch "https://${WEB_HOST}/robots.txt")"
  if [ "$code" = "200" ] && grep -qi '^allow: */$' "$BODY_FILE" && ! grep -qi '^disallow: */$' "$BODY_FILE"; then
    pass "https://${WEB_HOST}/robots.txt allows indexing (Allow: /, no Disallow: /)"
  else
    fail "https://${WEB_HOST}/robots.txt check failed (HTTP $code; body: $(tr '\n' ' ' < "$BODY_FILE" | head -c 200))"
  fi
}
check_robots

# --- 6. /api/test/* must 404 at the Caddy layer on both hosts (deploy-prod/Caddyfile) ---
check_api_test_404() {
  local host="$1" code
  code="$(fetch "https://${host}/api/test/anything")"
  if [ "$code" = "404" ]; then
    pass "https://${host}/api/test/anything returns 404"
  else
    fail "https://${host}/api/test/anything returned $code (expected 404)"
  fi
}
check_api_test_404 "$WEB_HOST"
check_api_test_404 "$ADMIN_HOST"

# --- 7. /api/revalidate must 404 on the PUBLIC web host (deploy-prod/Caddyfile's @revalidate
#     block — it's only ever called over the internal Docker network) ---
check_revalidate_404() {
  local code
  code="$(fetch "https://${WEB_HOST}/api/revalidate")"
  if [ "$code" = "404" ]; then
    pass "https://${WEB_HOST}/api/revalidate returns 404 on the public host"
  else
    fail "https://${WEB_HOST}/api/revalidate returned $code (expected 404)"
  fi
}
check_revalidate_404

# --- 8. Security headers present, and NO X-Robots-Tag noindex on the real page (that header is
#     only meant on /preview/home, per apps/web/next.config.ts's own headers()) ---
check_security_headers() {
  local host="$1"
  fetch "https://${host}/" -L >/dev/null
  local hdrs missing=()
  hdrs="$(cat "$HEADERS_FILE")"
  grep -qi '^strict-transport-security:' <<<"$hdrs" || missing+=("Strict-Transport-Security")
  grep -qi '^x-content-type-options:[[:space:]]*nosniff' <<<"$hdrs" || missing+=("X-Content-Type-Options")
  grep -qi '^referrer-policy:' <<<"$hdrs" || missing+=("Referrer-Policy")
  grep -qiE '^x-frame-options:|^content-security-policy:.*frame-ancestors' <<<"$hdrs" || missing+=("frame protection (X-Frame-Options or CSP frame-ancestors)")
  if grep -qi '^x-robots-tag:.*noindex' <<<"$hdrs"; then
    missing+=("X-Robots-Tag: noindex is present on / — should only be on /preview/home")
  fi
  if [ "${#missing[@]}" -eq 0 ]; then
    pass "https://${host}/ has HSTS/X-Content-Type-Options/Referrer-Policy/frame-protection, no stray noindex"
  else
    fail "https://${host}/ security header check failed: $(
      IFS='; '
      echo "${missing[*]}"
    )"
  fi
}
check_security_headers "$WEB_HOST"
check_security_headers "$ADMIN_HOST"

# --- 9. backups/ prefix must stay private — anonymous GET of a (nonexistent) probe key under it
#     must return 403, same semantics packages/storage/src/policy-apply.ts's own verify() relies
#     on: no matching public-read statement means S3 denies existence disclosure too. ---
check_backups_private() {
  local probe_key="backups/_go-live-check-probe-$$.txt" code
  code="$(fetch "${S3_ENDPOINT}/${S3_BUCKET}/${probe_key}")"
  if [ "$code" = "403" ]; then
    pass "anonymous GET of s3://${S3_BUCKET}/${probe_key} returns 403 (backups/ stays private)"
  else
    fail "anonymous GET of s3://${S3_BUCKET}/${probe_key} returned $code (expected 403) — check bucket-policy.prod.json is actually applied"
  fi
}
check_backups_private

# --- 10. PDP's primary CTA is WhatsApp (STOREFRONT_CART_ENABLED=false), if any product page
#     exists yet — SKIP (not FAIL) on a brand-new catalog with nothing published. ---
check_pdp_whatsapp_cta() {
  local code slug
  code="$(fetch "https://${WEB_HOST}/" -L)"
  if [ "$code" != "200" ]; then
    skip "PDP WhatsApp CTA — homepage did not return 200, cannot discover a product slug"
    return
  fi
  slug="$(grep -oE 'href="/products/[^"?#]+' "$BODY_FILE" | head -n1 | sed -E 's#href="/products/##')"
  if [ -z "$slug" ]; then
    skip "PDP WhatsApp CTA — no product link found on the homepage (no products published yet)"
    return
  fi
  local pcode
  pcode="$(fetch "https://${WEB_HOST}/products/${slug}" -L)"
  if [ "$pcode" != "200" ]; then
    fail "product page /products/${slug} (linked from the homepage) returned $pcode"
    return
  fi
  if grep -q 'Tambah ke keranjang' "$BODY_FILE"; then
    fail "product page /products/${slug} renders 'Tambah ke keranjang' — STOREFRONT_CART_ENABLED may be true in prod"
  elif grep -q 'Tanya via WhatsApp' "$BODY_FILE"; then
    pass "product page /products/${slug} CTA is 'Tanya via WhatsApp' (cart disabled)"
  else
    fail "product page /products/${slug} shows neither CTA — store_settings.whatsapp_number is likely empty (§4 step 19)"
  fi
}
check_pdp_whatsapp_cta

echo
echo "===== SSH CHECKS (as deploy, no sudo) ====="

run_ssh_checks() {
  if [ "$SKIP_SSH" = "1" ]; then
    skip "all SSH checks — --skip-ssh was passed"
    return
  fi
  if [ ! -f "$SSH_KEY" ]; then
    skip "all SSH checks — $SSH_KEY not found on this machine"
    return
  fi

  local output
  # Remote script is piped over stdin (bash -s) — never written to disk on the VPS. Fully
  # single-quoted heredoc: every $var below expands ON THE REMOTE SIDE, never on this Mac.
  if ! output="$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=yes -o ConnectTimeout=10 \
    "${SSH_USER}@${SSH_HOST}" bash -s <<'REMOTE_SCRIPT'
set -uo pipefail
cd /opt/ammari-prod || { echo "FATAL:cd"; exit 1; }

container_line() {
  local svc="$1" cid running health
  cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
  if [ -z "$cid" ]; then
    echo "CONTAINER:$svc:missing"
    return
  fi
  running="$(docker inspect --format '{{.State.Running}}' "$cid" 2>/dev/null || echo false)"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo unknown)"
  echo "CONTAINER:$svc:running=$running:health=$health"
}

container_line "db"
container_line "caddy"

admin_slot="$(cat active-slot-admin 2>/dev/null || echo blue)"
web_slot="$(cat active-slot-web 2>/dev/null || echo blue)"
echo "SLOT:admin:$admin_slot"
echo "SLOT:web:$web_slot"
container_line "admin-$admin_slot"
container_line "web-$web_slot"

for pair in "web:8080" "admin:8081"; do
  app="${pair%%:*}"
  port="${pair#*:}"
  if docker compose exec -T caddy curl -sf "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    echo "INTERNALHEALTH:$app:ok"
  else
    echo "INTERNALHEALTH:$app:fail"
  fi
done

if [ -f env/web.env ]; then
  v="$(grep -m1 '^STOREFRONT_CART_ENABLED=' env/web.env || true)"
  echo "ENVKV:web.env:${v:-STOREFRONT_CART_ENABLED=<missing>}"
  v="$(grep -m1 '^DEPLOY_ENV=' env/web.env || true)"
  echo "ENVKV:web.env:${v:-DEPLOY_ENV=<missing>}"
else
  echo "ENVMISSING:web.env"
fi

for f in admin.env web.env db.env backup.env; do
  if [ ! -f "env/$f" ]; then
    echo "ENVMISSING:$f"
    continue
  fi
  for key in NODE_ENV E2E_TEST_LOGIN; do
    if grep -q "^${key}=" "env/$f"; then
      echo "ENVBAD:$f:$key"
    fi
  done
  echo "ENVCHECKED:$f"
done

for t in pg-backup.timer disk-alert.timer backup-check.timer health-check.timer; do
  # No `|| echo unknown` fallback here: `systemctl is-active` always prints the unit's state word
  # (active/inactive/failed/unknown/...) to stdout regardless of its exit code (the exit code is
  # just a boolean signal, not a marker of missing output) — appending `|| echo unknown` after a
  # NONZERO exit would run BOTH commands, so their outputs concatenate into two lines and corrupt
  # every TIMER: line's parsing below. An empty capture (if systemctl ever produced none) already
  # fails the "$state" = "active" check downstream with no fallback needed.
  state="$(systemctl is-active "$t" 2>/dev/null)"
  next="$(systemctl list-timers "$t" --no-pager 2>/dev/null | awk 'NR==2{$1=$1; print}')"
  echo "TIMER:$t:$state:${next:-unknown}"
done

if [ -f backup/last-backup-status.json ]; then
  ts="$(grep -o '"timestamp"[[:space:]]*:[[:space:]]*"[^"]*"' backup/last-backup-status.json | sed -E 's/.*"([^"]+)"[[:space:]]*$/\1/' || true)"
  if [ -n "$ts" ]; then
    date_part="${ts%_*}"
    time_part="${ts#*_}"
    hh="${time_part:0:2}"
    mm="${time_part:2:2}"
    epoch="$(TZ=Asia/Jakarta date -d "$date_part $hh:$mm" +%s 2>/dev/null || echo "")"
    if [ -n "$epoch" ]; then
      now="$(date +%s)"
      echo "BACKUPAGE:$(((now - epoch) / 3600)):$ts"
    else
      echo "BACKUPAGE:unparseable:$ts"
    fi
  else
    echo "BACKUPAGE:no-timestamp"
  fi
else
  echo "BACKUPAGE:missing"
fi

echo "DISK:$(df -h / | awk 'NR==2{print $5" used, "$4" free of "$2}')"
echo "MEM:$(free -h | awk '/^Mem:/{print "used="$3", free="$4", available="$7}')"
echo "REMOTE_DONE:0"
REMOTE_SCRIPT
  )"; then
    fail "SSH to ${SSH_USER}@${SSH_HOST} failed, or the remote script errored — container/env/timer/backup/disk checks were not run"
    return
  fi

  if ! grep -q '^REMOTE_DONE:0$' <<<"$output"; then
    fail "remote check script did not complete (output: $(tr '\n' ' ' <<<"$output" | head -c 300))"
    return
  fi

  # --- containers ---
  local line
  line="$(grep '^CONTAINER:db:' <<<"$output")"
  if [[ "$line" == *"running=true"* && "$line" == *"health=healthy"* ]]; then
    pass "db container is running and healthy"
  else
    fail "db container check failed ($line)"
  fi

  line="$(grep '^CONTAINER:caddy:' <<<"$output")"
  if [[ "$line" == *"running=true"* ]]; then
    pass "caddy container is running"
  else
    fail "caddy container check failed ($line)"
  fi

  local admin_slot web_slot
  admin_slot="$(grep '^SLOT:admin:' <<<"$output" | cut -d: -f3)"
  web_slot="$(grep '^SLOT:web:' <<<"$output" | cut -d: -f3)"

  line="$(grep "^CONTAINER:admin-${admin_slot}:" <<<"$output")"
  if [[ "$line" == *"running=true"* ]]; then
    pass "active admin slot (admin-${admin_slot}) is running"
  else
    fail "active admin slot (admin-${admin_slot}) check failed ($line)"
  fi

  line="$(grep "^CONTAINER:web-${web_slot}:" <<<"$output")"
  if [[ "$line" == *"running=true"* ]]; then
    pass "active web slot (web-${web_slot}) is running"
  else
    fail "active web slot (web-${web_slot}) check failed ($line)"
  fi

  # --- internal health through Caddy ---
  if grep -q '^INTERNALHEALTH:web:ok$' <<<"$output"; then
    pass "internal :8080 web /api/health (through Caddy) is ok"
  else
    fail "internal :8080 web /api/health (through Caddy) failed"
  fi
  if grep -q '^INTERNALHEALTH:admin:ok$' <<<"$output"; then
    pass "internal :8081 admin /api/health (through Caddy) is ok"
  else
    fail "internal :8081 admin /api/health (through Caddy) failed"
  fi

  # --- STOREFRONT_CART_ENABLED / DEPLOY_ENV — printing the key=value pair is explicitly allowed
  #     (both are non-secret flags, not credentials) ---
  if grep -q '^ENVKV:web.env:STOREFRONT_CART_ENABLED=false$' <<<"$output"; then
    pass "web.env: STOREFRONT_CART_ENABLED=false"
  else
    line="$(grep '^ENVKV:web.env:STOREFRONT_CART_ENABLED=' <<<"$output")"
    fail "web.env STOREFRONT_CART_ENABLED is not 'false' (${line#ENVKV:web.env:})"
  fi
  if grep -q '^ENVKV:web.env:DEPLOY_ENV=production$' <<<"$output"; then
    pass "web.env: DEPLOY_ENV=production"
  else
    line="$(grep '^ENVKV:web.env:DEPLOY_ENV=' <<<"$output")"
    fail "web.env DEPLOY_ENV is not 'production' (${line#ENVKV:web.env:})"
  fi

  # --- NODE_ENV / E2E_TEST_LOGIN must not exist in ANY env file — only key NAMES are ever
  #     printed here, never a value (ENVBAD lines above never carried one). ---
  local f
  for f in admin.env web.env db.env backup.env; do
    if grep -q "^ENVMISSING:$f$" <<<"$output"; then
      fail "env/$f is missing on the VPS"
      continue
    fi
    local bad_keys
    bad_keys="$(grep "^ENVBAD:$f:" <<<"$output" | cut -d: -f3 | paste -sd, -)"
    if [ -z "$bad_keys" ]; then
      pass "env/$f has no NODE_ENV or E2E_TEST_LOGIN key"
    else
      fail "env/$f has forbidden key(s): $bad_keys"
    fi
  done

  # --- monitoring timers ---
  local t state
  for t in pg-backup.timer disk-alert.timer backup-check.timer health-check.timer; do
    line="$(grep "^TIMER:$t:" <<<"$output")"
    state="$(cut -d: -f3 <<<"$line")"
    local next_run
    next_run="$(cut -d: -f4- <<<"$line")"
    if [ "$state" = "active" ]; then
      pass "$t is active (next run: ${next_run:-unknown})"
    else
      fail "$t is not active (state: ${state:-unknown})"
    fi
  done

  # --- backup freshness ---
  line="$(grep '^BACKUPAGE:' <<<"$output")"
  local age_field
  age_field="$(cut -d: -f2 <<<"$line")"
  case "$age_field" in
    missing)
      fail "no last-backup-status.json on the VPS — the nightly backup may never have run"
      ;;
    no-timestamp | unparseable)
      fail "last-backup-status.json exists but its timestamp could not be read ($line)"
      ;;
    '')
      fail "could not read backup age from the VPS ($line)"
      ;;
    *)
      if [ "$age_field" -lt 26 ] 2>/dev/null; then
        pass "last backup is ${age_field}h old (< 26h)"
      else
        fail "last backup is ${age_field}h old (>= 26h stale threshold)"
      fi
      ;;
  esac

  # --- disk / memory — informational only, no pass/fail threshold here (disk-alert.timer above
  #     is what actually pages on >=80% disk usage) ---
  info "disk usage (/): $(grep '^DISK:' <<<"$output" | cut -d: -f2-)"
  info "memory usage: $(grep '^MEM:' <<<"$output" | cut -d: -f2-)"
}
run_ssh_checks

echo
echo "===== SUMMARY ====="
echo "PASS: $PASS_COUNT   FAIL: $FAIL_COUNT   SKIP: $SKIP_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo
  echo "Failed checks:"
  printf '  - %s\n' "${FAILED_CHECKS[@]}"
  exit 1
fi
exit 0
