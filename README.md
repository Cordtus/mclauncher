# MC LXD Manager

Web-based management panel for Minecraft servers running in LXD containers.

## Architecture

**Container-based deployment:**
- **Management Container** - Runs web UI and API gateway (port 8080)
- **Server Containers** - Each runs Minecraft + control agent (port 9090)
- **Communication** - Management UI talks to control agents via HTTP

No Docker, no host services. Everything runs in LXD containers.

## Features

- Start/stop/restart servers
- Real-time log viewing
- Upload plugins and mods (drag & drop)
- Upload and switch between worlds
- Edit server.properties in browser
- RCON command execution
- Packwiz modpack sync
- One-click LuckPerms installation
- Snapshot backups
- LAN-only access with token authentication

## Quick Start

On your LXD host:

```bash
git clone https://github.com/Cordtus/mclauncher.git
cd mclauncher
```

### 1. Create Management Container

```bash
sudo ./apps/scripts/create-management-container.sh mc-manager 8080
```

This creates the management container and outputs an admin token. Save this token!

### 2. Create Minecraft Server(s)

```bash
sudo ./apps/scripts/create-mc-server.sh mc-server-1 paper 1.21.1 4096 2 25565
```

Parameters:
- Container name
- Edition (paper/vanilla)
- Minecraft version
- Memory (MB)
- CPU cores
- Public port
- Optional: RCON port (default: 25575)
- Optional: RCON password (auto-generated if omitted)
- Optional: Manager container name (default: mc-manager)

### 3. Access Web UI

1. Navigate to `http://<host-ip>:8080`
2. Open browser console and set your token:
   ```js
   localStorage.setItem('ADMIN_TOKEN', 'your-token-here');
   ```
3. Refresh the page

## Management

### View Container Status

```bash
# Management container
lxc exec mc-manager -- systemctl status mc-manager
lxc exec mc-manager -- journalctl -u mc-manager -f

# Minecraft server
lxc exec mc-server-1 -- systemctl status minecraft
lxc exec mc-server-1 -- systemctl status mc-agent
lxc exec mc-server-1 -- journalctl -u minecraft -f
```

### Stop/Start Containers

```bash
lxc stop mc-server-1
lxc start mc-server-1
```

### Delete Server

```bash
# Unregister from management UI first (or via API)
curl -X DELETE http://localhost:8080/api/servers/mc-server-1/unregister \
  -H "Authorization: Bearer YOUR_TOKEN"

# Then delete container
lxc delete mc-server-1 --force
```

## Development

```bash
npm install --workspaces
npm run build
```

### Project Structure

```
apps/
├── agent/          # Control agent (runs in each MC server container)
├── server/         # Management backend (API gateway)
├── web/            # React frontend
└── scripts/        # Container creation scripts
```

## Security

- Management backend binds to 0.0.0.0:8080 inside container
- LXD proxy exposes port 8080 on host
- CIDR filtering restricts access to LAN ranges
- Admin token required for write operations
- Control agents (port 9090) are NOT exposed outside containers

## Networking

- Management UI: `host:8080` → `mc-manager:8080`
- Minecraft servers: `host:25565+` → `mc-server-N:25565`
- Control agents: Internal only (`mc-server-N:9090`)

## Troubleshooting

**Server not appearing in UI:**
- Check agent is running: `lxc exec mc-server-1 -- systemctl status mc-agent`
- Check registration: `lxc exec mc-manager -- cat /opt/mc-lxd-manager/servers.json`
- Check network: `lxc list` (verify container IPs)

**Cannot upload files:**
- Verify admin token is set in browser localStorage
- Check browser console for errors

**Minecraft won't start:**
- Check logs: `lxc exec mc-server-1 -- journalctl -u minecraft -n 100`
- Verify EULA: `lxc exec mc-server-1 -- cat /opt/minecraft/eula.txt`
- Check memory limits: `lxc info mc-server-1`
