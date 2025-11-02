# Deployment

## Container-Based Architecture

All components run inside LXD containers. Nothing runs directly on the host except LXD itself.

## Prerequisites

LXD must be installed and initialized on the host:

```bash
sudo snap install lxd
sudo lxd init  # accept defaults
```

## Deployment Steps

### 1. Clone Repository on Host

```bash
git clone https://github.com/Cordtus/mclauncher.git
cd mclauncher
```

### 2. Create Management Container

```bash
sudo ./apps/scripts/create-management-container.sh [container_name] [public_port]
```

Defaults:
- container_name: `mc-manager`
- public_port: `8080`

Example:
```bash
sudo ./apps/scripts/create-management-container.sh mc-manager 8080
```

Save the admin token printed at the end!

### 3. Create Minecraft Servers

```bash
sudo ./apps/scripts/create-mc-server.sh NAME EDITION VERSION MEMORY CPU PORT
```

Example (Paper server with 4GB RAM):
```bash
sudo ./apps/scripts/create-mc-server.sh mc-survival paper 1.21.1 4096 2 25565
```

Example (Vanilla server with 2GB RAM):
```bash
sudo ./apps/scripts/create-mc-server.sh mc-creative vanilla 1.21.1 2048 1 25566
```

Servers are automatically registered with the management backend.

### 4. Access Web UI

1. Navigate to `http://<host-ip>:8080`
2. Set admin token in browser console:
   ```js
   localStorage.setItem('ADMIN_TOKEN', 'your-token-from-step-2');
   ```
3. Refresh page

## Architecture Details

**Management Container (`mc-manager`):**
- Runs Node.js backend (API gateway) on port 8080
- Serves React frontend (static files)
- Maintains server registry in JSON file
- Proxies requests to server control agents

**Server Containers (`mc-server-*`):**
- Runs Minecraft server on port 25565
- Runs control agent on port 9090 (internal only)
- Agent provides HTTP API for management operations

**Networking:**
- Management UI exposed on host via LXD proxy
- Minecraft ports exposed on host via LXD proxy
- Control agents accessible only within LXD network

## Updates

To update the management container:

```bash
cd mclauncher
git pull
sudo ./apps/scripts/create-management-container.sh mc-manager 8080
# This will recreate the container with latest code
```

To update a server's control agent:

```bash
cd mclauncher
git pull

# Copy updated agent to server
tar czf /tmp/agent.tar.gz -C apps/agent .
lxc file push /tmp/agent.tar.gz mc-server-1/tmp/
lxc exec mc-server-1 -- bash -c "
  cd /opt/mc-agent
  tar xzf /tmp/agent.tar.gz
  npm install --omit=dev
  npm run build
  systemctl restart mc-agent
"
```

## Firewall

If using a firewall on the host, allow ports:
- 8080 (or your chosen management port)
- 25565+ (one per Minecraft server)

Example with ufw:
```bash
sudo ufw allow 8080/tcp
sudo ufw allow 25565/tcp
sudo ufw allow 25566/tcp
# etc.
```

## Security Notes

- Management backend uses CIDR filtering (default: 192.168.0.0/16, 10.0.0.0/8)
- Admin token required for write operations
- Control agents not exposed outside LXD network
- Consider placing management UI behind reverse proxy (Caddy/nginx) for SSL

## Backups

Backup entire server container:
```bash
lxc snapshot mc-server-1 backup-$(date +%Y%m%d)
lxc publish mc-server-1/backup-$(date +%Y%m%d) --alias=mc-server-1-backup
```

Or use the built-in backup feature in the web UI (creates tarball of /opt/minecraft).
