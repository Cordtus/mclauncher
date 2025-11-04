#!/bin/bash
# Improved deployment script for MC LXD Manager
# Usage: ./deploy.sh [--web] [--server] [--agent] [--all]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_WEB=false
DEPLOY_SERVER=false
DEPLOY_AGENT=false

# Parse arguments
if [ $# -eq 0 ]; then
    echo "Usage: $0 [--web] [--server] [--agent] [--all]"
    echo ""
    echo "Options:"
    echo "  --web     Deploy web UI only"
    echo "  --server  Deploy management server only"
    echo "  --agent   Deploy agent only"
    echo "  --all     Deploy everything (default if no args)"
    exit 1
fi

for arg in "$@"; do
    case $arg in
        --web)
            DEPLOY_WEB=true
            ;;
        --server)
            DEPLOY_SERVER=true
            ;;
        --agent)
            DEPLOY_AGENT=true
            ;;
        --all)
            DEPLOY_WEB=true
            DEPLOY_SERVER=true
            DEPLOY_AGENT=true
            ;;
        *)
            echo "Unknown option: $arg"
            exit 1
            ;;
    esac
done

# If no specific component selected, deploy all
if [ "$DEPLOY_WEB" = false ] && [ "$DEPLOY_SERVER" = false ] && [ "$DEPLOY_AGENT" = false ]; then
    DEPLOY_WEB=true
    DEPLOY_SERVER=true
    DEPLOY_AGENT=true
fi

echo "================================================"
echo "MC LXD Manager Deployment"
echo "================================================"
echo "Deploying from: $SCRIPT_DIR"
echo ""

# Deploy Web UI
if [ "$DEPLOY_WEB" = true ]; then
    echo "→ Deploying Web UI to mc-manager..."
    lxc file push -r "$SCRIPT_DIR/apps/web/dist/" mc-manager/opt/mc-lxd-manager/apps/web/
    echo "  ✓ Web UI files copied"
fi

# Deploy Server
if [ "$DEPLOY_SERVER" = true ]; then
    echo "→ Deploying Management Server to mc-manager..."
    lxc file push -r "$SCRIPT_DIR/apps/server/dist/" mc-manager/opt/mc-lxd-manager/apps/server/
    echo "  ✓ Server files copied"
fi

# Restart management server if web or server was deployed
if [ "$DEPLOY_WEB" = true ] || [ "$DEPLOY_SERVER" = true ]; then
    echo "→ Restarting management server..."
    lxc exec mc-manager -- systemctl restart mc-manager
    sleep 1
    if lxc exec mc-manager -- systemctl is-active mc-manager > /dev/null 2>&1; then
        echo "  ✓ Management server restarted successfully"
    else
        echo "  ✗ Management server failed to start!"
        lxc exec mc-manager -- journalctl -u mc-manager -n 20 --no-pager
        exit 1
    fi
    echo ""
fi

# Deploy Agent
if [ "$DEPLOY_AGENT" = true ]; then
    echo "→ Deploying Agent to mc-server-1..."
    lxc file push -r "$SCRIPT_DIR/apps/agent/dist/" mc-server-1/opt/mc-agent/dist/
    lxc file push -r "$SCRIPT_DIR/apps/agent/src/" mc-server-1/opt/mc-agent/src/
    echo "  ✓ Agent files copied"

    echo "→ Restarting agent..."
    lxc exec mc-server-1 -- systemctl restart mc-agent
    sleep 1
    if lxc exec mc-server-1 -- systemctl is-active mc-agent > /dev/null 2>&1; then
        echo "  ✓ Agent restarted successfully"
    else
        echo "  ✗ Agent failed to start!"
        lxc exec mc-server-1 -- journalctl -u mc-agent -n 20 --no-pager
        exit 1
    fi
    echo ""
fi

echo "================================================"
echo "Deployment Complete!"
echo "================================================"
echo ""
echo "Web UI: http://192.168.0.170:8585"
echo "API:    http://10.70.48.95:8080/api/servers"
echo ""
echo "Check status:"
echo "  lxc exec mc-manager -- systemctl status mc-manager"
echo "  lxc exec mc-server-1 -- systemctl status mc-agent"
