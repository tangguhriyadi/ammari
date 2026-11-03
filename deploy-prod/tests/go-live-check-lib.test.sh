#!/usr/bin/env bash
# Tests for deploy-prod/go-live-check-lib.sh. No network, no server. Run from the repo root with
# the stock macOS bash (3.2, where an empty array under `set -u` is the bug) and a modern one:
#   /bin/bash deploy-prod/tests/go-live-check-lib.test.sh
#   bash deploy-prod/tests/go-live-check-lib.test.sh
set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/go-live-check-lib.sh"
FAILS=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }
# expect NAME EXPECTED_OUTPUT INPUT — runs the function in a fresh `set -u` bash.
expect() {
  local got
  got="$(printf '%s' "$3" | bash -c 'set -u; . "$1"; pubport_violations' _ "$LIB" 2>&1)"
  if [ "$got" = "$2" ]; then ok "$1"; else bad "$1 (got: $got)"; fi
}

expect "empty ports field (cron, publishes nothing)" "" $'ammari-prod-cron-1|cron|\n'
expect "only internal ports" "" $'ammari-prod-web-1|web|3000/tcp\nammari-prod-db-1|db|5432/tcp\n'
expect "caddy publishing 80/443 on both families is fine" "" \
  $'ammari-prod-caddy-1|caddy|0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp\n'
expect "mixed: cron empty then caddy" "" $'ammari-prod-cron-1|cron|\nammari-prod-caddy-1|caddy|0.0.0.0:443->443/tcp\n'
expect "non-caddy publishing 443 is a violation" "ammari-prod-web-1 (not caddy) publishes 443" \
  $'ammari-prod-web-1|web|0.0.0.0:443->3000/tcp\n'
expect "published db port is a violation, deduped across IPv4/IPv6" "ammari-prod-db-1 publishes 5432" \
  $'ammari-prod-db-1|db|0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp\n'
expect "no input at all" "" ""

# expect_headers NAME POLICY EXPECTED_OUTPUT HEADERS — security_header_problems in a fresh `set -u` bash.
expect_headers() {
  local got
  got="$(printf '%s' "$4" | bash -c 'set -u; . "$1"; security_header_problems "$2"' _ "$LIB" "$2" 2>&1)"
  if [ "$got" = "$3" ]; then ok "$1"; else bad "$1 (got: $got)"; fi
}
BASE_HEADERS=$'HTTP/2 200\r\nstrict-transport-security: max-age=31536000\r\nx-content-type-options: nosniff\r\nreferrer-policy: strict-origin-when-cross-origin\r\nx-frame-options: DENY\r\n'
NOINDEX=$'x-robots-tag: noindex, nofollow\r\n'
expect_headers "storefront: all headers, no noindex" index "" "$BASE_HEADERS"
expect_headers "storefront: a noindex on / fails" index "X-Robots-Tag: noindex is present on / — should only be on /preview/home and /login/link" "$BASE_HEADERS$NOINDEX"
expect_headers "admin: noindex expected and present" noindex "" "$BASE_HEADERS$NOINDEX"
expect_headers "admin: noindex on the /login redirect hop counts (curl -L dumps every hop)" noindex "" \
  $'HTTP/2 307\r\nlocation: /login\r\nX-Robots-Tag: noindex, nofollow\r\n\r\n'"$BASE_HEADERS"
expect_headers "admin: missing noindex fails" noindex "X-Robots-Tag: noindex is missing (the admin must never be indexed)" "$BASE_HEADERS"
expect_headers "missing security headers are each listed" noindex $'Strict-Transport-Security\nX-Content-Type-Options\nReferrer-Policy\nframe protection (X-Frame-Options or CSP frame-ancestors)' \
  $'HTTP/2 200\r\n'"$NOINDEX"
expect_headers "CSP frame-ancestors counts as frame protection" index "" \
  $'HTTP/2 200\r\nstrict-transport-security: max-age=1\r\nx-content-type-options: nosniff\r\nreferrer-policy: no-referrer\r\ncontent-security-policy: frame-ancestors \'none\'\r\n'
expect_headers "unknown policy is refused" both "unknown indexing policy: both (index or noindex)" "$BASE_HEADERS"

# expect_sig NAME EXPECTED_OUTPUT REMOTE_OUTPUT — midtrans_signature_key_problems in a fresh `set -u` bash.
expect_sig() {
  local got
  got="$(printf '%s' "$3" | bash -c 'set -u; . "$1"; midtrans_signature_key_problems' _ "$LIB" 2>&1)"
  if [ "$got" = "$2" ]; then ok "$1"; else bad "$1 (got: $got)"; fi
}
PROD=$'CFGKV:web.env:MIDTRANS_IS_PRODUCTION=true\n'
SIG_MISSING_MSG="web.env MIDTRANS_SIGNATURE_KEY is missing (MIDTRANS_IS_PRODUCTION=true needs it; set it from ~/ammari-secrets/prod-midtrans-signature-key, checkout-prod.md 2.4)"
expect_sig "signature key: set in the file and the same in the running slot" "" \
  "${PROD}"$'CFG:web.env:MIDTRANS_SIGNATURE_KEY:set\nRUNENV:web:MIDTRANS_SIGNATURE_KEY:match\n'
expect_sig "signature key: missing everywhere fails twice" "$SIG_MISSING_MSG"$'\nrunning web slot MIDTRANS_SIGNATURE_KEY: unset-in-both' \
  "${PROD}"$'CFG:web.env:MIDTRANS_SIGNATURE_KEY:missing\nRUNENV:web:MIDTRANS_SIGNATURE_KEY:unset-in-both\n'
expect_sig "signature key: empty in the file fails" "web.env MIDTRANS_SIGNATURE_KEY is empty (MIDTRANS_IS_PRODUCTION=true needs it; set it from ~/ammari-secrets/prod-midtrans-signature-key, checkout-prod.md 2.4)"$'\nrunning web slot MIDTRANS_SIGNATURE_KEY: unset-in-both' \
  "${PROD}"$'CFG:web.env:MIDTRANS_SIGNATURE_KEY:empty\nRUNENV:web:MIDTRANS_SIGNATURE_KEY:unset-in-both\n'
expect_sig "signature key: set in the file but the slot was not recreated" "running web slot has no MIDTRANS_SIGNATURE_KEY although env/web.env sets it — run ./recreate-active-slot.sh web on the VPS" \
  "${PROD}"$'CFG:web.env:MIDTRANS_SIGNATURE_KEY:set\nRUNENV:web:MIDTRANS_SIGNATURE_KEY:unset-in-container\n'
expect_sig "signature key: running slot differs" "running web slot's MIDTRANS_SIGNATURE_KEY differs from env/web.env — run ./recreate-active-slot.sh web on the VPS" \
  "${PROD}"$'CFG:web.env:MIDTRANS_SIGNATURE_KEY:set\nRUNENV:web:MIDTRANS_SIGNATURE_KEY:differs\n'
expect_sig "signature key: no data from the VPS fails" "web.env MIDTRANS_SIGNATURE_KEY is no data (MIDTRANS_IS_PRODUCTION=true needs it; set it from ~/ammari-secrets/prod-midtrans-signature-key, checkout-prod.md 2.4)"$'\nrunning web slot MIDTRANS_SIGNATURE_KEY: no data' "$PROD"
expect_sig "signature key: no MIDTRANS_IS_PRODUCTION data at all fails" "no MIDTRANS_IS_PRODUCTION data for web.env from the VPS; MIDTRANS_SIGNATURE_KEY not verified" \
  $'CFG:web.env:MIDTRANS_SIGNATURE_KEY:missing\n'
expect_sig "signature key: not required when MIDTRANS_IS_PRODUCTION is not true" "" \
  $'CFGKV:web.env:MIDTRANS_IS_PRODUCTION=false\nCFG:web.env:MIDTRANS_SIGNATURE_KEY:missing\nRUNENV:web:MIDTRANS_SIGNATURE_KEY:unset-in-both\n'

if bash -c 'set -u; . "$1"; command -v nc_probe >/dev/null' _ "$LIB"; then ok "nc_probe defined"; else bad "nc_probe defined"; fi

echo "bash ${BASH_VERSION}: ${FAILS} failure(s)"
[ "$FAILS" -eq 0 ]
