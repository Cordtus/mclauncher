#!/usr/bin/env bash
set -euo pipefail

#
# Create a one-time passkey setup code from the LXD host.
# This intentionally requires root because setup codes can add management admins.
#

if [ "$(id -u)" -ne 0 ]; then
  echo "error: create-passkey-setup-code must be run as root" >&2
  exit 1
fi

LXC_BIN="${LXC_BIN:-$(command -v lxc || command -v /snap/bin/lxc)}"
MANAGER_CONTAINER="${MCLAUNCHER_MANAGER_CONTAINER:-mc-manager}"

exec "$LXC_BIN" exec "$MANAGER_CONTAINER" -- bash -lc \
  'cd /opt/mc-lxd-manager && exec node apps/server/dist/index.js create-passkey-setup-code "$@"' \
  bash "$@"
