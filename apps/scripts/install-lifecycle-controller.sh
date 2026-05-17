#!/usr/bin/env bash
set -euo pipefail

#
# Install the narrow host-side lifecycle controller.
# Run this on the LXD host as root.
#

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MANAGER_CONTAINER="${MCLAUNCHER_MANAGER_CONTAINER:-mc-manager}"
CONTROLLER_HOST="${SERVER_LIFECYCLE_CONTROLLER_HOST:-10.70.48.1}"
CONTROLLER_PORT="${SERVER_LIFECYCLE_CONTROLLER_PORT:-9107}"
ENV_FILE="${SERVER_LIFECYCLE_CONTROLLER_ENV_FILE:-/etc/mclauncher-lifecycle-controller.env}"
SERVICE_FILE="${SERVER_LIFECYCLE_CONTROLLER_SERVICE_FILE:-/etc/systemd/system/mclauncher-lifecycle-controller.service}"
LXC_BIN="${LXC_BIN:-$(command -v lxc || command -v /snap/bin/lxc)}"

if [ "$(id -u)" -ne 0 ]; then
  echo "install-lifecycle-controller.sh must be run as root" >&2
  exit 1
fi

if [ ! -x "$REPO_DIR/apps/scripts/mc-server-lifecycle.mjs" ]; then
  echo "Lifecycle script not found or executable: $REPO_DIR/apps/scripts/mc-server-lifecycle.mjs" >&2
  exit 1
fi

install -d -m 700 "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$(openssl rand -hex 32)"
  {
    printf 'SERVER_LIFECYCLE_CONTROLLER_HOST=%s\n' "$CONTROLLER_HOST"
    printf 'SERVER_LIFECYCLE_CONTROLLER_PORT=%s\n' "$CONTROLLER_PORT"
    printf 'SERVER_LIFECYCLE_CONTROLLER_TOKEN=%s\n' "$TOKEN"
    printf 'REGISTRY_FILE=%s\n' '/opt/mc-lxd-manager/servers.json'
    printf 'SERVER_ARCHIVES_FILE=%s\n' '/opt/mc-lxd-manager/server-archives.json'
    printf 'MAX_ACTIVE_SERVERS=%s\n' '3'
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  TOKEN="$(sed -n 's/^SERVER_LIFECYCLE_CONTROLLER_TOKEN=//p' "$ENV_FILE" | head -n1)"
  if [ -z "$TOKEN" ]; then
    TOKEN="$(openssl rand -hex 32)"
    printf 'SERVER_LIFECYCLE_CONTROLLER_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
  fi
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=MC LXD Manager lifecycle controller
After=network-online.target snap.lxd.daemon.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $REPO_DIR/apps/scripts/mc-server-lifecycle.mjs serve-controller --registry-mode manager --manager-container $MANAGER_CONTAINER
Restart=always
RestartSec=3
NoNewPrivileges=false
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=full
ReadWritePaths=$REPO_DIR /run/lock /tmp
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

chmod 644 "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable --now "$(basename "$SERVICE_FILE")"
systemctl restart "$(basename "$SERVICE_FILE")"

if [ -n "$LXC_BIN" ] && "$LXC_BIN" info "$MANAGER_CONTAINER" >/dev/null 2>&1; then
  "$LXC_BIN" exec "$MANAGER_CONTAINER" -- bash -lc '
set -euo pipefail
ENV_FILE=/opt/mc-lxd-manager/.env
set_env() {
  key="$1"
  value="$2"
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '"'"'
    BEGIN { done = 0 }
    $0 ~ "^" key "=" { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  '"'"' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}
set_env SERVER_LIFECYCLE_CONTROLLER_URL "http://'"$CONTROLLER_HOST:$CONTROLLER_PORT"'"
set_env SERVER_LIFECYCLE_CONTROLLER_TOKEN "'"$TOKEN"'"
set_env SERVER_ARCHIVES_FILE /opt/mc-lxd-manager/server-archives.json
set_env MAX_ACTIVE_SERVERS 3
chown mcmanager:mcmanager "$ENV_FILE"
chmod 600 "$ENV_FILE"
systemctl restart mc-manager
'
fi

echo "Lifecycle controller installed at http://$CONTROLLER_HOST:$CONTROLLER_PORT"
