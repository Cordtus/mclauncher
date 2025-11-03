# Caddy and Network Configuration Guide

This guide covers configuring Caddy, LXD proxy devices, and firewall rules for both LAN and public access.

## Current Setup

- **LXD Host**: 192.168.0.170
- **Caddy Server**: 10.70.48.100
- **Management Container**: mc-manager (10.70.48.95:8080)
- **Minecraft Server Container**: mc-server-1 (10.70.48.204:25565)

## 1. LXD Proxy Devices

### Management UI (Already Configured)
```bash
# Already exists - verifies current config
lxc config device show mc-manager
# Shows: listen: tcp:0.0.0.0:8585 → connect: tcp:127.0.0.1:8080
```

### Minecraft Server Public Port
```bash
# Add proxy device for Minecraft server
lxc config device add mc-server-1 minecraft-proxy proxy \
  listen=tcp:0.0.0.0:25565 \
  connect=tcp:127.0.0.1:25565

# Verify
lxc config device show mc-server-1
```

This exposes Minecraft on the **host's** port 25565.

## 2. Caddy Configuration

### For Web UI (HTTP Reverse Proxy)

Add this to your Caddyfile:

```caddyfile
# Management Web UI
minecraft.yourdomain.com {
    reverse_proxy http://192.168.0.170:8585

    # Optional: Add basic auth if you want extra security
    # basicauth {
    #     username $2a$14$hashedpassword
    # }
}
```

### For Minecraft Server (TCP Proxy)

**Minecraft requires TCP proxying, not HTTP.** You have two options:

#### Option A: Direct DNS to Host (Recommended)

Point your domain's A record directly to your public IP, and configure port forwarding:

```bash
# On your router/firewall
# Forward public:25565 → 192.168.0.170:25565 (LXD host)
```

Then create a subdomain:
```
play.yourdomain.com → A record → your.public.ip
```

Players connect to: `play.yourdomain.com:25565`

#### Option B: Caddy Layer4 Plugin (More Complex)

If you want Caddy to handle Minecraft TCP traffic, you need the layer4 module.

1. **Install Caddy with layer4:**
```bash
# Download custom build with layer4
caddy version  # Check if layer4 is already included
# If not, rebuild with: xcaddy build --with github.com/mholt/caddy-l4
```

2. **Add to Caddyfile:**
```caddyfile
{
    layer4 {
        # Minecraft TCP proxy
        :25565 {
            route {
                proxy {
                    upstream 192.168.0.170:25565
                }
            }
        }
    }
}

# HTTP sites remain the same
minecraft.yourdomain.com {
    reverse_proxy http://192.168.0.170:8585
}
```

**Note**: Layer4 requires Caddy to bind to port 25565, so your Caddy server would need to be on your public IP or handle port forwarding.

## 3. Firewall Rules (Host: 192.168.0.170)

### For LAN Access (Local Network)

```bash
# Allow from LAN to management UI
sudo ufw allow from 192.168.0.0/16 to any port 8585 comment "MC Manager UI - LAN"

# Allow from LAN to Minecraft
sudo ufw allow from 192.168.0.0/16 to any port 25565 comment "Minecraft Server - LAN"

# Verify rules
sudo ufw status numbered
```

### For Public Access via Caddy

```bash
# Allow Caddy server to reach management UI
sudo ufw allow from 10.70.48.100 to any port 8585 comment "Caddy to MC Manager"

# Allow Caddy server (or public) to reach Minecraft
sudo ufw allow from 10.70.48.100 to any port 25565 comment "Caddy to Minecraft"

# OR if using router port forwarding directly:
sudo ufw allow 25565/tcp comment "Minecraft Public"
```

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

**Recommended Setup:**

1. **LXD Proxy**: Host:25565 → mc-server-1:25565
2. **Router**: Public:25565 → 192.168.0.170:25565
3. **Caddy**: HTTPS reverse proxy for web UI only
4. **DNS**:
   - `minecraft.yourdomain.com` → Caddy IP (web UI)
   - `play.yourdomain.com` → Public IP (Minecraft)
5. **Firewall**: Allow LAN (192.168.0.0/16) + Caddy IP to both ports

This gives you:
- **LAN users**: Connect to `192.168.0.170:25565` or web UI at `:8585`
- **Public users**: Connect to `play.yourdomain.com:25565` or web UI at `https://minecraft.yourdomain.com`
