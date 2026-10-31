#!/usr/bin/env bash
# ============================================================
#  Raspberry Pi housekeeping — warns before the root disk fills up.
#
#  On 2026-10-31 the disk hit 100% (runaway logs from a since-removed Docker
#  app), SQLite could no longer write, and the price watcher crash-looped until
#  the site went down. This script posts a Discord alert (via
#  DISCORD_WEBHOOK_URL in .env) when the root disk is at/above
#  DISK_ALERT_PERCENT, at most once every ALERT_EVERY_HOURS.
#
#  Runs as the app user from cron (no sudo needed):
#    bash scripts/pi-maintenance.sh --install   # adds the hourly cron entry
#    bash scripts/pi-maintenance.sh             # one run now
# ============================================================
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DISK_ALERT_PERCENT="${DISK_ALERT_PERCENT:-85}"
ALERT_EVERY_HOURS="${ALERT_EVERY_HOURS:-6}"
STATE_FILE="${STATE_FILE:-$APP_DIR/data/.disk-alert-sent}"

log() { echo "[pi-maintenance] $*"; }

if [[ "${1:-}" == "--install" ]]; then
  entry="17 * * * * $APP_DIR/scripts/pi-maintenance.sh 2>&1 | logger -t pi-maintenance"
  { crontab -l 2>/dev/null | grep -v 'scripts/pi-maintenance.sh'; echo "$entry"; } | crontab -
  log "installed hourly cron entry: $entry"
  exit 0
fi

# --- Disk alert ------------------------------------------------------------
used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if (( used >= DISK_ALERT_PERCENT )); then
  last=$(stat -c %Y "$STATE_FILE" 2>/dev/null || echo 0)
  if (( $(date +%s) - last >= ALERT_EVERY_HOURS * 3600 )); then
    webhook=$(grep -E '^DISCORD_WEBHOOK_URL=' "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
    free=$(df -h --output=avail / | tail -1 | tr -d ' ')
    msg="⚠️ $(hostname): disk is ${used}% full (${free} free). The price watcher stops writing at 100%."
    log "$msg"
    if [[ -n "$webhook" ]]; then
      curl -fsS -m 15 -H 'Content-Type: application/json' \
        -d "{\"username\":\"Pi maintenance\",\"content\":\"$msg\"}" "$webhook" >/dev/null \
        && touch "$STATE_FILE"
    else
      log "DISCORD_WEBHOOK_URL is not set in $APP_DIR/.env; alert not sent"
    fi
  fi
fi
