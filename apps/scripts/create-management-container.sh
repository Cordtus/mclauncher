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
ADMIN_ALLOW_CIDRS="${ADMIN_ALLOW_CIDRS:-127.0.0.0/8,192.168.0.0/24,10.70.48.0/24,10.172.19.0/24}"
ADMIN_AUTH_METHODS="${ADMIN_AUTH_METHODS:-passkey}"
ADMIN_REQUIRE_CIDR="${ADMIN_REQUIRE_CIDR:-false}"
if [ -n "${PASSKEY_REGISTRATION_CODES:-}" ]; then
  PASSKEY_REGISTRATION_CODE=""
else
  PASSKEY_REGISTRATION_CODE="${PASSKEY_REGISTRATION_CODE:-$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')}"
  PASSKEY_REGISTRATION_CODES="initial:${PASSKEY_REGISTRATION_CODE}"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_FILES=()
cleanup_tmp_files() {
  for file in "${TMP_FILES[@]}"; do
    [ -f "$file" ] && rm -f "$file"
  done
}
trap cleanup_tmp_files EXIT

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
  APP_TARBALL="$(mktemp /tmp/mclauncher.XXXXXX.tar.gz)"
  TMP_FILES+=("$APP_TARBALL")
  git -C "$REPO_ROOT" ls-files -z | tar --null -czf "$APP_TARBALL" -C "$REPO_ROOT" --files-from=-
  lxc file push "$APP_TARBALL" "$CONTAINER_NAME/tmp/mclauncher.tar.gz"
  lxc exec "$CONTAINER_NAME" -- bash -c "
    cd /opt/mc-lxd-manager
    tar xzf /tmp/mclauncher.tar.gz
    rm /tmp/mclauncher.tar.gz
  "
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
ENV_FILE="$(mktemp /tmp/mclauncher-env.XXXXXX)"
TMP_FILES+=("$ENV_FILE")
chmod 600 "$ENV_FILE"
{
  printf '%s\n' 'HOST=0.0.0.0'
  printf '%s\n' 'PORT=8080'
  printf '%s\n' 'TRUST_PROXY=false'
  printf 'ALLOW_CIDRS=%s\n' "$ADMIN_ALLOW_CIDRS"
  printf 'ADMIN_REQUIRE_CIDR=%s\n' "$ADMIN_REQUIRE_CIDR"
  printf 'ADMIN_TOKEN=%s\n' "$ADMIN_TOKEN"
  printf 'ADMIN_AUTH_METHODS=%s\n' "$ADMIN_AUTH_METHODS"
  printf '%s\n' 'PASSKEYS_ENABLED=true'
  printf '%s\n' 'PASSKEY_RP_NAME=MC LXD Manager'
  printf 'PASSKEY_REGISTRATION_CODES=%s\n' "$PASSKEY_REGISTRATION_CODES"
  printf '%s\n' 'PASSKEY_STORE_FILE=/opt/mc-lxd-manager/passkeys.json'
  printf '%s\n' 'REGISTRY_FILE=/opt/mc-lxd-manager/servers.json'
} > "$ENV_FILE"
lxc file push "$ENV_FILE" "$CONTAINER_NAME/opt/mc-lxd-manager/.env"
lxc exec "$CONTAINER_NAME" -- chown mcmanager:mcmanager /opt/mc-lxd-manager/.env
lxc exec "$CONTAINER_NAME" -- chmod 600 /opt/mc-lxd-manager/.env

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
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/opt/mc-lxd-manager

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
if [ -n "$PASSKEY_REGISTRATION_CODE" ]; then
  echo "One-Time Passkey Setup Code: ${PASSKEY_REGISTRATION_CODE}"
else
  echo "One-Time Passkey Setup Codes: imported from PASSKEY_REGISTRATION_CODES"
fi
if [[ ",${ADMIN_AUTH_METHODS}," == *",token,"* ]]; then
  echo "Admin Token: ${ADMIN_TOKEN}"
fi
echo ""
echo "IMPORTANT: Save the setup code; each code can be used once to register an admin passkey."
echo "Open Admin Access in the gateway, paste the setup code, and register a passkey over HTTPS or localhost."
echo "After registering a passkey, synced passkeys can sign in on other devices without entering a token or setup code."
echo "Admin routes are passkey-gated by default. Set ADMIN_REQUIRE_CIDR=true if you also want LAN/VPN CIDR restrictions."
echo ""
echo "Commands:"
echo "  lxc exec $CONTAINER_NAME -- systemctl status mc-manager"
echo "  lxc exec $CONTAINER_NAME -- journalctl -u mc-manager -f"
echo ""
