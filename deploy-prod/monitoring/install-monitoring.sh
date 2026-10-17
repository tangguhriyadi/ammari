#!/usr/bin/env bash
# Run ON THE PROD VPS, once, with sudo (as user `ubuntu`, which has sudo — NOT as `deploy`, which
# doesn't; see docs/plans/prod-deploy.md §4 step 3). Installs/refreshes the systemd units for all
# three Session 6 checks (disk-alert, backup-check, health-check) and creates the dedup-state
# directory the checks write to. Mirrors deploy-prod/backup/install-backup-timer.sh's shape.
#
# Prerequisite (one-time, and again any time a script/unit file under this directory changes —
# deploy-prod/monitoring/ is deliberately excluded from deploy-prod.yml's own rsync, so it is
# never auto-updated by a routine app deploy): from the owner's Mac, copy this whole directory to
# the VPS, e.g.
#   scp -i ~/ammari-secrets/ammari_prod_deploy_key -r deploy-prod/monitoring \
#     deploy@43.173.52.121:/opt/ammari-prod/
# then, on the VPS (as ubuntu):
#   cd /opt/ammari-prod/monitoring
#   sudo ./install-monitoring.sh
#
# After this installs successfully, run ./send-test-alert.sh ONCE (as deploy, no sudo needed) to
# confirm email delivery actually works before trusting these checks for a real incident.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Must run with sudo (writes /etc/systemd/system, chowns the state dir, reloads systemd)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DEST="/etc/systemd/system"

CHECKS=(disk-alert backup-check health-check)

for name in "${CHECKS[@]}"; do
  for ext in sh service timer; do
    if [ ! -f "$SCRIPT_DIR/$name.$ext" ]; then
      echo "Missing $SCRIPT_DIR/$name.$ext — copy the whole deploy-prod/monitoring/ directory here first (see this script's header comment)." >&2
      exit 1
    fi
  done
done
if [ ! -f "$SCRIPT_DIR/lib/alert-lib.sh" ]; then
  echo "Missing $SCRIPT_DIR/lib/alert-lib.sh — copy the whole deploy-prod/monitoring/ directory here first." >&2
  exit 1
fi

echo "==> Making check scripts executable"
chmod +x "$SCRIPT_DIR"/disk-alert.sh "$SCRIPT_DIR"/backup-check.sh "$SCRIPT_DIR"/health-check.sh
chmod +x "$SCRIPT_DIR"/send-test-alert.sh

echo "==> Creating dedup-state directory, owned by deploy (the user every check/timer runs as)"
mkdir -p "$SCRIPT_DIR/state"
chown -R deploy:deploy "$SCRIPT_DIR/state"

echo "==> Installing systemd units"
for name in "${CHECKS[@]}"; do
  cp "$SCRIPT_DIR/$name.service" "$UNIT_DEST/$name.service"
  cp "$SCRIPT_DIR/$name.timer" "$UNIT_DEST/$name.timer"
done

echo "==> Reloading systemd"
systemctl daemon-reload

echo "==> Enabling + starting all three timers"
systemctl enable --now disk-alert.timer backup-check.timer health-check.timer

echo
echo "==> Next scheduled runs:"
systemctl list-timers disk-alert.timer backup-check.timer health-check.timer --no-pager

echo
echo "==> Next: as the 'deploy' user (no sudo needed), run ./send-test-alert.sh once to confirm"
echo "    email delivery actually works before trusting these checks for a real incident."
