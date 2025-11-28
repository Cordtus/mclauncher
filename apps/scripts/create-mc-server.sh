#!/usr/bin/env bash
set -euo pipefail

#
# Create Minecraft Server Container with Control Agent
#
# Run this script ON THE LXD HOST
#
# Supports multi-profile system:
# - Paper (plugins), Fabric (mods), Forge (mods), Vanilla
# - Switch between profiles instantly via web UI
# - Shared worlds and player data across profiles
#
# Usage:
#   ./create-mc-server.sh <name> [edition] [version] [memory] [cpu] [port] [rcon_port] [rcon_pass] [manager]
#
# Examples:
#   ./create-mc-server.sh mc-server-1 paper 1.21.3 4096 2 25565
#   ./create-mc-server.sh mc-survival fabric 1.20.4 8192 4 25566
#

# Parameters
CONTAINER_NAME="${1:-}"
EDITION="${2:-paper}"           # paper, fabric, forge, or vanilla
MC_VERSION="${3:-1.21.3}"
MEMORY_MB="${4:-4096}"
CPU_LIMIT="${5:-2}"
PUBLIC_PORT="${6:-25565}"
RCON_PORT="${7:-25575}"
RCON_PASSWORD="${8:-$(openssl rand -hex 16)}"
MANAGER_CONTAINER="${9:-mc-manager}"

if [ -z "$CONTAINER_NAME" ]; then
  echo "Usage: $0 <name> [edition] [version] [memory] [cpu] [port] [rcon_port] [rcon_pass] [manager]"
  echo ""
  echo "Parameters:"
  echo "  name      - Container name (required)"
  echo "  edition   - Initial profile: paper, fabric, forge, vanilla (default: paper)"
  echo "  version   - Minecraft version (default: 1.21.3)"
  echo "  memory    - RAM in MB (default: 4096)"
  echo "  cpu       - CPU cores (default: 2)"
  echo "  port      - Minecraft port (default: 25565)"
  echo "  rcon_port - RCON port (default: 25575)"
  echo "  rcon_pass - RCON password (auto-generated if omitted)"
  echo "  manager   - Manager container name (default: mc-manager)"
  echo ""
  echo "Examples:"
  echo "  $0 mc-server-1 paper 1.21.3 4096 2 25565"
  echo "  $0 mc-survival fabric 1.20.4 8192 4 25566"
  exit 1
fi

# Validate edition
case "$EDITION" in
  paper|fabric|forge|vanilla) ;;
  *)
    echo "ERROR: Invalid edition '$EDITION'"
    echo "Valid options: paper, fabric, forge, vanilla"
    exit 1
    ;;
esac

echo "============================================================"
echo "  Creating Minecraft Server Container"
echo "============================================================"
echo ""
echo "Container: $CONTAINER_NAME"
echo "Edition:   $EDITION $MC_VERSION"
echo "Memory:    ${MEMORY_MB}MB"
echo "CPU:       $CPU_LIMIT cores"
echo "Port:      $PUBLIC_PORT"
echo "RCON:      $RCON_PORT"
echo ""

# Create container
echo "==> Creating container..."
lxc launch images:ubuntu/22.04 "$CONTAINER_NAME"

# Wait for boot
echo "==> Waiting for container to boot..."
sleep 5

# Set limits
lxc config set "$CONTAINER_NAME" limits.cpu="$CPU_LIMIT"
lxc config set "$CONTAINER_NAME" limits.memory="${MEMORY_MB}MB"

# NOTE: No proxy devices for Minecraft port - UFW on host handles external access
# The LXD bridge allows direct container-to-container communication

# Install base dependencies and control agent
echo "==> Installing dependencies..."
lxc exec "$CONTAINER_NAME" -- bash -c "
set -euxo pipefail

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  openjdk-21-jre-headless \
  curl \
  jq \
  unzip \
  mcrcon \
  rsync \
  ca-certificates \
  gnupg

# Install Node.js for control agent
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs

# Create Minecraft user
useradd -m -s /usr/sbin/nologin mc

# Create directory structure for multi-profile system
install -d -o mc -g mc /opt/minecraft
install -d -o mc -g mc /opt/minecraft/profiles
install -d -o mc -g mc /opt/minecraft/profiles/paper
install -d -o mc -g mc /opt/minecraft/profiles/fabric
install -d -o mc -g mc /opt/minecraft/profiles/forge
install -d -o mc -g mc /opt/minecraft/profiles/vanilla
install -d -o mc -g mc /opt/minecraft/world
install -d /opt/mc-agent
"

# Copy control agent
echo "==> Installing control agent..."
if [ -d "../../apps/agent" ]; then
  tar czf /tmp/agent.tar.gz -C ../../apps/agent .
  lxc file push /tmp/agent.tar.gz "$CONTAINER_NAME/tmp/"
  lxc exec "$CONTAINER_NAME" -- bash -c "
    cd /opt/mc-agent
    tar xzf /tmp/agent.tar.gz
    rm /tmp/agent.tar.gz
    npm install --omit=dev
    npm run build
  "
  rm /tmp/agent.tar.gz
else
  echo "ERROR: Control agent not found at ../../apps/agent"
  exit 1
fi

# Download and setup initial profile
echo "==> Setting up $EDITION profile..."
lxc exec "$CONTAINER_NAME" -- bash -c "
set -euxo pipefail
cd /opt/minecraft

# Download server JAR based on edition
case '$EDITION' in
  paper)
    BUILD=\$(curl -s https://api.papermc.io/v2/projects/paper/versions/$MC_VERSION | jq -r '.builds[-1]')
    curl -sL -o profiles/paper/server.jar \"https://api.papermc.io/v2/projects/paper/versions/$MC_VERSION/builds/\${BUILD}/downloads/paper-$MC_VERSION-\${BUILD}.jar\"
    mkdir -p profiles/paper/plugins
    ;;
  fabric)
    # Get latest Fabric loader and installer
    LOADER=\$(curl -s 'https://meta.fabricmc.net/v2/versions/loader' | jq -r '.[0].version')
    INSTALLER=\$(curl -s 'https://meta.fabricmc.net/v2/versions/installer' | jq -r '.[0].version')
    curl -sL -o profiles/fabric/server.jar \"https://meta.fabricmc.net/v2/versions/loader/$MC_VERSION/\${LOADER}/\${INSTALLER}/server/jar\"
    mkdir -p profiles/fabric/mods
    mkdir -p profiles/fabric/.fabric
    ;;
  forge)
    # Forge requires installer - download and run
    FORGE_VERSION=\$(curl -s \"https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json\" | jq -r \".promos[\\\"$MC_VERSION-recommended\\\"] // .promos[\\\"$MC_VERSION-latest\\\"] // empty\")
    if [ -n \"\$FORGE_VERSION\" ]; then
      cd profiles/forge
      curl -sL -o forge-installer.jar \"https://maven.minecraftforge.net/net/minecraftforge/forge/$MC_VERSION-\${FORGE_VERSION}/forge-$MC_VERSION-\${FORGE_VERSION}-installer.jar\"
      java -jar forge-installer.jar --installServer
      rm -f forge-installer.jar
      # Find the run script or jar
      if [ -f run.sh ]; then
        chmod +x run.sh
      fi
      mkdir -p mods
      cd /opt/minecraft
    else
      echo 'WARNING: Could not find Forge version for $MC_VERSION, skipping Forge setup'
      touch profiles/forge/.not_installed
    fi
    ;;
  vanilla)
    MANIFEST_URL=\$(curl -s https://piston-meta.mojang.com/mc/game/version_manifest_v2.json | jq -r '.versions[] | select(.id==\"$MC_VERSION\").url')
    SERVER_URL=\$(curl -s \"\$MANIFEST_URL\" | jq -r '.downloads.server.url')
    curl -sL -o profiles/vanilla/server.jar \"\$SERVER_URL\"
    ;;
esac

# Create shared files
cat > eula.txt <<EOF
# Auto-accepted by setup script
eula=true
EOF

cat > server.properties <<EOF
server-port=25565
motd=MC LXD Manager - $CONTAINER_NAME
max-players=20
difficulty=normal
online-mode=true
spawn-protection=0
enable-rcon=true
rcon.port=25575
rcon.password=$RCON_PASSWORD
EOF

# Create config file for agent with profile info
cat > .mc_config.json <<EOF
{
  \"maxRamMb\": $MEMORY_MB,
  \"edition\": \"$EDITION\",
  \"version\": \"$MC_VERSION\",
  \"activeProfile\": \"$EDITION\"
}
EOF

# Create symlinks for initial profile
case '$EDITION' in
  paper)
    ln -sf profiles/paper/server.jar server.jar
    ln -sf profiles/paper/plugins plugins
    ;;
  fabric)
    ln -sf profiles/fabric/server.jar server.jar
    ln -sf profiles/fabric/mods mods
    ;;
  forge)
    if [ -f profiles/forge/server.jar ] || [ -f profiles/forge/run.sh ]; then
      ln -sf profiles/forge/server.jar server.jar 2>/dev/null || true
      ln -sf profiles/forge/mods mods
    fi
    ;;
  vanilla)
    ln -sf profiles/vanilla/server.jar server.jar
    ;;
esac

chown -R mc:mc /opt/minecraft
"

# Create Minecraft systemd service with profile awareness
lxc exec "$CONTAINER_NAME" -- bash -c "cat > /etc/systemd/system/minecraft.service <<'EOF'
[Unit]
Description=Minecraft Server
After=network.target mc-agent.service

[Service]
Type=simple
User=mc
WorkingDirectory=/opt/minecraft
ExecStart=/usr/bin/java -Xms512M -Xmx${MEMORY_MB}M -jar server.jar nogui
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
"

# Create control agent systemd service
lxc exec "$CONTAINER_NAME" -- bash -c "cat > /etc/systemd/system/mc-agent.service <<'EOF'
[Unit]
Description=Minecraft Control Agent
After=network.target
Before=minecraft.service

[Service]
Type=simple
WorkingDirectory=/opt/mc-agent
Environment=AGENT_PORT=9090
Environment=MC_DIR=/opt/minecraft
Environment=RCON_PORT=25575
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
"

# Set RCON password in agent environment
lxc exec "$CONTAINER_NAME" -- bash -c "echo 'Environment=RCON_PASSWORD=$RCON_PASSWORD' >> /etc/systemd/system/mc-agent.service"

# Enable and start services
echo "==> Starting services..."
lxc exec "$CONTAINER_NAME" -- systemctl daemon-reload
lxc exec "$CONTAINER_NAME" -- systemctl enable mc-agent
lxc exec "$CONTAINER_NAME" -- systemctl enable minecraft
lxc exec "$CONTAINER_NAME" -- systemctl start mc-agent
sleep 2
lxc exec "$CONTAINER_NAME" -- systemctl start minecraft

# Get container IP (for internal communication with agent)
CONTAINER_IP=$(lxc list "$CONTAINER_NAME" -c4 --format=csv | cut -d' ' -f1)

# Get host IP for local network connections
HOST_IP=$(ip route get 1.1.1.1 | grep -oP 'src \K\S+' || echo "192.168.0.170")

# Register with management backend
echo "==> Registering server with management backend..."
sleep 3

# Get manager token
ADMIN_TOKEN=$(lxc exec "$MANAGER_CONTAINER" -- cat /opt/mc-lxd-manager/.env | grep ADMIN_TOKEN | cut -d= -f2)

# Register via API
lxc exec "$MANAGER_CONTAINER" -- bash -c "
curl -X POST http://127.0.0.1:8080/api/servers/register \
  -H 'Authorization: Bearer $ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    \"name\": \"$CONTAINER_NAME\",
    \"agent_url\": \"http://$CONTAINER_IP:9090\",
    \"public_port\": $PUBLIC_PORT,
    \"host_ip\": \"$HOST_IP\",
    \"memory_mb\": $MEMORY_MB,
    \"cpu_limit\": \"$CPU_LIMIT\",
    \"edition\": \"$EDITION\",
    \"mc_version\": \"$MC_VERSION\"
  }'
" || echo "Warning: Could not register with manager (it may not be running yet)"

echo ""
echo "============================================================"
echo "  Minecraft Server Created!"
echo "============================================================"
echo ""
echo "Container:    $CONTAINER_NAME"
echo "IP Address:   $CONTAINER_IP"
echo "Edition:      $EDITION $MC_VERSION"
echo "Active Profile: $EDITION"
echo ""
echo "============================================================"
echo "  Connection Info"
echo "============================================================"
echo ""
echo "Local Network: $HOST_IP:$PUBLIC_PORT"
echo "(Configure UFW and router port forwarding for external access)"
echo ""
echo "RCON Port:     $RCON_PORT"
echo "RCON Password: $RCON_PASSWORD"
echo ""
echo "============================================================"
echo "  Profile System"
echo "============================================================"
echo ""
echo "Installed profiles:"
echo "  - $EDITION (active)"
echo ""
echo "Install more profiles via web UI (Server Profiles button)"
echo "or switch between Paper, Fabric, Forge, and Vanilla instantly!"
echo ""
echo "============================================================"
echo "  Commands"
echo "============================================================"
echo ""
echo "  lxc exec $CONTAINER_NAME -- systemctl status minecraft"
echo "  lxc exec $CONTAINER_NAME -- systemctl status mc-agent"
echo "  lxc exec $CONTAINER_NAME -- journalctl -u minecraft -f"
echo ""
