#!/usr/bin/env bash
set -euo pipefail

#
# Install the narrow host-side lifecycle controller.
# Run this on the LXD host as root, or as the host user that already has LXD
# permissions. Non-root installs use a systemd user service.
#

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MANAGER_CONTAINER="${MCLAUNCHER_MANAGER_CONTAINER:-mc-manager}"
CONTROLLER_HOST="${SERVER_LIFECYCLE_CONTROLLER_HOST:-10.70.48.1}"
CONTROLLER_PORT="${SERVER_LIFECYCLE_CONTROLLER_PORT:-9107}"
LXC_BIN="${LXC_BIN:-$(command -v lxc 2>/dev/null || command -v /snap/bin/lxc 2>/dev/null || true)}"

if [ "$(id -u)" -eq 0 ]; then
  INSTALL_MODE=system
  ENV_FILE="${SERVER_LIFECYCLE_CONTROLLER_ENV_FILE:-/etc/mclauncher-lifecycle-controller.env}"
  SERVICE_FILE="${SERVER_LIFECYCLE_CONTROLLER_SERVICE_FILE:-/etc/systemd/system/mclauncher-lifecycle-controller.service}"
  LOCK_FILE="${SERVER_LIFECYCLE_LOCK_FILE:-/run/lock/mc-server-lifecycle.lock}"
else
  INSTALL_MODE=user
  INSTALL_USER="$(id -un)"
  STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/mclauncher"
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/mclauncher"
  SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  ENV_FILE="${SERVER_LIFECYCLE_CONTROLLER_ENV_FILE:-$CONFIG_DIR/lifecycle-controller.env}"
  SERVICE_FILE="${SERVER_LIFECYCLE_CONTROLLER_SERVICE_FILE:-$SYSTEMD_USER_DIR/mclauncher-lifecycle-controller.service}"
  LOCK_FILE="${SERVER_LIFECYCLE_LOCK_FILE:-$STATE_DIR/lifecycle-controller.lock}"
fi

if [ ! -x "$REPO_DIR/apps/scripts/mc-server-lifecycle.mjs" ]; then
  echo "Lifecycle script not found or executable: $REPO_DIR/apps/scripts/mc-server-lifecycle.mjs" >&2
  exit 1
fi

if [ -z "$LXC_BIN" ]; then
  echo "lxc command not found on this host" >&2
  exit 1
fi

if ! "$LXC_BIN" list --format=json >/dev/null 2>&1; then
  echo "The current user cannot access LXD. Run this as root or as a host user in the LXD admin group." >&2
  exit 1
fi

if ! "$LXC_BIN" info "$MANAGER_CONTAINER" >/dev/null 2>&1; then
  echo "Manager container '$MANAGER_CONTAINER' is not visible from this LXD namespace. Run this on the LXD host." >&2
  exit 1
fi

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  if [ -f "$ENV_FILE" ]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { done = 0 }
      $0 ~ "^" key "=" { print key "=" value; done = 1; next }
      { print }
      END { if (!done) print key "=" value }
    ' "$ENV_FILE" > "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" > "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
  chmod 600 "$ENV_FILE"
}

install -d -m 700 "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$(openssl rand -hex 32)"
else
  TOKEN="$(sed -n 's/^SERVER_LIFECYCLE_CONTROLLER_TOKEN=//p' "$ENV_FILE" | head -n1)"
  if [ -z "$TOKEN" ]; then
    TOKEN="$(openssl rand -hex 32)"
  fi
fi
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
set_env_value SERVER_LIFECYCLE_CONTROLLER_HOST "$CONTROLLER_HOST"
set_env_value SERVER_LIFECYCLE_CONTROLLER_PORT "$CONTROLLER_PORT"
set_env_value SERVER_LIFECYCLE_CONTROLLER_TOKEN "$TOKEN"
set_env_value REGISTRY_FILE /opt/mc-lxd-manager/servers.json
set_env_value SERVER_ARCHIVES_FILE /opt/mc-lxd-manager/server-archives.json
set_env_value MAX_ACTIVE_SERVERS 3
set_env_value SERVER_LIFECYCLE_LOCK_FILE "$LOCK_FILE"
if [ "$INSTALL_MODE" = "user" ]; then
  set_env_value SERVER_LIFECYCLE_ALLOW_NON_ROOT true
fi

LINGER_STATUS=unknown
if [ "$INSTALL_MODE" = "user" ] && command -v loginctl >/dev/null 2>&1; then
  LINGER_STATUS="$(loginctl show-user "$INSTALL_USER" -p Linger --value 2>/dev/null || true)"
  if [ "$LINGER_STATUS" != "yes" ]; then
    if loginctl enable-linger "$INSTALL_USER" >/dev/null 2>&1; then
      LINGER_STATUS=yes
    fi
  fi
fi
if [ "$INSTALL_MODE" = "user" ] && [ "$LINGER_STATUS" != "yes" ] && [ "${SERVER_LIFECYCLE_ALLOW_SESSION_SERVICE:-false}" != "true" ]; then
  echo "systemd lingering is not enabled for $INSTALL_USER, and the installer could not enable it." >&2
  echo "Run 'sudo loginctl enable-linger $INSTALL_USER' or set SERVER_LIFECYCLE_ALLOW_SESSION_SERVICE=true to allow a login-session-scoped controller." >&2
  exit 1
fi
if [ "$INSTALL_MODE" = "user" ]; then
  USER_RUNTIME_DIR="/run/user/$(id -u)"
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "$USER_RUNTIME_DIR" ]; then
    export XDG_RUNTIME_DIR="$USER_RUNTIME_DIR"
  fi
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  fi
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    echo "Cannot reach the systemd user manager for $INSTALL_USER. Ensure lingering is enabled and /run/user/$(id -u)/bus is available." >&2
    exit 1
  fi
fi

install -d -m 755 "$(dirname "$SERVICE_FILE")"
if [ "$INSTALL_MODE" = "system" ]; then
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
else
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=MC LXD Manager lifecycle controller

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $REPO_DIR/apps/scripts/mc-server-lifecycle.mjs serve-controller --registry-mode manager --manager-container $MANAGER_CONTAINER
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

  chmod 644 "$SERVICE_FILE"
  systemctl --user daemon-reload
  systemctl --user enable --now "$(basename "$SERVICE_FILE")"
  systemctl --user restart "$(basename "$SERVICE_FILE")"
fi

"$LXC_BIN" exec "$MANAGER_CONTAINER" -- bash -lc '
set -euo pipefail
ENV_FILE=/opt/mc-lxd-manager/.env
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
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

echo "Lifecycle controller installed at http://$CONTROLLER_HOST:$CONTROLLER_PORT"
if [ "$INSTALL_MODE" = "user" ] && [ "$LINGER_STATUS" != "yes" ]; then
  echo "Warning: systemd lingering is not enabled for $INSTALL_USER; this controller is scoped to the active user session." >&2
fi
