#!/usr/bin/env bash
# Never executed directly (no +x needed) — go-live-check.sh pipes this file's bytes to
# `ssh ... bash -s`, same as the inline heredoc it replaces; the shebang is here only for
# editor/shellcheck syntax detection.
#
# Remote half of deploy-prod/go-live-check.sh (Session 10) — kept in its OWN file, not an inline
# heredoc in the main script, because of a confirmed macOS-stock-bash (3.2) lexer bug: an
# unbalanced `(` or a literal apostrophe inside a `#` comment WITHIN a single-quoted heredoc body
# breaks bash 3.2's parser ("unexpected EOF while looking for matching ..."), even though the
# exact same text is completely fine as a normal script/comment outside a heredoc, and completely
# fine under bash 4+/5. Reproduced and confirmed against a real `bash:3.2` image. Splitting this
# out means the LOCAL script (go-live-check.sh, parsed by whatever bash the owner's Mac ships —
# almost always still 3.2) never has to lex this file's content at all; go-live-check.sh instead
# does `ssh ... bash -s < go-live-check-remote.sh`, which sends this file's bytes over the SSH
# channel exactly like the old heredoc did — still never written to disk on the VPS, same as
# before. This file itself runs on the remote side under whatever bash ships on the VPS (Ubuntu
# 24.04's default, bash 5.x) via that `bash -s`, so IT has no bash-3.2 constraint at all — normal
# comment style, apostrophes included, is fine here.
set -uo pipefail
# IMPORTANT: this whole script arrives on the SAME stdin pipe that every command below inherits
# by default. Any command that attaches to or reads from its own stdin (docker/docker compose
# exec without -i is still an exception: exec always hijacks/forwards the caller's stdin to the
# container process even with -T, which only disables the pseudo-TTY, not stdin forwarding; ssh,
# mysql/psql clients, etc. have the same hazard) will eagerly drain whatever of this script hasn't
# been read yet, silently and permanently losing it, no error, the remote bash just runs out of
# script. Confirmed on a real go-live run: output ended cleanly right after the second
# docker compose exec call below (admin's INTERNALHEALTH line) with every later section (env
# files, timers, backup age, disk/memory) never printed and no error anywhere. Every such call
# below MUST redirect its own stdin from /dev/null.
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
  if docker compose exec -T caddy curl -sf "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 </dev/null; then
    echo "INTERNALHEALTH:$app:ok"
  else
    echo "INTERNALHEALTH:$app:fail"
  fi
done

# Authoritative listening/published-port audit, ground truth from inside the VPS, since an
# external nc-based check can be fooled by a network that intercepts outbound TCP (see this
# script's own external control-probe check above). ss -tln needs no sudo: address/port come from
# /proc/net/tcp{,6}, which is world-readable, only -p (process-name resolution) needs privilege,
# and this doesn't use it. Falls back to parsing /proc/net/tcp{,6} directly if ss itself isn't
# installed.
if command -v ss >/dev/null 2>&1; then
  ss -Htln 2>/dev/null </dev/null | awk '{print $(NF-1)}' | while IFS= read -r addrport; do
    echo "LISTEN:$addrport"
  done
else
  for f in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$f" ] || continue
    fam="6"; [ "$f" = "/proc/net/tcp" ] && fam="4"
    awk -v fam="$fam" 'NR>1 && $4=="0A"{print fam, $2}' "$f"
  done | while read -r fam hexaddrport; do
    hexaddr="${hexaddrport%:*}"
    hexport="${hexaddrport##*:}"
    port=$((16#$hexport))
    if [ "$fam" = "6" ]; then
      if [ "$hexaddr" = "00000000000000000000000001000000" ]; then
        addr="::1"
      else
        addr="0.0.0.0" # any other IPv6 listener counts as non-loopback for this audit
      fi
    else
      addr="$(printf '%d.%d.%d.%d' $((16#${hexaddr:6:2})) $((16#${hexaddr:4:2})) $((16#${hexaddr:2:2})) $((16#${hexaddr:0:2})))"
    fi
    echo "LISTEN:${addr}:${port}"
  done
fi
# Pipe-delimited, not space-delimited — {{.Ports}} itself contains spaces (e.g. after each
# comma in "0.0.0.0:80->80/tcp, [::]:80->80/tcp"), so a space-split local parser can't reliably
# tell the name/ports fields apart. The compose service label (always set by `docker compose up`,
# regardless of the project-name prefix compose puts on the CONTAINER NAME, e.g.
# "ammari-prod-caddy-1") is what the local script uses to recognize caddy — matching on the name
# itself breaks the moment the project name isn't literally "ammari-prod" with no instance
# suffix, which is exactly what happens on the real VPS.
docker ps --format '{{.Names}}|{{.Label "com.docker.compose.service"}}|{{.Ports}}' 2>/dev/null </dev/null | while IFS= read -r line; do
  echo "PUBPORT $line"
done
echo "PORTAUDIT_DONE:0"

# The LAST line for a key wins (like docker compose), with an `export ` prefix, indentation, a CR,
# outer blanks and one pair of surrounding quotes dropped the same way compose reads them.
env_value() {
  # $1 file, $2 key. Prints the value (captured by the caller only) or returns 1 when absent.
  local line value
  [ -f "$1" ] || return 1
  line="$(grep -E "^[[:blank:]]*(export[[:blank:]]+)?$2=" "$1" 2>/dev/null | tail -n 1)" || return 1
  [ -n "$line" ] || return 1
  value="$(printf '%s' "${line#*=}" | tr -d '\r' | sed -e 's/^[[:blank:]]*//' -e 's/[[:blank:]]*$//')"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

if [ -f env/web.env ]; then
  for key in STOREFRONT_CART_ENABLED DEPLOY_ENV; do
    if v="$(env_value env/web.env "$key")"; then echo "ENVKV:web.env:$key=$v"; else echo "ENVKV:web.env:$key=<missing>"; fi
  done
else
  echo "ENVMISSING:web.env"
fi

for f in admin.env web.env db.env backup.env cron.env; do
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

# --- Checkout configuration (docs/launch/checkout-prod.md). Secret values stay in this remote
# shell's variables and are never printed: only set/empty/missing, a key KIND (test/live,
# sandbox/production) or a MATCH between two files. Non-secret flags are printed as KEY=value.
# env_value (above) reads them the way docker compose does.
cfg_state() {
  local v
  if v="$(env_value "env/$1" "$2")"; then
    if [ -n "$v" ]; then echo "CFG:$1:$2:set"; else echo "CFG:$1:$2:empty"; fi
  else
    echo "CFG:$1:$2:missing"
  fi
}
cfg_kv() {
  local v
  if v="$(env_value "env/$1" "$2")"; then echo "CFGKV:$1:$2=$v"; else echo "CFGKV:$1:$2=<missing>"; fi
}
for key in MIDTRANS_SERVER_KEY BITESHIP_API_KEY BITESHIP_ORIGIN_AREA_ID INTERNAL_CRON_SECRET RESEND_API_KEY EMAIL_FROM CUSTOMER_BETTER_AUTH_SECRET; do
  cfg_state web.env "$key"
done
cfg_state admin.env MIDTRANS_SERVER_KEY
cfg_state cron.env INTERNAL_CRON_SECRET
for key in MIDTRANS_IS_PRODUCTION MIDTRANS_ORDER_ID_PREFIX MIDTRANS_NOTIFICATION_URL PAYMENT_PROVIDER SHIPPING_RATE_PROVIDER BITESHIP_BASE_URL; do
  cfg_kv web.env "$key"
done
cfg_kv admin.env MIDTRANS_IS_PRODUCTION
cfg_kv admin.env DEPLOY_ENV
cfg_kv admin.env PAYMENT_PROVIDER

v="$(env_value env/web.env BITESHIP_API_KEY || true)"
case "$v" in
  biteship_live.*) echo "KEYKIND:biteship:live" ;;
  biteship_test.*) echo "KEYKIND:biteship:test" ;;
  "") echo "KEYKIND:biteship:missing" ;;
  *) echo "KEYKIND:biteship:other" ;;
esac
v="$(env_value env/web.env MIDTRANS_SERVER_KEY || true)"
# Midtrans' key shapes: production server keys start with Mid-server-; old sandbox keys with SB-,
# newer sandbox keys with Mid-server- too. So "production" here only means "not SB-": the key's
# environment is verified against the production API in checkout-prod.md 2.4 (404 vs 401).
case "$v" in
  SB-*) echo "KEYKIND:midtrans:sandbox" ;;
  Mid-server-*) echo "KEYKIND:midtrans:production" ;;
  "") echo "KEYKIND:midtrans:missing" ;;
  *) echo "KEYKIND:midtrans:other" ;;
esac
a="$(env_value env/web.env MIDTRANS_SERVER_KEY || true)"
b="$(env_value env/admin.env MIDTRANS_SERVER_KEY || true)"
if [ -z "$a" ] || [ -z "$b" ]; then echo "SAME:midtrans:missing"; elif [ "$a" = "$b" ]; then echo "SAME:midtrans:match"; else echo "SAME:midtrans:mismatch"; fi
a="$(env_value env/web.env INTERNAL_CRON_SECRET || true)"
b="$(env_value env/cron.env INTERNAL_CRON_SECRET || true)"
if [ -z "$a" ] || [ -z "$b" ]; then echo "SAME:cron:missing"; elif [ "$a" != "$b" ]; then echo "SAME:cron:mismatch"; elif [ "${#a}" -lt 32 ]; then echo "SAME:cron:short"; else echo "SAME:cron:match"; fi
unset v a b

# The floating `web` alias (cron and admin revalidation): a bare recreate of the web slot drops it
# (deploy-prod/recreate-active-slot.sh).
if docker compose exec -T caddy curl -sf "http://web:3000/api/health" >/dev/null 2>&1 </dev/null; then
  echo "WEBALIAS:ok"
else
  echo "WEBALIAS:fail"
fi

# The cron service's last 15 minutes (log lines carry no secret: cron.sh never prints it).
cron_log="$(docker compose logs --no-log-prefix --since 15m cron 2>/dev/null </dev/null || true)"
echo "CRONLOG:sweep200=$(grep -c '/api/internal/payments/sweep -> 200' <<<"$cron_log"):email200=$(grep -c '/api/internal/emails/dispatch -> 200' <<<"$cron_log"):errors=$(grep -c 'ERROR\|ALERT' <<<"$cron_log"):idle=$(grep -c 'idle (no sweep' <<<"$cron_log")"
unset cron_log

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
