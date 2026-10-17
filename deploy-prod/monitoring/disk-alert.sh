#!/usr/bin/env bash
# Runs ON the prod VPS (docs/deploy-prod.md), as user `deploy`, hourly via disk-alert.timer
# (docs/plans/prod-deploy.md §3 Session 6, §6). Lives at
# /opt/ammari-prod/monitoring/disk-alert.sh — this directory is deliberately excluded from
# deploy-prod.yml's routine rsync (same reason backup/ is excluded), so a normal app deploy never
# silently overwrites these scripts or their dedup state. See install-monitoring.sh for the
# one-time systemd setup.
#
# Checks the VPS's own root filesystem usage (this is a VPS-local fact — not something any
# container-internal check could see reliably) against a fixed threshold, alerting via Resend
# (deploy-prod/monitoring/lib/alert-lib.sh) when at or above it. Includes a `docker system df`
# summary in the alert body so whoever reads the email immediately sees the usual actual cause
# (image/layer buildup, Postgres data growth) without having to SSH in first just to find that
# out.
#
# Usage: disk-alert.sh   (no arguments; always targets this directory's own ../env/{admin,backup}.env)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./lib/alert-lib.sh
source "$SCRIPT_DIR/lib/alert-lib.sh"
STATE_DIR="$SCRIPT_DIR/state"

cd "$ROOT_DIR"

# RESEND_API_KEY/EMAIL_FROM live in admin.env (the app's own key, reused — no new credential);
# ALERT_EMAIL_TO lives in backup.env. Missing either is only a WARNING from send_alert itself
# (alert-lib.sh), never a reason to skip the actual disk check below.
load_env_file "env/admin.env" || echo "==> WARNING: could not read env/admin.env" >&2
load_env_file "env/backup.env" || echo "==> WARNING: could not read env/backup.env" >&2

# The one number this script alerts on. 80% is this plan's own confirmed threshold
# (docs/plans/prod-deploy.md §6) — the most likely slow-growth failure on a 60 GB SSD shared by
# Docker image/layer growth and Postgres data growth over months. Overridable via env var only so
# a local test harness can force the alert path without needing to actually fill the disk — never
# set in production (no env file defines this key), so this always defaults to 80.
THRESHOLD_PCT="${DISK_ALERT_THRESHOLD_PCT:-80}"

echo "==> Checking / disk usage"
USAGE_PCT="$(df -P / | awk 'NR==2 { gsub("%","",$5); print $5 }')"
if ! [[ "$USAGE_PCT" =~ ^[0-9]+$ ]]; then
  echo "==> Could not parse disk usage from df output" >&2
  exit 1
fi
echo "==> / is ${USAGE_PCT}% used (threshold ${THRESHOLD_PCT}%)"

DOCKER_DF="$(docker system df 2>&1 || echo "(docker system df failed)")"

OK=1
if [ "$USAGE_PCT" -ge "$THRESHOLD_PCT" ]; then
  OK=0
fi

BODY="Disk usage on / is ${USAGE_PCT}% (alert threshold: ${THRESHOLD_PCT}%).

Top Docker space users (docker system df):
${DOCKER_DF}

Check: ssh onto the VPS and run \`docker system df -v\` for a per-image/container breakdown, or
\`docker image prune -a\` / \`docker system prune\` to reclaim space from old images (never prune
volumes — that would touch the Postgres data volume). If usage is genuinely from data growth
rather than Docker cruft, this is the ~80%-used backstop docs/plans/prod-deploy.md §1 describes —
time to plan a disk upsize."

monitoring_alert_check "disk" "$OK" "[Ammari] VPS disk usage high (${USAGE_PCT}% used)" "$BODY"
