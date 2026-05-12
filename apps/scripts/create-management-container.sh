#!/usr/bin/env bash
set -euo pipefail

#
# Create Management Container
# Runs the web UI and management backend
# Run this script ON THE LXD HOST
#

CONTAINER_NAME="${1:-mc-manager}"
PUBLIC_PORT="${2:-8080}"
ADMIN_TOKEN="${3:-$(openssl rand -hex 32)}"
PUBLIC_LISTEN="${PUBLIC_LISTEN:-127.0.0.1}"
ADMIN_ALLOW_CIDRS="${ADMIN_ALLOW_CIDRS:-127.0.0.0/8,192.168.0.0/24,10.70.48.0/24}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "==> Creating MC Management Container"
echo "    Name: $CONTAINER_NAME"
echo "    Listen: ${PUBLIC_LISTEN}:${PUBLIC_PORT}"

# Create container
lxc launch images:ubuntu/22.04 "$CONTAINER_NAME"

# Wait for boot
sleep 5

# Set resource limits
lxc config set "$CONTAINER_NAME" limits.cpu=2
lxc config set "$CONTAINER_NAME" limits.memory=2GB

# Add proxy for web UI
lxc config device add "$CONTAINER_NAME" web-proxy proxy \
  listen="tcp:${PUBLIC_LISTEN}:${PUBLIC_PORT}" \
  connect="tcp:127.0.0.1:8080"

# Install dependencies
lxc exec "$CONTAINER_NAME" -- bash -c "
set -euxo pipefail

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl git ca-certificates gnupg

# Install Node.js 20.x
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs

# Create app user
useradd -m -s /bin/bash mcmanager

# Clone and build app
mkdir -p /opt/mc-lxd-manager
cd /opt/mc-lxd-manager
"

# Copy or clone repo
if [ -d "$REPO_ROOT/.git" ]; then
  echo "==> Copying local repository..."
  tar czf /tmp/mclauncher.tar.gz --exclude=node_modules --exclude=dist -C "$REPO_ROOT" .
  lxc file push /tmp/mclauncher.tar.gz "$CONTAINER_NAME/tmp/"
  lxc exec "$CONTAINER_NAME" -- bash -c "
    cd /opt/mc-lxd-manager
    tar xzf /tmp/mclauncher.tar.gz
    rm /tmp/mclauncher.tar.gz
  "
  rm /tmp/mclauncher.tar.gz
else
  echo "==> Cloning from GitHub..."
  lxc exec "$CONTAINER_NAME" -- bash -c "
    cd /opt
    git clone https://github.com/Cordtus/mclauncher.git mc-lxd-manager
  "
fi

# Build application
lxc exec "$CONTAINER_NAME" -- bash -c "
cd /opt/mc-lxd-manager
npm install --workspaces
npm run build
npm install --workspaces --omit=dev
chown -R mcmanager:mcmanager /opt/mc-lxd-manager
"

# Create environment file
lxc exec "$CONTAINER_NAME" -- bash -c "cat > /opt/mc-lxd-manager/.env <<EOF
HOST=0.0.0.0
PORT=8080
TRUST_PROXY=false
ALLOW_CIDRS=${ADMIN_ALLOW_CIDRS}
ADMIN_TOKEN=${ADMIN_TOKEN}
ADMIN_AUTH_METHODS=token,passkey
PASSKEYS_ENABLED=true
PASSKEY_RP_NAME=MC LXD Manager
PASSKEY_STORE_FILE=/opt/mc-lxd-manager/passkeys.json
REGISTRY_FILE=/opt/mc-lxd-manager/servers.json
EOF
chown mcmanager:mcmanager /opt/mc-lxd-manager/.env
chmod 600 /opt/mc-lxd-manager/.env
"

# Create systemd service
lxc exec "$CONTAINER_NAME" -- bash -c "cat > /etc/systemd/system/mc-manager.service <<'EOF'
[Unit]
Description=MC LXD Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/mc-lxd-manager
Environment=NODE_ENV=production
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
RestartSec=3
User=mcmanager
Group=mcmanager

[Install]
WantedBy=multi-user.target
EOF
"

# Enable and start
lxc exec "$CONTAINER_NAME" -- systemctl daemon-reload
lxc exec "$CONTAINER_NAME" -- systemctl enable mc-manager
lxc exec "$CONTAINER_NAME" -- systemctl start mc-manager

# Wait and check status
sleep 3
lxc exec "$CONTAINER_NAME" -- systemctl status mc-manager --no-pager || true

echo ""
echo "==> Management container created!"
echo ""
echo "Container: $CONTAINER_NAME"
echo "Web UI: http://${PUBLIC_LISTEN}:${PUBLIC_PORT}"
echo "Admin Token: ${ADMIN_TOKEN}"
echo ""
echo "IMPORTANT: Save this token!"
echo "Open Admin Access in the gateway and paste this token. You can register a passkey there when serving the gateway over HTTPS or localhost."
echo "For LAN access, put Caddy or another trusted reverse proxy in front of the management container and keep admin routes LAN-only."
echo ""
echo "Commands:"
echo "  lxc exec $CONTAINER_NAME -- systemctl status mc-manager"
echo "  lxc exec $CONTAINER_NAME -- journalctl -u mc-manager -f"
echo ""
