#!/usr/bin/env bash
# Run ON THE PROD VPS, once, with sudo — NOT on the owner's Mac (unlike
# make-prod-env.sh/upload-prod-env.sh, which run locally). Installs/refreshes the systemd units
# that run pg-backup.sh nightly (docs/plans/prod-deploy.md §3 Session 5).
#
# Prerequisite (one-time, and again any time pg-backup.sh/the unit files change — this directory
# is deliberately excluded from deploy-prod.yml's own rsync, so it is never auto-updated):
# from the owner's Mac, copy this whole directory to the VPS, e.g.
#   scp -i ~/ammari-secrets/ammari_prod_deploy_key -r deploy-prod/backup \
#     deploy@43.173.52.121:/opt/ammari-prod/
# then, on the VPS:
#   cd /opt/ammari-prod/backup
#   sudo ./install-backup-timer.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Must run with sudo (writes /etc/systemd/system and reloads systemd)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DEST="/etc/systemd/system"

for unit in pg-backup.service pg-backup.timer pg-backup.sh; do
  if [ ! -f "$SCRIPT_DIR/$unit" ]; then
    echo "Missing $SCRIPT_DIR/$unit — copy the whole deploy-prod/backup/ directory here first (see this script's header comment)." >&2
    exit 1
  fi
done

echo "==> Making pg-backup.sh executable"
chmod +x "$SCRIPT_DIR/pg-backup.sh"

echo "==> Installing systemd units"
cp "$SCRIPT_DIR/pg-backup.service" "$UNIT_DEST/pg-backup.service"
cp "$SCRIPT_DIR/pg-backup.timer" "$UNIT_DEST/pg-backup.timer"

echo "==> Reloading systemd"
systemctl daemon-reload

echo "==> Enabling + starting the timer"
systemctl enable --now pg-backup.timer

echo
echo "==> Next scheduled run:"
systemctl list-timers pg-backup.timer --no-pager
