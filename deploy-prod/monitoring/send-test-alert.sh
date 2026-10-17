#!/usr/bin/env bash
# Run ON THE PROD VPS, by hand, once right after install-monitoring.sh — NOT on a timer. Sends
# exactly one real email through the same Resend mechanism every check script uses
# (deploy-prod/monitoring/lib/alert-lib.sh's send_alert), so the owner can confirm delivery
# actually works (API key valid, ALERT_EMAIL_TO addresses correct, Resend sending domain still
# verified) BEFORE trusting these checks to page them for a real incident.
#
# Does not touch any dedup state (deploy-prod/monitoring/state/) and does not run any of the
# actual disk/backup/health checks — it only proves the email leg of the pipeline.
#
# Usage: ./send-test-alert.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./lib/alert-lib.sh
source "$SCRIPT_DIR/lib/alert-lib.sh"

cd "$ROOT_DIR"

load_env_file "env/admin.env" || { echo "Could not read env/admin.env" >&2; exit 1; }
load_env_file "env/backup.env" || { echo "Could not read env/backup.env" >&2; exit 1; }

for v in ALERT_EMAIL_TO RESEND_API_KEY EMAIL_FROM; do
  if [ -z "${!v:-}" ]; then
    echo "Missing $v — fill it in env/admin.env or env/backup.env before testing delivery." >&2
    exit 1
  fi
done

echo "==> Sending a test alert to: $ALERT_EMAIL_TO"
if send_alert "[Ammari] Monitoring test alert" \
  "This is a one-off test from send-test-alert.sh, sent by hand on $(TZ=Asia/Jakarta date). It did
not come from a real disk/backup/health check — if you weren't expecting it, someone just ran
this script on the VPS.

If this arrived, Resend delivery for the monitoring alerts is working."; then
  echo "==> Sent — Resend confirmed a 2xx response. Check your inbox at: $ALERT_EMAIL_TO"
else
  echo "==> FAILED to send the test alert — see the WARNING above for the HTTP status/reason." >&2
  echo "    Check RESEND_API_KEY and EMAIL_FROM in env/admin.env, that the sending domain is" >&2
  echo "    still verified in Resend's dashboard, and that this VPS can reach api.resend.com." >&2
  exit 1
fi
