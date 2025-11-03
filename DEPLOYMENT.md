# Deployment Instructions

## Update Management Container with Latest Changes

Run these commands on the LXD host (192.168.0.170):

### 1. Get Latest Code
```bash
cd ~/repos/mclauncher
git pull
```

### 2. Install Dependencies and Build
```bash
# Install any new dependencies
npm install --workspaces

# Build all apps
npm run build
```

This will build:
- `apps/web/dist/` - Frontend (React UI)
- `apps/server/dist/` - Management backend
- `apps/agent/dist/` - Server control agent

### 3. Deploy to Containers
```bash
sudo ./deploy-updates.sh
```

This script automatically:
- Copies web UI to mc-manager
- Copies server backend to mc-manager
- Restarts mc-manager service
- Copies agent to mc-server-1
- Restarts mc-agent service

### 4. Verify Services
```bash
# Check management server
lxc exec mc-manager -- systemctl status mc-manager

# Check agent
lxc exec mc-server-1 -- systemctl status mc-agent

# View recent logs
lxc exec mc-manager -- journalctl -u mc-manager -n 20
lxc exec mc-server-1 -- journalctl -u mc-agent -n 20
```

### 5. Update Public Domain Configuration

Once you've set up DNS and Caddy, update the server registry:

```bash
# Update via API (from any LAN machine)
curl -X PATCH http://192.168.0.170:8585/api/servers/mc-server-1/config \
  -H "Content-Type: application/json" \
  -d '{"public_domain": "play.yourdomain.com"}'

# Or manually edit the registry file in the container
lxc exec mc-manager -- nano /opt/mc-lxd-manager/servers.json
# Add: "public_domain": "play.yourdomain.com"
lxc exec mc-manager -- systemctl restart mc-manager
```

### 6. Access the Updated UI

Open your browser to:
- **LAN**: http://192.168.0.170:8585
- **Public** (after Caddy setup): https://minecraft.yourdomain.com

You should now see:
- ✅ "Getting Started" button in header
- ✅ Connection info with copy buttons
- ✅ Hover tooltips on upload buttons
- ✅ Player count (once Minecraft server is running)

## Quick Deployment (Future Updates)

For future code updates:

```bash
cd ~/repos/mclauncher && \
git pull && \
npm run build && \
sudo ./deploy-updates.sh
```

## Troubleshooting

### Build Fails
```bash
# Clean and reinstall dependencies
rm -rf node_modules apps/*/node_modules
npm install --workspaces
npm run build
```

### Service Won't Start
```bash
# Check logs for errors
lxc exec mc-manager -- journalctl -u mc-manager -n 50 --no-pager

# Common issues:
# - Missing dependencies: Re-run npm install in container
# - Port already in use: Check for conflicting processes
# - Permission errors: Check file ownership (mcmanager:mcmanager)
```

### UI Not Updating
```bash
# Hard refresh browser (Ctrl+Shift+R or Cmd+Shift+R)
# Or clear browser cache

# Verify files were copied
lxc exec mc-manager -- ls -la /opt/mc-lxd-manager/apps/web/dist/
```

## Manual Deployment (if script fails)

If `deploy-updates.sh` doesn't work:

```bash
# Deploy to management container
lxc file push -r apps/web/dist/ mc-manager/opt/mc-lxd-manager/apps/web/
lxc file push -r apps/server/dist/ mc-manager/opt/mc-lxd-manager/apps/server/
lxc exec mc-manager -- systemctl restart mc-manager

# Deploy to server container
lxc file push -r apps/agent/dist/ mc-server-1/opt/mc-agent/dist/
lxc file push -r apps/agent/src/ mc-server-1/opt/mc-agent/src/
lxc exec mc-server-1 -- systemctl restart mc-agent
```
