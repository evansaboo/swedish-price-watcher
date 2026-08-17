#!/usr/bin/env bash
#
# Configure Discord one-tap buy buttons for the assisted-checkout feature.
#
# Validates every credential against Discord's API *before* touching .env, so a
# typo can never leave the service in a half-configured state. Secrets are never
# echoed back.
#
# Usage (run on the host that serves the app):
#   ./scripts/setup-discord-buy.sh
#   ./scripts/setup-discord-buy.sh --public-key KEY --bot-token TOKEN --owner-ids ID[,ID...]
#
# Optional:
#   --channel-id ID      Alert channel. Defaults to the existing value in .env,
#                        otherwise resolved from DISCORD_WEBHOOK_URL.
#   --public-url URL     Public base URL. Defaults to PUBLIC_BASE_URL in .env.
#   --no-restart         Write .env but do not restart the service.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=".env"
SERVICE="swedish-price-watcher"

PUBLIC_KEY=""; BOT_TOKEN=""; OWNER_IDS=""; CHANNEL_ID=""; PUBLIC_URL=""; RESTART=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-key) PUBLIC_KEY="${2:-}"; shift 2 ;;
    --bot-token)  BOT_TOKEN="${2:-}";  shift 2 ;;
    --owner-ids)  OWNER_IDS="${2:-}";  shift 2 ;;
    --channel-id) CHANNEL_ID="${2:-}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:-}"; shift 2 ;;
    --no-restart) RESTART=0; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
ok()  { echo "✓ $*"; }

[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found. Run this from the app directory."

env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

env_set() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    local tmp; tmp="$(mktemp)"
    # Rewrite with awk so slashes/ampersands in secrets are never interpreted.
    awk -v k="$key" -v v="$value" \
      'index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE" && rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

echo "=== Discord buy-button setup ==="
echo

# ── Collect ──────────────────────────────────────────────────────────────────
if [[ -z "$PUBLIC_KEY" ]]; then
  read -r -p "Discord Public Key (Dev Portal > General Information): " PUBLIC_KEY
fi
if [[ -z "$BOT_TOKEN" ]]; then
  read -r -s -p "Discord Bot Token (Dev Portal > Bot > Reset Token): " BOT_TOKEN; echo
fi
if [[ -z "$OWNER_IDS" ]]; then
  read -r -p "Your Discord User ID(s), comma-separated: " OWNER_IDS
fi

PUBLIC_KEY="$(echo "$PUBLIC_KEY" | tr -d '[:space:]')"
BOT_TOKEN="$(echo "$BOT_TOKEN" | tr -d '[:space:]')"
OWNER_IDS="$(echo "$OWNER_IDS" | tr -d '[:space:]')"

# ── Validate format ──────────────────────────────────────────────────────────
[[ "$PUBLIC_KEY" =~ ^[0-9a-fA-F]{64}$ ]] \
  || die "Public key must be 64 hex characters (got ${#PUBLIC_KEY}). Copy it from General Information, not the Bot tab."
ok "Public key format looks right"

[[ "$OWNER_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]] \
  || die "Owner IDs must be numeric snowflakes, comma-separated. Enable Developer Mode, then right-click yourself > Copy User ID."
ok "Owner ID format looks right"

[[ -n "$BOT_TOKEN" ]] || die "Bot token is empty."

# ── Validate against Discord ─────────────────────────────────────────────────
api() {
  curl -sS --max-time 25 -w '\n%{http_code}' \
    -H "Authorization: Bot $BOT_TOKEN" \
    -H "User-Agent: swedish-price-watcher (setup script)" "https://discord.com/api/v10$1"
}

resp="$(api /users/@me)" || die "Could not reach discord.com."
code="$(printf '%s' "$resp" | tail -1)"
body="$(printf '%s' "$resp" | sed '$d')"
[[ "$code" == "200" ]] \
  || die "Discord rejected the bot token (HTTP $code). Reset it in the Bot tab and copy the whole value."
BOT_NAME="$(printf '%s' "$body" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("username","?"))')"
ok "Bot token valid — authenticated as \"$BOT_NAME\""

resp="$(api /oauth2/applications/@me)"
code="$(printf '%s' "$resp" | tail -1)"
APP_ID=""
if [[ "$code" == "200" ]]; then
  APP_ID="$(printf '%s' "$resp" | sed '$d' | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))')"
fi

# ── Resolve the alert channel ────────────────────────────────────────────────
if [[ -z "$CHANNEL_ID" ]]; then
  CHANNEL_ID="$(env_get DISCORD_ALERT_CHANNEL_ID)"
fi
if [[ -z "$CHANNEL_ID" ]]; then
  WH="$(env_get DISCORD_WEBHOOK_URL)"
  if [[ -n "$WH" ]]; then
    CHANNEL_ID="$(curl -sS --max-time 20 "$WH" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin).get("channel_id",""))' 2>/dev/null || true)"
    [[ -n "$CHANNEL_ID" ]] && ok "Resolved alert channel from DISCORD_WEBHOOK_URL"
  fi
fi
[[ -n "$CHANNEL_ID" ]] || die "No alert channel. Pass --channel-id (right-click the channel > Copy Channel ID)."

resp="$(api "/channels/$CHANNEL_ID")"
code="$(printf '%s' "$resp" | tail -1)"
if [[ "$code" != "200" ]]; then
  echo
  echo "✗ The bot cannot see channel $CHANNEL_ID (HTTP $code)."
  if [[ -n "$APP_ID" ]]; then
    echo "  Invite it to your server first:"
    echo "  https://discord.com/oauth2/authorize?client_id=$APP_ID&scope=bot&permissions=19456"
  fi
  echo "  Then make sure the channel's permissions let it View Channel + Send Messages."
  exit 1
fi
CHANNEL_NAME="$(printf '%s' "$resp" | sed '$d' | python3 -c 'import sys,json; print(json.load(sys.stdin).get("name","?"))')"
ok "Bot can reach #$CHANNEL_NAME"

# ── Write ────────────────────────────────────────────────────────────────────
cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
env_set DISCORD_PUBLIC_KEY "$PUBLIC_KEY"
env_set DISCORD_BOT_TOKEN "$BOT_TOKEN"
env_set DISCORD_OWNER_IDS "$OWNER_IDS"
env_set DISCORD_ALERT_CHANNEL_ID "$CHANNEL_ID"
if ! grep -q '^ADMIN_API_TOKEN=.\+' "$ENV_FILE"; then
  env_set ADMIN_API_TOKEN "$(openssl rand -hex 32)"
  ok "Generated ADMIN_API_TOKEN (read it with: grep ADMIN_API_TOKEN .env)"
fi
chmod 600 "$ENV_FILE"
ok "Wrote $ENV_FILE (mode 600, previous version backed up)"

# ── Restart and verify ───────────────────────────────────────────────────────
if [[ "$RESTART" == "1" ]]; then
  echo
  echo "Restarting $SERVICE…"
  sudo systemctl restart "$SERVICE"
  PORT_VAL="$(env_get PORT)"; PORT_VAL="${PORT_VAL:-3000}"
  for _ in $(seq 1 30); do
    sleep 2
    curl -sf --max-time 5 "http://localhost:$PORT_VAL/health" >/dev/null 2>&1 && break
  done
  TOKEN="$(env_get ADMIN_API_TOKEN)"
  state="$(curl -sS --max-time 20 -H "Authorization: Bearer $TOKEN" \
    "http://localhost:$PORT_VAL/api/purchase" || true)"
  if printf '%s' "$state" | grep -q '"discordConfigured":true'; then
    ok "Service restarted — Discord buttons are ACTIVE"
  else
    die "Service restarted but discordConfigured is still false. Check: journalctl -u $SERVICE -n 50"
  fi
fi

# ── Final instructions ───────────────────────────────────────────────────────
BASE_URL="${PUBLIC_URL:-$(env_get PUBLIC_BASE_URL)}"
echo
echo "=== One manual step left ==="
echo
echo "In the Developer Portal > General Information, set"
echo "  Interactions Endpoint URL:"
if [[ -n "$BASE_URL" ]]; then
  echo "    ${BASE_URL%/}/api/discord/interactions"
else
  echo "    https://<your-public-host>/api/discord/interactions"
fi
echo
echo "Discord sends a signed test request and will only save the URL if it"
echo "verifies — which it now can, because the public key is live."
echo
echo "Reminder: payment is never automated. Buttons stage the cart and stop at"
echo "checkout; you always confirm the card step yourself."
