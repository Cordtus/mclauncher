#!/usr/bin/env bash
set -euo pipefail

#
# Create Minecraft Server Container with Control Agent
# Run this script ON THE LXD HOST
#

# Parameters
CONTAINER_NAME="${1:-}"
EDITION="${2:-paper}"           # paper or vanilla
MC_VERSION="${3:-1.21.1}"
MEMORY_MB="${4:-2048}"
CPU_LIMIT="${5:-2}"
PUBLIC_PORT="${6:-25565}"
RCON_PORT="${7:-25575}"
RCON_PASSWORD="${8:-$(openssl rand -hex 16)}"
MANAGER_CONTAINER="${9:-mc-manager}"

if [ -z "$CONTAINER_NAME" ]; then
  echo "Usage: $0 <container_name> [edition] [mc_version] [memory_mb] [cpu_limit] [public_port] [rcon_port] [rcon_password] [manager_container]"
  echo ""
  echo "Example: $0 mc-server-1 paper 1.21.1 4096 2 25565 25575 mypassword mc-manager"
  exit 1
fi

echo "==> Creating Minecraft Server Container"
echo "    Name: $CONTAINER_NAME"
echo "    Edition: $EDITION $MC_VERSION"
echo "    Memory: ${MEMORY_MB}MB"
echo "    CPU: $CPU_LIMIT cores"
echo "    Public Port: $PUBLIC_PORT"
echo "    RCON Port: $RCON_PORT"

# Create container
lxc launch images:ubuntu/22.04 "$CONTAINER_NAME"

# Wait for boot
sleep 5

# Set limits
lxc config set "$CONTAINER_NAME" limits.cpu="$CPU_LIMIT"
lxc config set "$CONTAINER_NAME" limits.memory="${MEMORY_MB}MB"

# Add proxy for Minecraft port
lxc config device add "$CONTAINER_NAME" mc-proxy proxy \
  listen="tcp:0.0.0.0:${PUBLIC_PORT}" \
  connect="tcp:127.0.0.1:25565"

# Add proxy for RCON if enabled
if [ -n "$RCON_PASSWORD" ]; then
  lxc config device add "$CONTAINER_NAME" rcon-proxy proxy \
    listen="tcp:0.0.0.0:${RCON_PORT}" \
    connect="tcp:127.0.0.1:25575"
fi

# Install base dependencies and control agent
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

# Create directories
install -d -o mc -g mc /opt/minecraft
install -d -o mc -g mc /opt/minecraft/plugins
install -d -o mc -g mc /opt/minecraft/mods
install -d -o mc -g mc /opt/minecraft/worlds
install -d /opt/mc-agent
"

# Copy control agent
if [ -d "../../apps/agent" ]; then
  echo "==> Copying control agent..."
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

# Download Minecraft server
lxc exec "$CONTAINER_NAME" -- bash -c "
set -euxo pipefail
cd /opt/minecraft

if [ '$EDITION' = 'paper' ]; then
  # Download Paper
  BUILD=\$(curl -s https://api.papermc.io/v2/projects/paper/versions/$MC_VERSION | jq -r '.builds[-1]')
  curl -sL -o server.jar \"https://api.papermc.io/v2/projects/paper/versions/$MC_VERSION/builds/\${BUILD}/downloads/paper-$MC_VERSION-\${BUILD}.jar\"
else
  # Download Vanilla
  MANIFEST_URL=\$(curl -s https://piston-meta.mojang.com/mc/game/version_manifest_v2.json | jq -r '.versions[] | select(.id==\"$MC_VERSION\").url')
  SERVER_URL=\$(curl -s \"\$MANIFEST_URL\" | jq -r '.downloads.server.url')
  curl -sL -o server.jar \"\$SERVER_URL\"
fi

# Create eula.txt
cat > eula.txt <<EOF
# Auto-accepted by setup script
eula=true
EOF

# Create server.properties
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

# Create config file for agent
cat > .mc_config.json <<EOF
{
  \"maxRamMb\": $MEMORY_MB,
  \"edition\": \"$EDITION\",
  \"version\": \"$MC_VERSION\"
}
EOF

chown -R mc:mc /opt/minecraft
"

# Create Minecraft systemd service
lxc exec "$CONTAINER_NAME" -- bash -c "cat > /etc/systemd/system/minecraft.service <<'EOF'
[Unit]
Description=Minecraft Server
After=network.target

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

# Enable and start services
lxc exec "$CONTAINER_NAME" -- systemctl daemon-reload
lxc exec "$CONTAINER_NAME" -- systemctl enable mc-agent
lxc exec "$CONTAINER_NAME" -- systemctl enable minecraft
lxc exec "$CONTAINER_NAME" -- systemctl start mc-agent
lxc exec "$CONTAINER_NAME" -- systemctl start minecraft

# Get container IP
CONTAINER_IP=$(lxc list "$CONTAINER_NAME" -c4 --format=csv | cut -d' ' -f1)

# Register with management backend
echo "==> Registering server with management backend..."
sleep 5  # Wait for services to start

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
    \"memory_mb\": $MEMORY_MB,
    \"cpu_limit\": \"$CPU_LIMIT\",
    \"edition\": \"$EDITION\",
    \"mc_version\": \"$MC_VERSION\"
  }'
"

echo ""
echo "==> Minecraft server created and registered!"
echo ""
echo "Container: $CONTAINER_NAME"
echo "Edition: $EDITION $MC_VERSION"
echo "Minecraft Port: $PUBLIC_PORT"
echo "RCON Port: $RCON_PORT"
echo "RCON Password: $RCON_PASSWORD"
echo "Agent IP: $CONTAINER_IP:9090"
echo ""
echo "Commands:"
echo "  lxc exec $CONTAINER_NAME -- systemctl status minecraft"
echo "  lxc exec $CONTAINER_NAME -- systemctl status mc-agent"
echo "  lxc exec $CONTAINER_NAME -- journalctl -u minecraft -f"
echo ""
