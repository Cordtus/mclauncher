#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LXC_BIN="${LXC_BIN:-$(command -v lxc || command -v /snap/bin/lxc)}"
MANAGER_CONTAINER="${MCLAUNCHER_MANAGER_CONTAINER:-mc-manager}"
SERVER_CONTAINER="${MCLAUNCHER_SERVER_CONTAINER:-mc-server-1}"

echo "==> Deploying built MC LXD Manager artifacts"
echo "    Repo: $REPO_ROOT"
echo "    Manager: $MANAGER_CONTAINER"
echo "    Server: $SERVER_CONTAINER"

"$LXC_BIN" exec "$MANAGER_CONTAINER" -- rm -rf /opt/mc-lxd-manager/apps/web/dist /opt/mc-lxd-manager/apps/server/dist
"$LXC_BIN" file push "$REPO_ROOT/package.json" "$MANAGER_CONTAINER/opt/mc-lxd-manager/package.json"
"$LXC_BIN" file push "$REPO_ROOT/apps/web/package.json" "$MANAGER_CONTAINER/opt/mc-lxd-manager/apps/web/package.json"
"$LXC_BIN" file push "$REPO_ROOT/apps/server/package.json" "$MANAGER_CONTAINER/opt/mc-lxd-manager/apps/server/package.json"
"$LXC_BIN" file push -r "$REPO_ROOT/apps/web/dist/" "$MANAGER_CONTAINER/opt/mc-lxd-manager/apps/web/"
"$LXC_BIN" file push -r "$REPO_ROOT/apps/server/dist/" "$MANAGER_CONTAINER/opt/mc-lxd-manager/apps/server/"
"$LXC_BIN" exec "$MANAGER_CONTAINER" -- bash -lc 'chown mcmanager:mcmanager /opt/mc-lxd-manager/package.json /opt/mc-lxd-manager/apps/web/package.json /opt/mc-lxd-manager/apps/server/package.json && cd /opt/mc-lxd-manager/apps/server && npm install --omit=dev'
"$LXC_BIN" exec "$MANAGER_CONTAINER" -- systemctl restart mc-manager
"$LXC_BIN" exec "$MANAGER_CONTAINER" -- systemctl is-active mc-manager

"$LXC_BIN" exec "$SERVER_CONTAINER" -- rm -rf /opt/mc-agent/dist /opt/mc-agent/src
"$LXC_BIN" file push "$REPO_ROOT/apps/agent/package.json" "$SERVER_CONTAINER/opt/mc-agent/package.json"
"$LXC_BIN" file push -r "$REPO_ROOT/apps/agent/dist/" "$SERVER_CONTAINER/opt/mc-agent/"
"$LXC_BIN" exec "$SERVER_CONTAINER" -- bash -lc 'chown root:root /opt/mc-agent/package.json && cd /opt/mc-agent && npm install --omit=dev'
"$LXC_BIN" exec "$SERVER_CONTAINER" -- systemctl restart mc-agent
"$LXC_BIN" exec "$SERVER_CONTAINER" -- systemctl is-active mc-agent

echo "==> Deploy complete"
