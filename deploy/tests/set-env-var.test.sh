#!/usr/bin/env bash
# check() evals its condition later on purpose, so single quotes and "unused" variables are fine.
# shellcheck disable=SC2016,SC2034
# Tests for deploy/set-env-var.sh. No network, no server: everything happens in a temp directory.
# Run from the repo root with the stock macOS bash and with a modern one:
#   /bin/bash deploy/tests/set-env-var.test.sh
#   bash deploy/tests/set-env-var.test.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/set-env-var.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
# Built at runtime, never a real key; contains characters a naive sed/eval would break on.
SECRET="SB-Mid-server-$(printf '%s' "$RANDOM$RANDOM" | tr '0-9' 'a-j')/+=&x y<z>"

ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

mode_of() { if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi; }

f="$WORK/web.env"
printf '# comment MIDTRANS_SERVER_KEY=old\nA=1\nMIDTRANS_SERVER_KEY=old\nB=2\nMIDTRANS_SERVER_KEY=dup\nC=3' >"$f"
chmod 644 "$f"
out="$(printf '%s\n' "$SECRET" | bash "$SCRIPT" "$f" MIDTRANS_SERVER_KEY 2>&1)"
check "replace exits 0" '[ $? -eq 0 ]'
check "output never contains the value" '[[ "$out" != *"$SECRET"* ]] && [[ "$out" != *"SB-Mid"* ]]'
check "reports replaced and the dropped duplicate" '[[ "$out" == *"MIDTRANS_SERVER_KEY replaced (1 duplicate line(s) removed)"* ]]'
expected="$(printf '# comment MIDTRANS_SERVER_KEY=old\nA=1\nMIDTRANS_SERVER_KEY=%s\nB=2\nC=3' "$SECRET")"
check "first line replaced literally, duplicate dropped, comment and missing final newline kept" '[ "$(cat "$f")" = "$expected" ]'
check "mode 600 after rewrite" '[ "$(mode_of "$f")" = "600" ]'

printf '  INTERNAL_CRON_SECRET-value-with-cr \r\n' | bash "$SCRIPT" "$f" INTERNAL_CRON_SECRET >/dev/null 2>&1
check "appended, CR and outer spaces trimmed" '[ "$(tail -n 1 "$f")" = "INTERNAL_CRON_SECRET=INTERNAL_CRON_SECRET-value-with-cr" ]'

printf 'x' | bash "$SCRIPT" "$f" NO_NEWLINE >/dev/null 2>&1
check "value without a trailing newline is accepted" 'grep -qx "NO_NEWLINE=x" "$f"'

new="$WORK/cron.env"
printf 'abc\n' | bash "$SCRIPT" "$new" INTERNAL_CRON_SECRET >/dev/null 2>&1
check "creates a missing file with mode 600" '[ "$(cat "$new")" = "INTERNAL_CRON_SECRET=abc" ] && [ "$(mode_of "$new")" = "600" ]'

before="$(cat "$f")"
printf '\n' | bash "$SCRIPT" "$f" EMPTY_ONE >/dev/null 2>&1
check "empty value refused" '[ $? -ne 0 ]'
printf 'a\nb\n' | bash "$SCRIPT" "$f" TWO_LINES >/dev/null 2>&1
check "two lines refused" '[ $? -ne 0 ]'
printf 'x\n' | bash "$SCRIPT" "$f" NODE_ENV >/dev/null 2>&1
check "NODE_ENV refused" '[ $? -ne 0 ]'
printf 'true\n' | bash "$SCRIPT" "$f" E2E_TEST_LOGIN >/dev/null 2>&1
check "E2E_TEST_LOGIN refused" '[ $? -ne 0 ]'
printf 'fake\n' | bash "$SCRIPT" "$f" PAYMENT_PROVIDER >/dev/null 2>&1
check "PAYMENT_PROVIDER refused" '[ $? -ne 0 ]'
printf 'fake\n' | bash "$SCRIPT" "$f" SHIPPING_RATE_PROVIDER >/dev/null 2>&1
check "SHIPPING_RATE_PROVIDER refused" '[ $? -ne 0 ]'
printf 'prod\n' | bash "$SCRIPT" "$f" DEPLOY_ENV >/dev/null 2>&1
check "DEPLOY_ENV typo refused" '[ $? -ne 0 ]'
printf 'x\n' | bash "$SCRIPT" "$f" 'bad-key' >/dev/null 2>&1
check "bad key name refused" '[ $? -ne 0 ]'
bash "$SCRIPT" "$f" NO_STDIN </dev/null >/dev/null 2>&1
check "no stdin refused" '[ $? -ne 0 ]'
for bad in 'a$b' 'a #b' 'a"b' "a'b" 'a\b' 'a`b'; do
  printf '%s\n' "$bad" | bash "$SCRIPT" "$f" BAD_CHARS >/dev/null 2>&1
  check "value with compose-special characters refused: $bad" '[ $? -ne 0 ]'
done
ln -s "$f" "$WORK/link.env"
printf 'x\n' | bash "$SCRIPT" "$WORK/link.env" VIA_LINK >/dev/null 2>&1
check "symlink refused" '[ $? -ne 0 ] && [ -L "$WORK/link.env" ]'
check "refusals leave the file unchanged" '[ "$(cat "$f")" = "$before" ]'
check "no temp files left behind" '[ "$(find "$WORK" -name "*.env.*" | wc -l | tr -d " ")" = "0" ]'

out="$(bash "$SCRIPT" --check "$f" MIDTRANS_SERVER_KEY INTERNAL_CRON_SECRET MISSING_ONE 2>&1)"
check "--check never prints a value" '[[ "$out" != *"SB-Mid"* ]] && [[ "$out" != *"value-with-cr"* ]]'
check "--check reports set and missing" '[[ "$out" == *"MIDTRANS_SERVER_KEY: set ("* ]] && [[ "$out" == *"MISSING_ONE: missing"* ]]'
printf 'EMPTY_KEY=\n' >>"$f"
check "--check reports empty" '[[ "$(bash "$SCRIPT" --check "$f" EMPTY_KEY)" == "EMPTY_KEY: empty" ]]'

h="$WORK/export.env"
printf '  export STOREFRONT_CART_ENABLED=true\nX=1\n' >"$h"
check "--check sees an indented export line" '[ "$(bash "$SCRIPT" --check "$h" STOREFRONT_CART_ENABLED)" = "STOREFRONT_CART_ENABLED: set (4 characters)" ]'
printf 'false\n' | bash "$SCRIPT" "$h" STOREFRONT_CART_ENABLED >/dev/null 2>&1
check "an export line is replaced, not duplicated" '[ "$(cat "$h")" = "$(printf "STOREFRONT_CART_ENABLED=false\nX=1")" ]'

g="$WORK/other.env"
printf 'INTERNAL_CRON_SECRET=INTERNAL_CRON_SECRET-value-with-cr\n' >"$g"
out="$(bash "$SCRIPT" --same "$f" "$g" INTERNAL_CRON_SECRET 2>&1)"
check "--same MATCH" '[ $? -eq 0 ] && [ "$out" = "INTERNAL_CRON_SECRET: MATCH" ]'
printf 'INTERNAL_CRON_SECRET=different\n' >"$g"
out="$(bash "$SCRIPT" --same "$f" "$g" INTERNAL_CRON_SECRET 2>&1)"
check "--same MISMATCH, no value shown" '[ "$out" = "INTERNAL_CRON_SECRET: MISMATCH" ] && [[ "$out" != *"different"* ]]'
bash "$SCRIPT" --same "$f" "$g" MISSING_ONE >/dev/null 2>&1
check "--same with a missing key fails" '[ $? -ne 0 ]'

echo
if [ "$FAILS" -eq 0 ]; then
  echo "all set-env-var tests passed (bash $BASH_VERSION)"
else
  echo "$FAILS set-env-var test(s) FAILED (bash $BASH_VERSION)"
  exit 1
fi
