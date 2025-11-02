#!/usr/bin/env bash
set -euo pipefail

#
# Host setup script for MC LXD Manager (native, no Docker)
# Run this on your LXD host to prepare the environment and deploy the service.
#

echo "==> MC LXD Manager - Host Setup (Native Deployment)"

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root (sudo)"
   exit 1
fi

# 1. Install prerequisites
echo "==> Installing prerequisites (nodejs, npm, lxd, jq, curl, unzip)..."
apt-get update
apt-get install -y nodejs npm lxd jq curl unzip rsync

# 2. Initialize LXD if not already done
if ! lxc info >/dev/null 2>&1; then
    echo "==> LXD not initialized. Running 'lxd init' with defaults..."
    echo "Press ENTER to accept defaults or Ctrl+C to cancel and run 'sudo lxd init' manually."
    read -r
    lxd init --auto
else
    echo "==> LXD already initialized."
fi

# 3. Create service user and add to lxd group
echo "==> Creating service user 'mc' and adding to lxd group..."
useradd -r -s /usr/sbin/nologin mc 2>/dev/null || echo "User 'mc' already exists"
usermod -aG lxd mc

# 4. Create environment file if it doesn't exist
ENV_FILE="/etc/mc-lxd-manager.env"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "==> Creating environment file at $ENV_FILE..."
    cat > "$ENV_FILE" <<'EOF'
# Backend server bind (keep loopback; expose via Caddy/reverse proxy)
HOST=127.0.0.1
PORT=8080

# Trust proxy headers (needed if behind Caddy/nginx)
TRUST_PROXY=true

# LAN-only allow list (CIDRs)
ALLOW_CIDRS=192.168.0.0/16,10.0.0.0/8

# Optional admin token for write operations (CHANGE THIS!)
ADMIN_TOKEN=changeme

# Backup directory
BACKUP_DIR=/var/backups/mc-lxd-manager
EOF
    chmod 600 "$ENV_FILE"
    echo "==> IMPORTANT: Edit $ENV_FILE and set a secure ADMIN_TOKEN!"
else
    echo "==> Environment file $ENV_FILE already exists, skipping..."
fi

# 5. Install dependencies and build (if in repo directory)
if [[ -f "package.json" ]]; then
    echo "==> Installing Node.js dependencies..."

    # Try to enable corepack for pnpm
    corepack enable 2>/dev/null || echo "corepack not available, using npm"

    # Install with npm (works everywhere)
    npm install --workspaces

    echo "==> Building the application..."
    npm run build
else
    echo "==> WARNING: Not in repo directory, skipping npm install/build"
    echo "    Make sure to build the app before deploying!"
fi

# 6. Deploy to /opt/mc-lxd-manager
DEPLOY_DIR="/opt/mc-lxd-manager"
echo "==> Deploying to $DEPLOY_DIR..."
mkdir -p "$DEPLOY_DIR"

if [[ -f "package.json" ]]; then
    rsync -a --delete \
        --exclude 'node_modules' \
        --exclude '.git' \
        --exclude '.env' \
        . "$DEPLOY_DIR/"

    # Install production dependencies in deploy location
    cd "$DEPLOY_DIR"
    npm install --workspaces --omit=dev
    cd -
else
    echo "==> WARNING: Not in repo directory, skipping deployment"
fi

# 7. Set ownership
echo "==> Setting ownership to mc:mc..."
chown -R mc:mc "$DEPLOY_DIR"

# 8. Install systemd service
SERVICE_FILE="/etc/systemd/system/mc-lxd-manager.service"
if [[ -f "deploy/mc-lxd-manager.service" ]]; then
    echo "==> Installing systemd service..."
    cp deploy/mc-lxd-manager.service "$SERVICE_FILE"
    systemctl daemon-reload
else
    echo "==> WARNING: deploy/mc-lxd-manager.service not found"
fi

# 9. Create backup directory
BACKUP_DIR=$(grep BACKUP_DIR "$ENV_FILE" | cut -d= -f2 || echo "/var/backups/mc-lxd-manager")
echo "==> Creating backup directory at $BACKUP_DIR..."
mkdir -p "$BACKUP_DIR"
chown mc:mc "$BACKUP_DIR"

echo ""
echo "==> Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Edit $ENV_FILE and set a secure ADMIN_TOKEN"
echo "  2. Enable and start the service:"
echo "     sudo systemctl enable --now mc-lxd-manager"
echo "  3. Check status:"
echo "     sudo systemctl status mc-lxd-manager"
echo "  4. View logs:"
echo "     sudo journalctl -u mc-lxd-manager -f"
echo "  5. Access the web UI (via Caddy or direct):"
echo "     http://127.0.0.1:8080"
echo ""
echo "  6. In the browser console, set your admin token:"
echo "     localStorage.setItem('ADMIN_TOKEN', 'your-token-here');"
echo ""
