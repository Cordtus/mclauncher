# Caddy Rebuild Guide - Adding Layer4 Plugin

This guide helps you rebuild Caddy with the layer4 plugin while maintaining all your existing plugins.

## Step 1: Inspect Current Caddy Build

On your Caddy server (10.70.48.100):

```bash
# Check Caddy version and list all modules
caddy version

# Get detailed build information
caddy list-modules

# Save current module list to file
caddy list-modules > ~/caddy-current-modules.txt

# Check if layer4 is already included
caddy list-modules | grep layer4
```

The output will show something like:
```
v2.7.6 h1:w0NymbG2m9PcvKWsrXO6EEkY9Ru4FJK8uQbYcev1p3A=

Module name                           Version
dns.providers.cloudflare              v0.0.0-00010101000000-000000000000
http.handlers.cache                   v0.0.0-00010101000000-000000000000
...
```

## Step 2: Identify Your Current Plugins

Common plugins you might have:
- `dns.providers.*` - DNS challenge providers (cloudflare, route53, etc.)
- `http.handlers.cache` - HTTP caching
- `http.handlers.crowdsec` - CrowdSec integration
- `http.authentication.providers.*` - Auth providers
- `caddy.logging.encoders.*` - Custom logging
- `tls.dns.*` - ACME DNS challenge providers

**Save this list!** You'll need it for the rebuild.

## Step 3: Find Your xcaddy Command

Check how Caddy was originally built:

```bash
# Check if there's a build script
ls -la ~/caddy-build.sh ~/.caddy-build.sh /opt/caddy/build.sh

# Check systemd unit for build info
systemctl cat caddy | grep -i exec

# Look for xcaddy history
history | grep xcaddy

# Check for docker-compose (if Caddy runs in container)
cat ~/docker-compose.yml | grep -A 20 caddy
```

## Step 4: Rebuild Caddy with Layer4

### Install xcaddy (if not already installed)
```bash
# Install xcaddy
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest

# Or via package manager
# Ubuntu/Debian:
# sudo apt install golang-go
# go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest

# Add to PATH if needed
export PATH=$PATH:$(go env GOPATH)/bin
```

### Build with Your Existing Plugins + Layer4

Based on your `caddy list-modules` output, create a build command like this:

```bash
# Example: If you have cloudflare DNS and cache plugins
xcaddy build \
  --with github.com/caddyserver/cache-handler \
  --with github.com/caddy-dns/cloudflare \
  --with github.com/mholt/caddy-l4

# More complete example with common plugins
xcaddy build \
  --with github.com/caddyserver/cache-handler \
  --with github.com/caddy-dns/cloudflare \
  --with github.com/caddy-dns/route53 \
  --with github.com/greenpau/caddy-security \
  --with github.com/mholt/caddy-l4

# Specify exact version to match your current Caddy
xcaddy build v2.7.6 \
  --with github.com/your/plugin1 \
  --with github.com/your/plugin2 \
  --with github.com/mholt/caddy-l4
```

### Common Plugin Mappings

| Module Name (from list-modules) | xcaddy --with |
|--------------------------------|---------------|
| `dns.providers.cloudflare` | `github.com/caddy-dns/cloudflare` |
| `dns.providers.route53` | `github.com/caddy-dns/route53` |
| `http.handlers.cache` | `github.com/caddyserver/cache-handler` |
| `http.authentication.providers.crowdsec` | `github.com/hslatman/caddy-crowdsec-bouncer` |
| `caddy.logging.encoders.transform` | `github.com/caddyserver/transform-encoder` |

## Step 5: Test the New Build

```bash
# Save current Caddy binary
sudo cp $(which caddy) ~/caddy.backup

# Test new build
./caddy version
./caddy list-modules

# Verify layer4 is included
./caddy list-modules | grep layer4
# Should show: layer4, layer4.handlers.proxy, etc.

# Validate your Caddyfile with new build
./caddy validate --config /etc/caddy/Caddyfile
```

## Step 6: Replace Caddy Binary

```bash
# Stop Caddy
sudo systemctl stop caddy

# Replace binary
sudo mv ./caddy /usr/bin/caddy
# Or wherever your caddy binary is located
# Find it with: which caddy

# Set permissions
sudo chown root:root /usr/bin/caddy
sudo chmod 755 /usr/bin/caddy

# Give CAP_NET_BIND_SERVICE capability (allows binding to port 80/443)
sudo setcap cap_net_bind_service=+ep /usr/bin/caddy

# Start Caddy
sudo systemctl start caddy

# Check status
sudo systemctl status caddy
journalctl -u caddy -n 50 -f
```

## Step 7: Update Caddyfile for Minecraft

Add the layer4 configuration:

```caddyfile
{
    layer4 {
        :25565 {
            route {
                proxy {
                    upstream 10.70.48.204:25565
                }
            }
        }
    }
}

# Your existing HTTP sites remain the same
minecraft.yourdomain.com {
    reverse_proxy http://10.70.48.95:8080
}

# All your other existing sites...
```

Reload Caddy:
```bash
sudo systemctl reload caddy
# Or
caddy reload --config /etc/caddy/Caddyfile
```

## Rollback Plan

If something goes wrong:

```bash
# Stop new Caddy
sudo systemctl stop caddy

# Restore backup
sudo cp ~/caddy.backup /usr/bin/caddy
sudo setcap cap_net_bind_service=+ep /usr/bin/caddy

# Restart
sudo systemctl start caddy
```

## Alternative: Docker Build

If you run Caddy in Docker, update your Dockerfile:

```dockerfile
FROM caddy:builder AS builder

RUN xcaddy build \
    --with github.com/caddyserver/cache-handler \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/mholt/caddy-l4

FROM caddy:latest

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

## Quick Reference: Build Command Template

```bash
# 1. Get current modules
caddy list-modules > current-modules.txt

# 2. Build with all your plugins + layer4
xcaddy build \
  --with github.com/plugin1 \
  --with github.com/plugin2 \
  --with github.com/mholt/caddy-l4

# 3. Test
./caddy validate --config /etc/caddy/Caddyfile

# 4. Replace
sudo systemctl stop caddy
sudo mv ./caddy /usr/bin/caddy
sudo setcap cap_net_bind_service=+ep /usr/bin/caddy
sudo systemctl start caddy
```

## Need Help Identifying Plugins?

Run this script to help map modules to xcaddy plugins:

```bash
#!/bin/bash
echo "Current Caddy modules:"
caddy list-modules | grep -E "dns\.|http\." | while read line; do
    echo "  $line"
    # Try to suggest xcaddy equivalent
    if echo "$line" | grep -q "dns.providers"; then
        provider=$(echo "$line" | sed 's/dns.providers.//')
        echo "    → Likely: github.com/caddy-dns/$provider"
    fi
done
```

Save this as `check-modules.sh` and run it on your Caddy server.
