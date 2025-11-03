# Caddy and Network Configuration Guide

This guide covers configuring Caddy, LXD proxy devices, and firewall rules for both LAN and public access.

## Current Setup

- **LXD Host**: 192.168.0.170
- **LXD Bridge Network**: 10.70.48.0/24
- **Caddy Server**: 10.70.48.100 (on LXD bridge - can reach containers directly!)
- **Management Container**: mc-manager (10.70.48.95:8080)
- **Minecraft Server Container**: mc-server-1 (10.70.48.204:25565)

## 1. LXD Proxy Devices (For LAN Access Only)

**Note**: Caddy doesn't need these since it's on the same network as the containers.

### Management UI - LAN Access (Optional)
```bash
# Only needed if you want LAN users to access via host IP (192.168.0.170:8585)
# Already exists:
lxc config device show mc-manager
# Shows: listen: tcp:0.0.0.0:8585 → connect: tcp:127.0.0.1:8080
```

### Minecraft Server - LAN Access (Optional)
```bash
# Only needed if you want LAN users to connect via host IP (192.168.0.170:25565)
lxc config device add mc-server-1 minecraft-proxy proxy \
  listen=tcp:0.0.0.0:25565 \
  connect=tcp:127.0.0.1:25565

# Verify
lxc config device show mc-server-1
```

## 2. Caddy Configuration

Since Caddy is on the LXD bridge (10.70.48.100), it can reach containers directly!

### For Web UI (HTTP Reverse Proxy)

Add this to your Caddyfile:

```caddyfile
# Management Web UI
minecraft.yourdomain.com {
    # Direct connection to management container
    reverse_proxy http://10.70.48.95:8080

    # Optional: Add basic auth if you want extra security
    # basicauth {
    #     username $2a$14$hashedpassword
    # }
}
```

### For Minecraft Server (TCP Proxy)

**Minecraft requires TCP proxying, not HTTP.** You need Caddy's layer4 module.

#### Install Caddy with Layer4
```bash
# On your Caddy container/server
xcaddy build --with github.com/mholt/caddy-l4
```

#### Add to Your Caddyfile
```caddyfile
{
    layer4 {
        # Minecraft TCP proxy - direct to container!
        :25565 {
            route {
                proxy {
                    upstream 10.70.48.204:25565
                }
            }
        }
    }
}

# HTTP sites
minecraft.yourdomain.com {
    reverse_proxy http://10.70.48.95:8080
}
```

#### Alternative: SRV Record (No Layer4 Needed)

If you don't want to use layer4, use DNS SRV records to point directly to the container:

```
_minecraft._tcp.play.yourdomain.com    SRV    0 5 25565 10.70.48.204
```

Players connect to `play.yourdomain.com` (Minecraft automatically queries SRV record).

## 3. Firewall Rules

**Good news!** Since Caddy is on the LXD bridge, it can already reach the containers. No special firewall rules needed on the host for Caddy.

### LAN Access via Host IP (Optional)

Only if you want LAN users to connect via `192.168.0.170`:

```bash
# Allow from LAN to management UI
sudo ufw allow from 192.168.0.0/16 to any port 8585 comment "MC Manager UI - LAN"

# Allow from LAN to Minecraft (if using host proxy)
sudo ufw allow from 192.168.0.0/16 to any port 25565 comment "Minecraft Server - LAN"
```

### Public Access

If you're using layer4 in Caddy to proxy Minecraft, you'll handle this at your router/public firewall level (forward port 25565 to Caddy container).

### Verify Firewall Status
```bash
sudo ufw status verbose
```

## 4. DNS Configuration

### A Records
```
minecraft.yourdomain.com    → 10.70.48.100 (Caddy IP for web UI)
play.yourdomain.com         → your.public.ip (for direct Minecraft access)
```

### SRV Record (Optional - allows players to connect without port)
```
_minecraft._tcp.play.yourdomain.com    SRV    0 5 25565 play.yourdomain.com.
```

With SRV record, players can connect to just `play.yourdomain.com` (no :25565 needed).

## 5. Router/Public Firewall

If you want public access to Minecraft:

```bash
# Port forwarding on your internet router
Public Port 25565 → 192.168.0.170:25565
```

For the management UI, Caddy handles this via HTTPS (ports 80/443).

## 6. Testing Access

### LAN Access
```bash
# Test management UI from LAN
curl http://192.168.0.170:8585/healthz

# Test Minecraft (requires mc client)
# In Minecraft: Add Server → 192.168.0.170:25565
```

### Public Access (after DNS propagation)
```bash
# Test web UI
curl https://minecraft.yourdomain.com/healthz

# Test Minecraft
# In Minecraft: Add Server → play.yourdomain.com:25565
```

## 7. Update Server Registry with Public Domain

Via API or in the container:

```bash
# From LAN machine
curl -X PATCH http://192.168.0.170:8585/api/servers/mc-server-1/config \
  -H "Content-Type: application/json" \
  -d '{"public_domain": "play.yourdomain.com"}'
```

Or directly in container:
```bash
lxc exec mc-manager -- bash -c 'cat > /tmp/update.sh << EOF
#!/bin/bash
SERVER_JSON="/opt/mc-lxd-manager/servers.json"
# Use jq or manual edit to add "public_domain": "play.yourdomain.com"
EOF'
```

## Summary

**Simplified Setup (Caddy on LXD Bridge):**

1. **Caddy Config**:
   - Web UI: `reverse_proxy http://10.70.48.95:8080`
   - Minecraft: Layer4 proxy to `10.70.48.204:25565` OR use SRV record

2. **DNS**:
   - `minecraft.yourdomain.com` → Your public IP (Caddy handles HTTPS)
   - `play.yourdomain.com` → SRV record to `10.70.48.204:25565`
     OR Layer4 proxy on Caddy

3. **No Special Firewall Rules**: Caddy is already on the same network as containers!

4. **Optional LAN Proxy**: Only if you want `192.168.0.170:8585` access

This gives you:
- **LAN users**:
  - Web UI: `http://192.168.0.170:8585` (via LXD proxy) or `http://10.70.48.95:8080` (direct)
  - Minecraft: `10.70.48.204:25565` (direct to container)

- **Public users**:
  - Web UI: `https://minecraft.yourdomain.com` (via Caddy)
  - Minecraft: `play.yourdomain.com` (via Caddy layer4 or SRV record)
