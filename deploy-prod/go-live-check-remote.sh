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
