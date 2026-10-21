#!/usr/bin/env bash
# Sets one KEY=value line in an env file without the value ever appearing on a terminal, in a
# command line (`ps`), or in shell history (docs/launch/checkout-dev.md, checkout-prod.md).
# Works on macOS (stock bash 3.2) and on the Linux servers. Synced to the dev server as
# /opt/ammari/set-env-var.sh by every dev deploy (deploy/ is rsynced there); for prod it runs on the
# owner's Mac against ~/ammari-secrets/prod-*.env, which deploy-prod/upload-prod-env.sh then uploads.
#
# Usage:
#   set-env-var.sh FILE KEY < value-file        value from stdin: exactly one line
#   set-env-var.sh FILE KEY                     on a terminal: asks with a hidden prompt (read -s)
#   set-env-var.sh --check FILE KEY [KEY...]    prints set (N characters) / empty / missing per key
#   set-env-var.sh --same FILE_A FILE_B KEY     prints MATCH or MISMATCH (values never shown)
#
# The value: one line, leading/trailing spaces, tabs and a CR are dropped, never empty. The file:
# created (mode 600) when missing, otherwise rewritten through a temp file in the same directory
# and renamed over it (mode 600). The first KEY= line is replaced in place, later duplicates are
# dropped (docker compose would otherwise pick one of them), and the key is appended when absent.
# A line counts as KEY's when it is `KEY=`, optionally indented or prefixed with `export ` (how
# compose's env_file parser reads it too). Comment lines (`# KEY=...`) are never touched. Values
# with `$`, `#`, quotes, backslashes or backticks are refused: compose interpolates `$VAR`, cuts
# an unquoted ` #` as a comment and strips quotes, so such a value would silently change. A symlink
# is refused (the rename would replace the link, not its target). NODE_ENV and E2E_TEST_LOGIN are refused: they
# must never be in a deployed env file (E2E_TEST_LOGIN unlocks the fake payment and shipping
# providers and the /api/test routes), and PAYMENT_PROVIDER / SHIPPING_RATE_PROVIDER must stay
# unset; DEPLOY_ENV only takes production, dev, development or test.
#
# Never add `set -x` here: it would print the value.
set -euo pipefail
umask 077

die() {
  echo "set-env-var: $*" >&2
  exit 1
}

valid_key() {
  [[ "$1" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "invalid key name: $1 (A-Z, 0-9 and _ only)"
  case "$1" in
    NODE_ENV | E2E_TEST_LOGIN) die "$1 must never be written to a deployed env file" ;;
    # Their defaults (midtrans, biteship) are the only values a server may use.
    PAYMENT_PROVIDER | SHIPPING_RATE_PROVIDER) die "$1 must stay unset on a server (the default is the real provider)" ;;
  esac
}

# True when the line assigns KEY (indent and `export ` allowed).
is_key_line() {
  [[ "$1" =~ ^[[:blank:]]*(export[[:blank:]]+)?${2}= ]]
}

# Prints the value of the LAST matching line on stdout (what docker compose and dotenv readers
# use), or returns 1 when the key is absent. Only ever captured by the caller, never echoed.
read_value() {
  local file="$1" key="$2" line found=1 value=""
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    if is_key_line "$line" "$key"; then
      value="${line#*=}"
      found=0
    fi
  done <"$file"
  [ "$found" -eq 0 ] || return 1
  printf '%s' "$value"
}

trim() {
  local text="$1"
  text="${text%$'\r'}"
  # Leading then trailing spaces and tabs.
  text="${text#"${text%%[![:blank:]]*}"}"
  text="${text%"${text##*[![:blank:]]}"}"
  printf '%s' "$text"
}

if [ "${1:-}" = "--check" ]; then
  [ "$#" -ge 3 ] || die "usage: $0 --check FILE KEY [KEY...]"
  file="$2"
  shift 2
  [ -f "$file" ] || die "no such file: $file"
  for key in "$@"; do
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "invalid key name: $key"
    if value="$(read_value "$file" "$key")"; then
      value="$(trim "$value")"
      if [ -n "$value" ]; then
        echo "$key: set (${#value} characters)"
      else
        echo "$key: empty"
      fi
    else
      echo "$key: missing"
    fi
  done
  unset value
  exit 0
fi

if [ "${1:-}" = "--same" ]; then
  [ "$#" -eq 4 ] || die "usage: $0 --same FILE_A FILE_B KEY"
  [[ "$4" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "invalid key name: $4"
  a="$(read_value "$2" "$4" || true)"
  b="$(read_value "$3" "$4" || true)"
  a="$(trim "$a")"
  b="$(trim "$b")"
  if [ -z "$a" ] || [ -z "$b" ]; then
    echo "$4: MISMATCH (empty or missing in at least one file)"
    unset a b
    exit 1
  fi
  if [ "$a" = "$b" ]; then
    echo "$4: MATCH"
    unset a b
    exit 0
  fi
  echo "$4: MISMATCH"
  unset a b
  exit 1
fi

[ "$#" -eq 2 ] || die "usage: $0 FILE KEY  (value on stdin, or a hidden prompt on a terminal)"
file="$1"
key="$2"
valid_key "$key"
dir="$(dirname "$file")"
[ -d "$dir" ] || die "no such directory: $dir"
[ ! -L "$file" ] || die "refusing a symlink: $file (point at the real file)"
[ ! -e "$file" ] || [ -f "$file" ] || die "not a regular file: $file"

value=""
if [ -t 0 ]; then
  printf 'Value for %s (input hidden): ' "$key" >&2
  IFS= read -r -s value || true
  printf '\n' >&2
else
  IFS= read -r value || [ -n "$value" ] || die "no value on stdin"
  extra=""
  if IFS= read -r extra || [ -n "$extra" ]; then
    die "more than one line on stdin; the value must be a single line"
  fi
fi
value="$(trim "$value")"
[ -n "$value" ] || die "empty value refused for $key"
if [ "$key" = "DEPLOY_ENV" ]; then
  case "$value" in
    production | dev | development | test) ;;
    *) die "DEPLOY_ENV must be production, dev, development or test (nothing written)" ;;
  esac
fi
case "$value" in
  *'$'* | *'#'* | *'"'* | *"'"* | *"\\"* | *'`'*)
    unset value
    die "refused for $key: the value contains \$, #, a quote, a backslash or a backtick, which docker compose would change (nothing written)"
    ;;
esac

action="added"
tmp="$(mktemp "${file}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
if [ -f "$file" ]; then
  written=0
  dropped=0
  while IFS= read -r line || [ -n "$line" ]; do
    if is_key_line "$line" "$key"; then
      if [ "$written" -eq 0 ]; then
        printf '%s=%s\n' "$key" "$value" >>"$tmp"
        written=1
        action="replaced"
      else
        # A later duplicate is dropped.
        dropped=$((dropped + 1))
      fi
    else
      printf '%s\n' "$line" >>"$tmp"
    fi
  done <"$file"
  if [ "$written" -eq 0 ]; then
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  [ "$dropped" -eq 0 ] || action="$action ($dropped duplicate line(s) removed)"
else
  printf '%s=%s\n' "$key" "$value" >"$tmp"
  action="added (new file)"
fi
length="${#value}"
unset value line
chmod 600 "$tmp"
mv "$tmp" "$file"
trap - EXIT
echo "set-env-var: $key $action in $file ($length characters)"
