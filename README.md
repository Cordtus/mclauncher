# MC LXD Manager (Node + TypeScript)

LXD-native Minecraft panel (LAN-only). Single host, no DB, persistent LXD volumes, LXD proxy networking.

**No Docker** - runs natively with Node.js and systemd, shells out to `lxc` commands. Minecraft servers run inside LXD containers with systemd units.

## Quick Deploy (Automated)

On your LXD host, run the automated setup script:

```bash
git clone https://github.com/YOUR_ORG/mc-lxd-manager.git
cd mc-lxd-manager
sudo ./scripts/setup-host.sh
```

This will:
- Install Node.js, LXD, and dependencies
- Initialize LXD (if needed)
- Create the `mc` service user and add to `lxd` group
- Build the application
- Deploy to `/opt/mc-lxd-manager`
- Install systemd service
- Create environment file at `/etc/mc-lxd-manager.env`

Then:
1. Edit `/etc/mc-lxd-manager.env` and set a secure `ADMIN_TOKEN`
2. Start the service: `sudo systemctl enable --now mc-lxd-manager`
3. Access via Caddy or directly at `http://127.0.0.1:8080`

## Manual Install (Development)

```bash
git clone https://github.com/YOUR_ORG/mc-lxd-manager.git
cd mc-lxd-manager
npm install --workspaces   # or pnpm install
npm run build
```

## Run (dev)

```bash
pnpm dev
# open http://127.0.0.1:8080 (backend serves web dist when built)
```

Open another terminal to run the web dev server separately if you like:

```bash
pnpm -C apps/web dev
```

## Run (prod)

```bash
cp .env.example .env
# edit .env and/or systemd env file

pnpm build
HOST=127.0.0.1 PORT=8080 node apps/server/dist/index.js
```

## Manual Deploy with systemd

```bash
# Install prerequisites
sudo apt-get update && sudo apt-get install -y nodejs npm lxd jq curl unzip

# Initialize LXD
sudo lxd init   # accept defaults or customize

# Create service user with lxd group access
sudo useradd -r -s /usr/sbin/nologin mc || true
sudo usermod -aG lxd mc

# Deploy application
sudo mkdir -p /opt/mc-lxd-manager
sudo rsync -a --delete . /opt/mc-lxd-manager/
cd /opt/mc-lxd-manager
sudo npm install --workspaces --omit=dev

# Install systemd service
sudo cp deploy/mc-lxd-manager.service /etc/systemd/system/

# Create and edit environment file
sudo cp .env.example /etc/mc-lxd-manager.env
sudo nano /etc/mc-lxd-manager.env  # Set ADMIN_TOKEN!

# Set ownership and start
sudo chown -R mc:mc /opt/mc-lxd-manager
sudo systemctl daemon-reload
sudo systemctl enable --now mc-lxd-manager
sudo systemctl status mc-lxd-manager
```

## Caddy Reverse Proxy (LAN-only)

See `Caddyfile.example` for configuration. The panel binds to `127.0.0.1:8080` by default, so use Caddy (or nginx) to expose it on your LAN.

Key settings:
- Keep `HOST=127.0.0.1` in env file (never bind to public interface)
- Set `TRUST_PROXY=true` (default) to read client IPs from `X-Forwarded-For`
- Use `ALLOW_CIDRS` to restrict access to your LAN ranges
- Block WAN access at your router/firewall

## Browser Setup

After accessing the web UI, set your admin token once in the browser console:

```js
localStorage.setItem('ADMIN_TOKEN', 'your-hex-token-here');
```

This token will be sent with all admin requests (create, upload, modify, delete).

## Architecture Notes

**No Docker** - this is a native deployment:
- Panel runs as a Node.js systemd service on the host
- Panel shells out to `lxc` CLI to manage containers
- Each Minecraft server runs **inside its own LXD container** with a systemd unit
- Containers are isolated; only exposed via LXD proxy devices (no LAN IP needed in container)

**Storage & Networking:**
- Each server gets an LXD storage volume `minecraft-<name>` mounted at `/opt/minecraft`
- WAN exposure via LXD proxy: `listen:0.0.0.0:<public>` → `connect:127.0.0.1:25565` inside container
- Worlds stored in `/opt/minecraft/worlds/` with symlink to active world at `/opt/minecraft/world`

**Management Features:**
- Mods/plugins: upload .jar files; for modpacks paste Packwiz pack.toml URL
- RCON: send commands directly from the UI
- LuckPerms: one-click install for permissions management
- Backups: LXD snapshot + export to BACKUP_DIR tarball
- Multi-world: upload .zip worlds, switch between them without data loss

## Troubleshooting

Check service status:
```bash
sudo systemctl status mc-lxd-manager
sudo journalctl -u mc-lxd-manager -f
```

Verify `mc` user can access LXD:
```bash
sudo -u mc lxc list
```

If permission denied, ensure `mc` is in `lxd` group and restart the service.
