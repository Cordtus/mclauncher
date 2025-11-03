#!/bin/bash
# Deploy updated code to LXD containers
# Run this script from the repository root on the LXD host

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Deploying from: $SCRIPT_DIR"
echo ""

# Deploy to management container
echo "→ Updating management container (mc-manager)..."
lxc file push -r "$SCRIPT_DIR/apps/web/dist/" mc-manager/opt/mc-lxd-manager/apps/web/
lxc file push -r "$SCRIPT_DIR/apps/server/dist/" mc-manager/opt/mc-lxd-manager/apps/server/
lxc exec mc-manager -- systemctl restart mc-manager
echo "✓ Management server restarted"
echo ""

# Deploy to server container
echo "→ Updating server container (mc-server-1)..."
lxc file push -r "$SCRIPT_DIR/apps/agent/dist/" mc-server-1/opt/mc-agent/dist/
lxc file push -r "$SCRIPT_DIR/apps/agent/src/" mc-server-1/opt/mc-agent/src/
lxc exec mc-server-1 -- systemctl restart mc-agent
echo "✓ Agent restarted"
echo ""

echo "Deployment complete!"
echo ""
echo "Check status:"
echo "  lxc exec mc-manager -- systemctl status mc-manager"
echo "  lxc exec mc-manager -- journalctl -u mc-manager -n 20"
echo "  lxc exec mc-server-1 -- systemctl status mc-agent"
echo "  lxc exec mc-server-1 -- journalctl -u mc-agent -n 20"
