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

# The remote half lives in its own file (go-live-check-remote.sh, same directory) — see that
# file's own header comment for why: a confirmed macOS-stock-bash (3.2) lexer bug where an
# unbalanced `(` or a literal apostrophe in a `#` comment inside a single-quoted heredoc breaks
# parsing of THIS file, even though the exact same text is fine as a normal comment or under
# bash 4+/5. Resolved relative to this script's own location, not the caller's CWD, so this still
# works when invoked as `./go-live-check.sh` from elsewhere or via a relative path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REMOTE_SCRIPT_FILE="$SCRIPT_DIR/go-live-check-remote.sh"

WEB_HOST="ammari.id"
ADMIN_HOST="admin.ammari.id"
MEDIA_HOST="img.ammari.id"
VPS_IP="43.173.52.121"
S3_ENDPOINT="https://d99c5045ed359887e8fdd591cc492ee9.r2.cloudflarestorage.com"
S3_BUCKET="ammari-prod-backups"
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
WARN_COUNT=0
FAILED_CHECKS=()
WARNED_CHECKS=()

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

# WARN is for a result that is inconclusive, never a stand-in for a passing check: a network/
# connection failure means we could not confirm anything is private, not that it is private.
warn() {
  echo "WARN: $1"
  WARN_COUNT=$((WARN_COUNT + 1))
  WARNED_CHECKS+=("$1")
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
#
# nc-based "is it closed" checks are only trustworthy if THIS network path actually reaches the
# VPS honestly. Some networks (captive portals, transparent proxies, some corporate/consumer
# routers) intercept or accept outbound TCP connections regardless of the real destination port —
# `nc -z` then reports a port "open" even though the VPS itself never has anything listening
# there (confirmed on a real run: `ss -tlnp` on the VPS showed only :22/:80/:443 public and `docker
# ps` showed no published app/db ports, while this exact nc check reported 8080/8081/5432 as all
# reachable). A random, definitely-unused high port as a control probe tells us which situation
# we're in: if even THAT "connects", every nc-based port check below is unreliable from this
# machine and must be skipped, not reported as a false FAIL — the SSH-side authoritative check
# below (ground truth from inside the VPS) is what actually verifies this.
CONTROL_PORT=$((40000 + RANDOM % 20000))
NETWORK_INTERCEPTS_TCP=0
if nc -z -w 5 "$VPS_IP" "$CONTROL_PORT" 2>/dev/null; then
  NETWORK_INTERCEPTS_TCP=1
  info "control probe: TCP connect to ${VPS_IP}:${CONTROL_PORT} (an unassigned high port, nothing listens there) SUCCEEDED — this network intercepts/accepts outbound TCP regardless of destination port, so nc-based port-closed checks below cannot be trusted from this machine. Skipping them; see the SSH-side authoritative listening/published-port check instead."
fi

check_port_closed() {
  local port="$1"
  if [ "$NETWORK_INTERCEPTS_TCP" = "1" ]; then
    skip "TCP port ${port} on ${VPS_IP} reachability from outside — nc is unreliable on this network (control probe on port ${CONTROL_PORT} also 'connected'); see the SSH-side authoritative port check below"
    return
  fi
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

# --- 9. The prod backups bucket must stay private under R2's whole-bucket-public model (no
#     bucket policies on R2, see docs/plans/storage-r2.md's "Decisions already made"). An
#     anonymous (no credentials passed) request must come back non-2xx AND with no object-listing
#     XML (<Contents>/<Key>) anywhere in the body: R2 may deny an anonymous request with
#     400/401/403 rather than Cloudeka's old 403, so the exact status code doesn't matter, only
#     "not 2xx" and "no listing leaked". A connection failure ("000") can't tell "correctly
#     denied" apart from "nothing answered", so it's reported as WARN, never PASS. ---
check_anon_no_listing() {
  local desc="$1" url="$2" code
  code="$(fetch "$url")"
  if [ "$code" = "000" ]; then
    warn "$desc: could not connect (network error); cannot confirm this is private"
    return
  fi
  if grep -qE '<(Contents|Key)>' "$BODY_FILE"; then
    fail "$desc: response body contains an object listing (<Contents>/<Key>) at HTTP $code"
    return
  fi
  case "$code" in
    2??)
      fail "$desc: returned HTTP $code (2xx); expected a non-2xx denial"
      ;;
    *)
      pass "$desc: HTTP $code, no object listing in the body"
      ;;
  esac
}

check_backups_private() {
  local probe_key="backups/_go-live-check-probe-$$.txt"
  check_anon_no_listing \
    "anonymous GET of s3://${S3_BUCKET}/${probe_key} (nonexistent key)" \
    "${S3_ENDPOINT}/${S3_BUCKET}/${probe_key}"
  check_anon_no_listing \
    "anonymous listing of s3://${S3_BUCKET}/backups/daily/ (known real prefix)" \
    "${S3_ENDPOINT}/${S3_BUCKET}/?list-type=2&prefix=backups/daily/"
}
check_backups_private

# --- 10. The prod media bucket's Cloudflare custom domain (img.ammari.id) must not list objects
#     at its root: a public custom domain only ever serves single objects by key, it should never
#     answer a bucket-listing request, and a HEAD on a key that doesn't exist must 404, without
#     this check depending on any specific real object existing in the bucket. ---
check_media_not_listable() {
  check_anon_no_listing \
    "anonymous GET of https://${MEDIA_HOST}/ (custom domain root)" \
    "https://${MEDIA_HOST}/"

  local missing_key="_go-live-check-missing-$$.webp" code
  code="$(fetch "https://${MEDIA_HOST}/${missing_key}" -I)"
  if [ "$code" = "000" ]; then
    warn "HEAD https://${MEDIA_HOST}/${missing_key}: could not connect (network error)"
  elif [ "$code" = "404" ]; then
    pass "HEAD https://${MEDIA_HOST}/${missing_key} returns 404 for a nonexistent key"
  else
    fail "HEAD https://${MEDIA_HOST}/${missing_key} returned $code (expected 404)"
  fi
}
check_media_not_listable

# --- 11. PDP's primary CTA is WhatsApp (STOREFRONT_CART_ENABLED=false), if any product page
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
  # Remote script lives in go-live-check-remote.sh (see SCRIPT_DIR above for why it's a separate
  # file, not an inline heredoc) and is piped over stdin exactly the same way a heredoc would be
  # — never written to disk on the VPS, every $var inside it expands ON THE REMOTE SIDE, never on
  # this Mac (that file has no $(...)/`...` of its own at the top level that this shell would try
  # to run first — `bash -s <file` just streams the file's bytes to the remote bash's stdin).
  local ssh_rc=0
  output="$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=yes -o ConnectTimeout=10 \
    "${SSH_USER}@${SSH_HOST}" bash -s < "$REMOTE_SCRIPT_FILE"
  )"
  ssh_rc=$?

  # Every section below is evaluated independently from whatever text IS in $output, rather than
  # bailing out entirely the moment something looks incomplete — a truncated or partially-failed
  # remote run should surface as THAT check's own FAIL with a specific reason, not hide every
  # other (possibly still-valid) piece of data behind one blanket message. `remote_done=1` only
  # controls the wording of the completeness note below; it never gates whether a check runs.
  local remote_done=0
  grep -q '^REMOTE_DONE:0$' <<<"$output" && remote_done=1

  if [ "$ssh_rc" -ne 0 ]; then
    fail "SSH to ${SSH_USER}@${SSH_HOST} exited non-zero (rc=$ssh_rc) — checks below are evaluated against whatever partial output was captured, if any"
  elif [ "$remote_done" -ne 1 ]; then
    info "remote check script did not report completion (no REMOTE_DONE:0) — output may be truncated; checks below reflect only what was actually received"
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

  if [ -z "$admin_slot" ]; then
    fail "could not determine the active admin slot — no SLOT:admin: line from the VPS"
  else
    line="$(grep "^CONTAINER:admin-${admin_slot}:" <<<"$output")"
    if [[ "$line" == *"running=true"* ]]; then
      pass "active admin slot (admin-${admin_slot}) is running"
    else
      fail "active admin slot (admin-${admin_slot}) check failed ($line)"
    fi
  fi

  if [ -z "$web_slot" ]; then
    fail "could not determine the active web slot — no SLOT:web: line from the VPS"
  else
    line="$(grep "^CONTAINER:web-${web_slot}:" <<<"$output")"
    if [[ "$line" == *"running=true"* ]]; then
      pass "active web slot (web-${web_slot}) is running"
    else
      fail "active web slot (web-${web_slot}) check failed ($line)"
    fi
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
    if ! grep -q "^ENVCHECKED:$f$" <<<"$output"; then
      # Absence of ENVBAD lines alone is NOT evidence of a clean file — it's indistinguishable
      # from this section never having run at all. Only trust it once ENVCHECKED:$f confirms the
      # remote script actually reached and finished checking this file.
      fail "no data from the VPS for env/$f (remote output missing — truncated run?)"
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

  # --- authoritative listening/published-port audit (see the external control-probe check:
  #     nc from this machine can report a port "open" even when nothing is listening, so this —
  #     run from inside the VPS itself — is the check that actually gates PASS/FAIL for port
  #     exposure). ---
  local portaudit_done=0
  grep -q '^PORTAUDIT_DONE:0$' <<<"$output" && portaudit_done=1

  local listen_violations=()
  while IFS= read -r addrport; do
    [ -z "$addrport" ] && continue
    local addr port
    addr="${addrport%:*}"
    port="${addrport##*:}"
    case "$addr" in
      127.*|::1|\[::1\]) continue ;; # loopback-only — not a public exposure
    esac
    case "$port" in
      22|80|443) continue ;;
    esac
    listen_violations+=("${addr}:${port}")
  done < <(grep '^LISTEN:' <<<"$output" | cut -d: -f2-)

  if [ "$portaudit_done" -ne 1 ]; then
    fail "could not get an authoritative listening-port audit from the VPS (no PORTAUDIT_DONE marker — remote output missing or truncated)"
  elif [ "${#listen_violations[@]}" -eq 0 ]; then
    pass "VPS has nothing listening on a non-loopback address except 22/80/443 (ss/proc authoritative check)"
  else
    fail "VPS has unexpected listener(s) on a non-loopback address: $(IFS=', '; echo "${listen_violations[*]}") — expected only 22/80/443"
  fi

  local pub_violations=()
  while IFS= read -r rest; do
    [ -z "$rest" ] && continue
    # Pipe-delimited (name|compose-service-label|ports) — see go-live-check-remote.sh's own
    # comment for why: {{.Ports}} contains spaces, and the container NAME on the real VPS is
    # "ammari-prod-caddy-1" (compose's project-name prefix), never literally "caddy". The compose
    # service label is what's actually checked below, not the name.
    local cname service cports
    cname="${rest%%|*}"
    rest="${rest#*|}"
    service="${rest%%|*}"
    cports="${rest#*|}"
    local mappings=() m hostpart hostport
    IFS=',' read -ra mappings <<<"$cports"
    # Same host port is listed once per address family (IPv4 "0.0.0.0:80->80/tcp" AND IPv6
    # "[::]:80->80/tcp" for one real published port) — de-dupe per container so one actually-
    # published port doesn't produce two identical violation lines. bash 3.2 has no associative
    # arrays (added in bash 4), so "seen" is tracked as a space-padded string checked with a glob,
    # not declare -A.
    local seen_ports=""
    for m in "${mappings[@]}"; do
      m="$(tr -d '[:space:]' <<<"$m")"
      [[ "$m" == *"->"* ]] || continue
      hostpart="${m%%->*}"
      hostport="${hostpart##*:}"
      case " $seen_ports " in
        *" $hostport "*) continue ;;
      esac
      seen_ports="$seen_ports $hostport"
      if [ "$hostport" != "80" ] && [ "$hostport" != "443" ]; then
        pub_violations+=("$cname publishes $hostport")
      elif [ "$service" != "caddy" ]; then
        pub_violations+=("$cname (not caddy) publishes $hostport")
      fi
    done
  done < <(grep '^PUBPORT ' <<<"$output" | sed 's/^PUBPORT //')

  if [ "$portaudit_done" -ne 1 ]; then
    fail "could not get an authoritative published-port audit from the VPS (no PORTAUDIT_DONE marker — remote output missing or truncated)"
  elif [ "${#pub_violations[@]}" -eq 0 ]; then
    pass "only caddy publishes a host port (80/443); no other container publishes anything (docker ps authoritative check)"
  else
    fail "unexpected published port(s): $(IFS='; '; echo "${pub_violations[*]}")"
  fi

  # --- disk / memory — informational only, no pass/fail threshold here (disk-alert.timer above
  #     is what actually pages on >=80% disk usage) ---
  info "disk usage (/): $(grep '^DISK:' <<<"$output" | cut -d: -f2-)"
  info "memory usage: $(grep '^MEM:' <<<"$output" | cut -d: -f2-)"
}
run_ssh_checks

echo
echo "===== SUMMARY ====="
echo "PASS: $PASS_COUNT   FAIL: $FAIL_COUNT   WARN: $WARN_COUNT   SKIP: $SKIP_COUNT"
if [ "$WARN_COUNT" -gt 0 ]; then
  echo
  echo "Warned checks (inconclusive, re-run once network access is confirmed):"
  printf '  - %s\n' "${WARNED_CHECKS[@]}"
fi
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo
  echo "Failed checks:"
  printf '  - %s\n' "${FAILED_CHECKS[@]}"
  exit 1
fi
exit 0
