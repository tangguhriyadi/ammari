# shellcheck shell=bash
# Pure helpers for go-live-check.sh, split out so deploy-prod/tests can run them without a server.
# Must stay safe under macOS bash 3.2 with `set -u`: expanding an EMPTY array as "${arr[@]}" is an
# "unbound variable" error there (fixed in bash 4.4), so every possibly-empty array is expanded as
# ${arr[@]+"${arr[@]}"}. No associative arrays either.

# TCP connect probe with a hard time limit. macOS nc ignores -w for the connect phase on some
# networks and can hang for minutes, so -G (connect timeout, BSD/macOS nc) is added when the nc
# supports it, and the whole probe is wrapped in timeout/gtimeout when one exists.
nc_probe() {
  local host="$1" port="$2" ncargs=(-z -w 5)
  if nc -h 2>&1 | grep -q -- '-G'; then
    ncargs=(-z -G 5 -w 5)
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout 8 nc "${ncargs[@]}" "$host" "$port"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout 8 nc "${ncargs[@]}" "$host" "$port"
  else
    nc "${ncargs[@]}" "$host" "$port"
  fi
}

# Reads lines "name|compose-service-label|docker-ps-ports" (the PUBPORT payload) on stdin and
# prints one violation per line: a published host port other than 80/443, or 80/443 published by
# anything but the caddy service. A container publishing nothing (empty or "3000/tcp" only ports
# field) produces no output.
pubport_violations() {
  local rest cname service cports m hostpart hostport seen_ports
  local mappings=()
  while IFS= read -r rest; do
    [ -z "$rest" ] && continue
    # Pipe-delimited because {{.Ports}} contains spaces and the container NAME is compose's
    # "ammari-prod-caddy-1"; the service label is what is checked, not the name.
    cname="${rest%%|*}"
    rest="${rest#*|}"
    service="${rest%%|*}"
    cports="${rest#*|}"
    # A container with no published ports (e.g. cron) has an empty ports field: read -a then
    # yields an EMPTY array, and the loop below must not expand it bare under set -u.
    mappings=()
    IFS=',' read -ra mappings <<<"$cports"
    # Same host port is listed once per address family (0.0.0.0:80->80/tcp and [::]:80->80/tcp);
    # de-dupe per container with a space-padded string (no associative arrays in bash 3.2).
    seen_ports=""
    for m in ${mappings[@]+"${mappings[@]}"}; do
      m="$(tr -d '[:space:]' <<<"$m")"
      [[ "$m" == *"->"* ]] || continue
      hostpart="${m%%->*}"
      hostport="${hostpart##*:}"
      case " $seen_ports " in
        *" $hostport "*) continue ;;
      esac
      seen_ports="$seen_ports $hostport"
      if [ "$hostport" != "80" ] && [ "$hostport" != "443" ]; then
        echo "$cname publishes $hostport"
      elif [ "$service" != "caddy" ]; then
        echo "$cname (not caddy) publishes $hostport"
      fi
    done
  done
}
