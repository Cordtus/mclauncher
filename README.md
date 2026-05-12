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
- Configurable admin access with token and passkey authentication

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
2. Open **Admin Access** in the header
3. Paste the admin token printed by setup
4. Optional: register a passkey from the same dialog when the gateway is served over HTTPS or localhost. The admin token is required to bootstrap the first passkey.

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
- Admin token or passkey session required for server inventory, settings, logs, mod management, and all write operations
- Passkeys use WebAuthn and require a secure browser context: HTTPS or localhost
- Passkey login requires user verification by default (`PASSKEY_USER_VERIFICATION=required`)
- If `PASSKEY_RP_ID` is configured for a public domain, also set `PASSKEY_ORIGIN` to the exact HTTPS origin
- If the gateway is exposed behind Caddy and CIDR filtering should use the browser client IP, set `TRUST_PROXY=true` and restrict `TRUST_PROXY_CIDRS` to the proxy network
- Control agents (port 9090) are NOT exposed outside containers and require the per-server `AGENT_TOKEN` stored in `/opt/mc-lxd-manager/servers.json` and `/etc/mc-agent.env`
- Keep `/opt/mc-lxd-manager/.env`, `/opt/mc-lxd-manager/servers.json`, and `/opt/mc-lxd-manager/passkeys.json` owner-readable only (`0600`)
- Keep `/opt/minecraft/server.properties` owner-readable only (`0600`) because it contains the RCON password
- Bind Minecraft to `127.0.0.1` inside each server container and publish player traffic through the LXD proxy; this keeps RCON and direct container ports off the shared LXD subnet

## Networking

- Management UI: `host:8080` → `mc-manager:8080`
- Minecraft servers: `host:<proxy-port>` → `mc-server-N:25565`
- Control agents: Internal only (`mc-server-N:9090`)

For the cleanest player experience, expose Minecraft on the default Java Edition
port, TCP `25565`. Players can then join with only the DNS name, for example
`mc.basementnodes.ca`, without appending a port. If you use any other external
port, the admin panel will show and copy the required `host:port` address.

Recommended public setup:

1. DNS: point `mc.basementnodes.ca` to the WAN IP.
2. Router: forward WAN TCP `25565` to the LXD host proxy port for the server.
3. LXD proxy: forward the host proxy port to the Minecraft container on TCP `25565`.
4. Manager registry: set Public Domain to `mc.basementnodes.ca`, WAN Port to `25565`, and Host Proxy Port to the actual LXD host proxy port.

On the current `nodev2` deployment, the reachable Minecraft LXD proxy is host
TCP `34567`, so the router rule is WAN TCP `25565` →
`192.168.0.170:34567`. Players still enter only `mc.basementnodes.ca`.

Do not expose the admin gateway to WAN. Keep the admin hostname restricted to
LAN ranges and share only the Minecraft join address with players.

## Troubleshooting

**Server not appearing in UI:**
- Check agent is running: `lxc exec mc-server-1 -- systemctl status mc-agent`
- Check registration: `lxc exec mc-manager -- cat /opt/mc-lxd-manager/servers.json`
- Check network: `lxc list` (verify container IPs)

**Cannot upload files:**
- Verify Admin Access has a valid token or active passkey session
- Check browser console for errors

**Minecraft won't start:**
- Check logs: `lxc exec mc-server-1 -- journalctl -u minecraft -n 100`
- Verify EULA: `lxc exec mc-server-1 -- cat /opt/minecraft/eula.txt`
- Check memory limits: `lxc info mc-server-1`
