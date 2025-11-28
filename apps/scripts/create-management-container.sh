#!/usr/bin/env bash
set -euo pipefail

#
# Create Management Container
# Runs the web UI and management backend
#
# Run this script ON THE LXD HOST
#
# Prerequisites:
# - LXD installed and initialized with bridge network
# - Caddy container on same bridge for reverse proxy (recommended)
#
# Usage:
#   ./create-management-container.sh [name] [admin_token]
#
# Examples:
#   ./create-management-container.sh mc-manager
#   ./create-management-container.sh mc-manager my-custom-token
#

CONTAINER_NAME="${1:-mc-manager}"
ADMIN_TOKEN="${2:-$(openssl rand -hex 32)}"

echo "==> Creating MC Management Container"
echo "    Name: $CONTAINER_NAME"
echo ""

# Create container
lxc launch images:ubuntu/22.04 "$CONTAINER_NAME"

# Wait for boot
echo "==> Waiting for container to boot..."
sleep 5

# Set resource limits
lxc config set "$CONTAINER_NAME" limits.cpu=2
lxc config set "$CONTAINER_NAME" limits.memory=2GB

# NOTE: No proxy device added - traffic routes through Caddy on same LXD bridge

# Install dependencies
echo "==> Installing dependencies..."
lxc exec "$CONTAINER_NAME" -- bash -c "
set -euxo pipefail

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl git

# Install Node.js 20.x
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs

# Create app user
useradd -m -s /bin/bash mcmanager

# Create app directory
mkdir -p /opt/mc-lxd-manager
"

# Copy or clone repo
if [ -d "../../.git" ]; then
  echo "==> Copying local repository..."
  tar czf /tmp/mclauncher.tar.gz --exclude=node_modules --exclude=dist -C ../.. .
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
echo "==> Building application..."
lxc exec "$CONTAINER_NAME" -- bash -c "
cd /opt/mc-lxd-manager
npm install --workspaces
npm run build
npm install --workspaces --omit=dev
chown -R mcmanager:mcmanager /opt/mc-lxd-manager
"

# Create environment file
lxc exec "$CONTAINER_NAME" -- bash -c "cat > /opt/mc-lxd-manager/.env <<EOF
# Server binding - accepts connections from LXD bridge
HOST=0.0.0.0
PORT=8080

# Trust proxy headers from Caddy
TRUST_PROXY=true

# Allow access from LAN and LXD bridge
ALLOW_CIDRS=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12

# Admin token for write operations
ADMIN_TOKEN=${ADMIN_TOKEN}

# Storage paths
REGISTRY_FILE=/opt/mc-lxd-manager/servers.json
BACKUP_DIR=/var/backups/mc-lxd-manager
EOF
"

# Create backup directory
lxc exec "$CONTAINER_NAME" -- mkdir -p /var/backups/mc-lxd-manager
lxc exec "$CONTAINER_NAME" -- chown mcmanager:mcmanager /var/backups/mc-lxd-manager

# Create systemd service
lxc exec "$CONTAINER_NAME" -- bash -c "cat > /etc/systemd/system/mc-manager.service <<'EOF'
[Unit]
Description=MC LXD Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/mc-lxd-manager
EnvironmentFile=/opt/mc-lxd-manager/.env
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
echo ""
echo "==> Checking service status..."
lxc exec "$CONTAINER_NAME" -- systemctl status mc-manager --no-pager || true

# Get container IP
CONTAINER_IP=$(lxc list "$CONTAINER_NAME" -c4 --format=csv | cut -d' ' -f1)

echo ""
echo "============================================================"
echo "  MC Management Container Created!"
echo "============================================================"
echo ""
echo "Container: $CONTAINER_NAME"
echo "IP Address: $CONTAINER_IP"
echo "Internal URL: http://$CONTAINER_IP:8080"
echo ""
echo "Admin Token: ${ADMIN_TOKEN}"
echo ""
echo "============================================================"
echo "  IMPORTANT: Save the admin token!"
echo "============================================================"
echo ""
echo "In browser console (F12):"
echo "  localStorage.setItem('ADMIN_TOKEN', '${ADMIN_TOKEN}');"
echo ""
echo "============================================================"
echo "  Next Steps"
echo "============================================================"
echo ""
echo "1. Configure Caddy to proxy to $CONTAINER_IP:8080"
echo "   See Caddyfile.example in the repo"
echo ""
echo "2. Create Minecraft servers:"
echo "   sudo ./create-mc-server.sh mc-server-1 paper 1.21.3 4096 2 25565"
echo ""
echo "Commands:"
echo "  lxc exec $CONTAINER_NAME -- systemctl status mc-manager"
echo "  lxc exec $CONTAINER_NAME -- journalctl -u mc-manager -f"
echo ""
