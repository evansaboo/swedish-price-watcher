#!/usr/bin/env bash
# ============================================================
#  Raspberry Pi housekeeping — keeps the SD card from filling up.
#
#  On 2026-10-31 the card hit 100% (Discount Bandit wrote ~2 GB/day of
#  repeated errors), SQLite could no longer write, and the price watcher
#  crash-looped until the site went down. This script prevents a repeat:
#    * deletes Discount Bandit's Laravel logs older than BANDIT_LOG_DAYS
#    * truncates today's Bandit log if it grows past BANDIT_LOG_MAX_MB
#    * clears stale Chromium temp dirs and PHP core dumps in the container
#    * posts a Discord alert when the root disk is at/above DISK_ALERT_PERCENT
#
#  Runs as the app user from cron (no sudo needed):
#    bash scripts/pi-maintenance.sh --install   # adds the hourly cron entry
#    bash scripts/pi-maintenance.sh             # one run now
# ============================================================
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BANDIT_DIR="${BANDIT_DIR:-$HOME/discount-bandit}"
BANDIT_CONTAINER="${BANDIT_CONTAINER:-discount-bandit}"
BANDIT_LOG_DAYS="${BANDIT_LOG_DAYS:-3}"
BANDIT_LOG_MAX_MB="${BANDIT_LOG_MAX_MB:-500}"
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

# --- Discount Bandit logs -------------------------------------------------
# The log dir is ours, so we can unlink root-owned files in it without sudo.
if [[ -d "$BANDIT_DIR/logs" ]]; then
  find "$BANDIT_DIR/logs" -maxdepth 1 -name 'laravel-*.log' -mtime "+$((BANDIT_LOG_DAYS - 1))" -print -delete \
    | sed 's/^/deleted old log /' | while read -r line; do log "$line"; done

  # Truncating needs write access to the file itself, so do it as root in the container.
  find "$BANDIT_DIR/logs" -maxdepth 1 -name 'laravel-*.log' -size "+${BANDIT_LOG_MAX_MB}M" -printf '%f\n' \
    | while read -r name; do
        docker exec "$BANDIT_CONTAINER" truncate -s 0 "/app/storage/logs/$name" \
          && log "truncated $name (over ${BANDIT_LOG_MAX_MB} MB)"
      done
fi

# --- Discount Bandit container scratch -----------------------------------
if docker inspect "$BANDIT_CONTAINER" >/dev/null 2>&1; then
  docker exec "$BANDIT_CONTAINER" sh -c '
    n=$(find /tmp -mindepth 1 -maxdepth 1 -mmin +1440 | wc -l)
    find /tmp -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} +
    c=$(find /app -maxdepth 1 -name "core.*" -mmin +1440 | wc -l)
    find /app -maxdepth 1 -name "core.*" -mmin +1440 -delete
    [ "$n" -gt 0 ] || [ "$c" -gt 0 ] && echo "removed $n stale /tmp entries and $c core dumps in container"
    true' | while read -r line; do log "$line"; done
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
