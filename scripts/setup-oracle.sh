#!/usr/bin/env bash
# ============================================================
#  Oracle Cloud (Ubuntu 22.04) — one-command server setup
#  Run as root or with sudo: bash scripts/setup-oracle.sh
# ============================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/YOUR_GITHUB_USERNAME/swedish-price-watcher.git}"
APP_DIR="/opt/swedish-price-watcher"
APP_USER="pricewatcher"

echo "==> Installing system packages..."
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release git ufw

# --- Docker ---
echo "==> Installing Docker..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

systemctl enable --now docker

# --- App user & directory ---
echo "==> Creating app user '${APP_USER}'..."
id "${APP_USER}" &>/dev/null || useradd -r -m -s /bin/bash "${APP_USER}"
usermod -aG docker "${APP_USER}"

# --- Clone repo ---
echo "==> Cloning repo to ${APP_DIR}..."
if [ -d "${APP_DIR}/.git" ]; then
  echo "    (already cloned, pulling latest)"
  git -C "${APP_DIR}" pull
else
  git clone "${REPO_URL}" "${APP_DIR}"
fi

chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# --- Persistent data dirs ---
mkdir -p "${APP_DIR}/data" "${APP_DIR}/config"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}/data" "${APP_DIR}/config"

# --- .env ---
if [ ! -f "${APP_DIR}/.env" ]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  echo ""
  echo "  !! Created ${APP_DIR}/.env from .env.example"
  echo "  !! Edit it now to add your tokens:  nano ${APP_DIR}/.env"
  echo ""
fi

# --- Firewall ---
echo "==> Configuring firewall (SSH + port 3000)..."
ufw allow OpenSSH
ufw allow 3000/tcp
ufw --force enable

# --- systemd service ---
echo "==> Installing systemd service..."
cat > /etc/systemd/system/swedish-price-watcher.service <<EOF
[Unit]
Description=Swedish Price Watcher
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=forking
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStartPre=docker compose pull --quiet
ExecStart=docker compose up -d --build
ExecStop=docker compose down
Restart=on-failure
RestartSec=30s

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable swedish-price-watcher

echo ""
echo "============================================================"
echo " Setup complete!"
echo "============================================================"
echo ""
echo " Next steps:"
echo "   1. Edit your environment variables:"
echo "      nano ${APP_DIR}/.env"
echo ""
echo "   2. Start the app:"
echo "      systemctl start swedish-price-watcher"
echo "      # or manually:"
echo "      cd ${APP_DIR} && docker compose up -d --build"
echo ""
echo "   3. View logs:"
echo "      docker compose -f ${APP_DIR}/docker-compose.yml logs -f app"
echo ""
echo "   4. Access the UI:"
echo "      http://<your-oracle-ip>:3000"
echo ""
