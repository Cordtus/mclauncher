# MC LXD Manager

Web-based management panel for Minecraft servers running in LXD containers with multi-profile support.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Ubuntu Host (192.168.0.170)                                            │
│  └─ UFW enabled                                                         │
│  └─ LXD with bridge device (lxdbr0)                                     │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  LXD Bridge Network (10.70.48.x)                                    ││
│  │                                                                     ││
│  │  ┌──────────────────┐    ┌──────────────────┐                       ││
│  │  │  Caddy Container │    │  mc-manager      │                       ││
│  │  │  10.70.48.x      │───▶│  10.70.48.x:8080 │                       ││
│  │  │  (reverse proxy) │    │  (web UI + API)  │                       ││
│  │  └──────────────────┘    └────────┬─────────┘                       ││
│  │                                   │ HTTP (internal)                 ││
│  │                         ┌─────────▼─────────┐                       ││
│  │                         │  mc-server-1      │                       ││
│  │                         │  10.70.48.x:9090  │ (control agent)       ││
│  │                         │  :25565           │ (minecraft)           ││
│  │                         │                   │                       ││
│  │                         │  /profiles/       │                       ││
│  │                         │  ├── paper/       │                       ││
│  │                         │  ├── fabric/      │                       ││
│  │                         │  ├── forge/       │                       ││
│  │                         │  └── vanilla/     │                       ││
│  │                         └───────────────────┘                       ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

**Key Points:**
- All containers on same LXD bridge - no proxy devices needed
- Caddy handles reverse proxy and external access
- UFW only needs to allow Caddy's external ports
- Control agents (9090) never exposed externally

## Features

### Server Management
- Start/stop/restart servers with real-time status
- Upload plugins, mods, and worlds (drag & drop)
- Edit server.properties in browser
- Real-time console log viewing
- RCON command execution
- Snapshot backups

### Multi-Profile System
Switch between server types instantly without creating new containers:

| Profile | Description | Supports |
|---------|-------------|----------|
| **Paper** | High-performance Bukkit fork | Plugins (.jar) |
| **Fabric** | Lightweight mod loader | Mods (Fabric API) |
| **Forge** | Traditional mod platform | Mods (Forge) |
| **Vanilla** | Pure Minecraft | - |

- **Shared data**: Worlds, player data, and settings persist across profiles
- **Instant switching**: ~10 seconds (just a server restart)
- **Isolated content**: Each profile keeps its own mods/plugins folder

### Mod Management
- Browse and install mods/plugins from Modrinth
- Automatic dependency resolution
- Export modpacks for players (.mrpack format)
- Client modpack download page for easy player setup

## Prerequisites

- Ubuntu 22.04+ host with LXD installed and initialized
- LXD bridge network configured (e.g., `lxdbr0` on `10.70.48.0/24`)
- Caddy container for reverse proxy (recommended)
- UFW configured on host

### LXD Bridge Setup

If not already configured:

```bash
# Initialize LXD if needed
lxd init

# Verify bridge network
lxc network list
lxc network show lxdbr0
```

Example bridge config:
```yaml
config:
  ipv4.address: 10.70.48.1/24
  ipv4.nat: "true"
  ipv6.address: none
```

## Installation

### Step 1: Clone Repository

```bash
git clone https://github.com/Cordtus/mclauncher.git
cd mclauncher
```

### Step 2: Create Management Container

```bash
sudo ./apps/scripts/create-management-container.sh mc-manager
```

This creates the management container and outputs:
- Container IP (e.g., `10.70.48.x`)
- Admin token (save this!)

**Note:** No proxy device is added - traffic routes through Caddy on the bridge.

### Step 3: Configure Caddy

Add to your Caddy container's Caddyfile:

```caddy
# MC Manager Panel (LAN only)
mc.local:80 {
    @lan {
        remote_ip 192.168.0.0/16
        remote_ip 10.0.0.0/8
    }
    handle @lan {
        reverse_proxy 10.70.48.X:8080 {
            header_up X-Forwarded-For {remote}
            header_up X-Real-IP {remote}
        }
    }
    handle {
        respond "Access denied" 403
    }
}
```

Replace `10.70.48.X` with your mc-manager container IP.

### Step 4: Configure UFW on Host

```bash
# Allow HTTP/HTTPS from LAN to host (for Caddy)
sudo ufw allow from 192.168.0.0/24 to any port 80
sudo ufw allow from 192.168.0.0/24 to any port 443

# Allow Minecraft ports (adjust range as needed)
sudo ufw allow 25565:25600/tcp
```

### Step 5: Create Minecraft Server(s)

```bash
sudo ./apps/scripts/create-mc-server.sh mc-server-1 paper 1.21.3 4096 2 25565
```

Parameters:
| Position | Parameter | Example | Description |
|----------|-----------|---------|-------------|
| 1 | name | mc-server-1 | Container name |
| 2 | edition | paper | Initial profile (paper/fabric/forge/vanilla) |
| 3 | version | 1.21.3 | Minecraft version |
| 4 | memory | 4096 | RAM in MB |
| 5 | cpu | 2 | CPU cores |
| 6 | port | 25565 | Minecraft port |
| 7 | rcon_port | 25575 | RCON port (optional) |
| 8 | rcon_pass | - | RCON password (auto-generated) |
| 9 | manager | mc-manager | Manager container name |

### Step 6: Access Web UI

1. Navigate to `http://mc.local` (or your configured domain)
2. Open browser console (F12) and set token:
   ```js
   localStorage.setItem('ADMIN_TOKEN', 'your-token-here');
   ```
3. Refresh the page

## Using Server Profiles

### Switch Profile via UI

1. Click **Server Profiles** button on any server
2. Click a profile card to switch (or install if not set up)
3. Server restarts automatically with new profile

### Switch Profile via API

```bash
# List profiles
curl http://mc-manager-ip:8080/api/servers/mc-server-1/profiles

# Switch to Fabric
curl -X POST http://mc-manager-ip:8080/api/servers/mc-server-1/profiles/fabric/switch \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Profile Directory Structure

Inside each Minecraft container:
```
/opt/minecraft/
├── profiles/
│   ├── paper/
│   │   ├── server.jar
│   │   ├── plugins/
│   │   └── paper.yml
│   ├── fabric/
│   │   ├── server.jar
│   │   ├── mods/
│   │   └── .fabric/
│   ├── forge/
│   │   ├── server.jar
│   │   ├── mods/
│   │   └── libraries/
│   └── vanilla/
│       └── server.jar
├── world/              # Shared across profiles
├── world_nether/
├── world_the_end/
├── server.properties   # Shared
├── ops.json           # Shared
├── whitelist.json     # Shared
└── [active symlinks]  # Points to current profile
```

## Sharing Modpacks with Players

For modded servers (Fabric/Forge), players need matching mods:

1. Go to **Server Settings** → **Mods** tab
2. Click **Export Modpack**
3. Share the public URL with players
4. Players download .mrpack file and import into [Prism Launcher](https://prismlauncher.org/)

## Management Commands

### Container Status

```bash
# Management container
lxc exec mc-manager -- systemctl status mc-manager
lxc exec mc-manager -- journalctl -u mc-manager -f

# Minecraft server
lxc exec mc-server-1 -- systemctl status minecraft
lxc exec mc-server-1 -- systemctl status mc-agent
lxc exec mc-server-1 -- journalctl -u minecraft -f
```

### List Containers

```bash
lxc list
```

### Stop/Start

```bash
lxc stop mc-server-1
lxc start mc-server-1
```

### Delete Server

```bash
# Unregister first
curl -X DELETE http://mc-manager-ip:8080/api/servers/mc-server-1/unregister \
  -H "Authorization: Bearer YOUR_TOKEN"

# Then delete container
lxc delete mc-server-1 --force
```

## Network Reference

Your setup:
```
Internet → OpenWRT Router → 192.168.0.170 (Ubuntu/LXD Host)
                                    │
                              UFW Firewall
                                    │
                              LXD Bridge
                             (10.70.48.0/24)
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
              Caddy:80        mc-manager:8080  mc-server:25565
              (external)      (internal)       (forwarded)
```

**Traffic flow:**
1. Player connects to `your-domain:25565`
2. OpenWRT forwards to `192.168.0.170:25565`
3. UFW allows port 25565
4. LXD routes to `10.70.48.x:25565` (mc-server container)

**Admin panel flow:**
1. Admin opens `mc.local` in browser
2. Router resolves to `192.168.0.170`
3. Caddy container receives request
4. Caddy proxies to `mc-manager:8080`

## Troubleshooting

### Server not appearing in UI
```bash
# Check agent running
lxc exec mc-server-1 -- systemctl status mc-agent

# Check registration
lxc exec mc-manager -- cat /opt/mc-lxd-manager/servers.json

# Check network connectivity
lxc exec mc-manager -- curl http://10.70.48.X:9090/status
```

### Profile switch fails
```bash
# Check profile manager logs
lxc exec mc-server-1 -- journalctl -u mc-agent -n 50

# Verify profiles directory
lxc exec mc-server-1 -- ls -la /opt/minecraft/profiles/
```

### Cannot upload files
- Verify admin token is set in browser localStorage
- Check browser console (F12) for errors
- Verify request headers include Authorization

### Minecraft won't start
```bash
# Check logs
lxc exec mc-server-1 -- journalctl -u minecraft -n 100

# Verify EULA
lxc exec mc-server-1 -- cat /opt/minecraft/eula.txt

# Check Java
lxc exec mc-server-1 -- java -version

# Check memory limits
lxc info mc-server-1
```

### Connection refused from outside LAN
- Check UFW: `sudo ufw status`
- Check OpenWRT port forwarding
- Verify Minecraft port is correct in container

## Development

```bash
npm install --workspaces
npm run build
```

### Project Structure

```
apps/
├── agent/          # Control agent (runs in each MC server container)
│   ├── managers/   # ProfileManager, VersionManager
│   └── downloaders/# Paper, Fabric, Forge, Vanilla downloaders
├── server/         # Management backend (API gateway)
│   └── services/   # Modrinth API, modpack export
├── web/            # React frontend
│   └── components/ # ProfileSwitcher, ModBrowser, etc.
└── scripts/        # Container creation scripts
```

## Security Notes

- Management backend only accessible via Caddy (LAN restriction)
- Admin token required for all write operations
- Control agents (port 9090) never exposed externally
- RCON passwords auto-generated and stored securely
- No Docker, no host services - everything containerized
