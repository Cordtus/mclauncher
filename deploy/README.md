# Deployment

## Quick Setup (Automated)

From the repository root on your LXD host:

```bash
sudo ../scripts/setup-host.sh
```

This handles all steps below automatically.

## Manual Systemd Service Deployment

1. **Prerequisites**: Install Node.js, LXD, and dependencies
   ```bash
   sudo apt-get update && sudo apt-get install -y nodejs npm lxd jq curl unzip rsync
   ```

2. **Initialize LXD** (if not already done):
   ```bash
   sudo lxd init  # accept defaults or customize
   ```

3. **Create service user with lxd group**:
   ```bash
   sudo useradd -r -s /usr/sbin/nologin mc || true
   sudo usermod -aG lxd mc
   ```

4. **Create environment file**:
   ```bash
   sudo cp ../.env.example /etc/mc-lxd-manager.env
   sudo nano /etc/mc-lxd-manager.env  # IMPORTANT: Set ADMIN_TOKEN!
   ```

5. **Build and deploy**:
   ```bash
   cd ..
   npm install --workspaces
   npm run build
   sudo mkdir -p /opt/mc-lxd-manager
   sudo rsync -a --delete . /opt/mc-lxd-manager/
   cd /opt/mc-lxd-manager
   sudo npm install --workspaces --omit=dev
   ```

6. **Install and start service**:
   ```bash
   sudo cp deploy/mc-lxd-manager.service /etc/systemd/system/
   sudo chown -R mc:mc /opt/mc-lxd-manager
   sudo systemctl daemon-reload
   sudo systemctl enable --now mc-lxd-manager
   ```

7. **Verify**:
   ```bash
   sudo systemctl status mc-lxd-manager
   sudo journalctl -u mc-lxd-manager -f
   ```

8. **Test lxd access**:
   ```bash
   sudo -u mc lxc list  # should work without permission errors
   ```

## Caddy Reverse Proxy (LAN-only)

See `Caddyfile.example` in project root for LAN-only access configuration.

The service binds to `127.0.0.1:8080` by default. Use Caddy or nginx to expose it on your LAN while keeping `ALLOW_CIDRS` and firewall rules to restrict access.

## Important Notes

- The `mc` user MUST be in the `lxd` group (added via `SupplementaryGroups=lxd` in systemd unit)
- This allows the service to run `lxc` commands to manage containers
- NO Docker is used - this is a native Node.js deployment
- Minecraft servers run inside LXD containers, not Docker containers
