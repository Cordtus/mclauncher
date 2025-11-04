# Manual Deployment Guide

Quick reference for deploying updates to your Minecraft server management system.

## One-Line Deployment

On the LXD host machine:

```bash
cd ~/repos/mclauncher && git pull && npm install --workspaces && npm run build && ./deploy.sh --all
```

## Step-by-Step

### 1. Pull Latest Code
```bash
cd ~/repos/mclauncher
git pull
```

### 2. Install Dependencies (if package.json changed)
```bash
npm install --workspaces
```

### 3. Build
```bash
npm run build
```

This builds:
- `apps/web/dist/` - Frontend UI
- `apps/server/dist/` - Management backend
- `apps/agent/dist/` - Server control agent

### 4. Deploy to Containers
```bash
./deploy.sh --all
```

Or deploy individually:
```bash
./deploy.sh --web      # Web UI only
./deploy.sh --server   # Management backend only
./deploy.sh --agent    # Server agent only
```

### 5. Verify

Check that services restarted:
```bash
lxc exec mc-manager -- systemctl status mc-manager
lxc exec mc-server-1 -- systemctl status mc-agent
```

### 6. Test

Open in browser: `http://192.168.0.170:8585`

## Troubleshooting

**Build fails:**
```bash
rm -rf node_modules apps/*/node_modules
npm install --workspaces
npm run build
```

**Service won't start:**
```bash
lxc exec mc-manager -- journalctl -u mc-manager -n 50
```

**UI not updating:**
- Hard refresh browser (Ctrl+Shift+R or Cmd+Shift+R)
- Check files copied: `lxc exec mc-manager -- ls -la /opt/mc-lxd-manager/apps/web/dist/`

## What deploy.sh Does

1. Stops services in containers
2. Copies built files to containers
3. Sets correct permissions
4. Restarts services
5. Shows status

That's it!
