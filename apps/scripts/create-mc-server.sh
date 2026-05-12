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
PUBLIC_PORT="${6:-34567}"        # Host proxy port for Minecraft traffic
RCON_PORT="${7:-25575}"
RCON_PASSWORD="${8:-$(openssl rand -hex 16)}"
MANAGER_CONTAINER="${9:-mc-manager}"
AGENT_TOKEN="${AGENT_TOKEN:-$(openssl rand -hex 32)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENT_DIR="$REPO_ROOT/apps/agent"
CONTAINER_MEMORY_MB=$((MEMORY_MB + 1024))

if [ -z "$CONTAINER_NAME" ]; then
  echo "Usage: $0 <container_name> [edition] [mc_version] [memory_mb] [cpu_limit] [public_port] [rcon_port] [rcon_password] [manager_container]"
  echo ""
  echo "Example: $0 mc-server-1 paper 1.21.1 4096 2 34567 25575 mypassword mc-manager"
  exit 1
fi

TMP_FILES=()
REMOTE_TMP_DIRS=()
cleanup_tmp_files() {
  for file in "${TMP_FILES[@]}"; do
    [ -f "$file" ] && rm -f "$file"
  done
  for entry in "${REMOTE_TMP_DIRS[@]}"; do
    local container="${entry%%:*}"
    local dir="${entry#*:}"
    [ -n "$container" ] && [ -n "$dir" ] && lxc exec "$container" -- rm -rf "$dir" >/dev/null 2>&1 || true
  done
}
trap cleanup_tmp_files EXIT

new_secret_file() {
  local file
  file="$(mktemp)"
  chmod 600 "$file"
  TMP_FILES+=("$file")
  printf '%s' "$file"
}

echo "==> Creating Minecraft Server Container"
echo "    Name: $CONTAINER_NAME"
echo "    Edition: $EDITION $MC_VERSION"
echo "    Memory: ${MEMORY_MB}MB"
echo "    Container Memory Limit: ${CONTAINER_MEMORY_MB}MB"
echo "    CPU: $CPU_LIMIT cores"
echo "    Public Port: $PUBLIC_PORT"
echo "    RCON Port: $RCON_PORT"

# Create container
lxc launch images:ubuntu/22.04 "$CONTAINER_NAME"

# Wait for boot
sleep 5

# Set limits
lxc config set "$CONTAINER_NAME" limits.cpu="$CPU_LIMIT"
lxc config set "$CONTAINER_NAME" limits.memory="${CONTAINER_MEMORY_MB}MB"

# Add proxy for Minecraft port
lxc config device add "$CONTAINER_NAME" mc-proxy proxy \
  listen="tcp:0.0.0.0:${PUBLIC_PORT}" \
  connect="tcp:127.0.0.1:25565"

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
if [ -d "$AGENT_DIR" ]; then
  echo "==> Copying control agent..."
  tar czf /tmp/agent.tar.gz -C "$AGENT_DIR" .
  lxc file push /tmp/agent.tar.gz "$CONTAINER_NAME/tmp/"
  lxc exec "$CONTAINER_NAME" -- bash -c "
    cd /opt/mc-agent
    tar xzf /tmp/agent.tar.gz
    rm /tmp/agent.tar.gz
    npm install
    npm run build
    npm prune --omit=dev
  "
  rm /tmp/agent.tar.gz
else
  echo "ERROR: Control agent not found at $AGENT_DIR"
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

SERVER_PROPERTIES_FILE="$(new_secret_file)"
cat > "$SERVER_PROPERTIES_FILE" <<EOF
server-port=25565
server-ip=127.0.0.1
motd=MC LXD Manager - $CONTAINER_NAME
max-players=20
difficulty=normal
online-mode=true
spawn-protection=0
enable-rcon=true
rcon.port=$RCON_PORT
rcon.password=$RCON_PASSWORD
EOF
lxc file push "$SERVER_PROPERTIES_FILE" "$CONTAINER_NAME/opt/minecraft/server.properties"
lxc exec "$CONTAINER_NAME" -- chown mc:mc /opt/minecraft/server.properties
lxc exec "$CONTAINER_NAME" -- chmod 600 /opt/minecraft/server.properties

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

AGENT_ENV_FILE="$(new_secret_file)"
cat > "$AGENT_ENV_FILE" <<EOF
AGENT_PORT=9090
MC_DIR=/opt/minecraft
RCON_PORT=$RCON_PORT
AGENT_TOKEN=$AGENT_TOKEN
EOF
lxc file push "$AGENT_ENV_FILE" "$CONTAINER_NAME/etc/mc-agent.env"
lxc exec "$CONTAINER_NAME" -- chown root:root /etc/mc-agent.env
lxc exec "$CONTAINER_NAME" -- chmod 600 /etc/mc-agent.env

# Create control agent systemd service
lxc exec "$CONTAINER_NAME" -- bash -c "cat > /etc/systemd/system/mc-agent.service <<'EOF'
[Unit]
Description=Minecraft Control Agent
After=network.target
Before=minecraft.service

[Service]
Type=simple
WorkingDirectory=/opt/mc-agent
EnvironmentFile=/etc/mc-agent.env
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

# Get container IP (for internal communication with agent)
CONTAINER_IP=$(lxc list "$CONTAINER_NAME" -c4 --format=csv | cut -d' ' -f1)

# Get host IP for local network connections
HOST_IP=$(ip route get 1.1.1.1 | grep -oP 'src \K\S+')

# Register with management backend
echo "==> Registering server with management backend..."
sleep 5  # Wait for services to start

REGISTER_PAYLOAD_FILE="$(new_secret_file)"
cat > "$REGISTER_PAYLOAD_FILE" <<EOF
{
  "name": "$CONTAINER_NAME",
  "agent_url": "http://$CONTAINER_IP:9090",
  "public_port": $PUBLIC_PORT,
  "host_proxy_port": $PUBLIC_PORT,
  "host_ip": "$HOST_IP",
  "agent_token": "$AGENT_TOKEN",
  "memory_mb": $MEMORY_MB,
  "cpu_limit": "$CPU_LIMIT",
  "edition": "$EDITION",
  "mc_version": "$MC_VERSION"
}
EOF

MANAGER_REGISTER_DIR="$(lxc exec "$MANAGER_CONTAINER" -- mktemp -d /tmp/mc-register.XXXXXX)"
REMOTE_TMP_DIRS+=("$MANAGER_CONTAINER:$MANAGER_REGISTER_DIR")
lxc file push "$REGISTER_PAYLOAD_FILE" "$MANAGER_CONTAINER$MANAGER_REGISTER_DIR/register-server.json"
lxc exec "$MANAGER_CONTAINER" -- chown root:root "$MANAGER_REGISTER_DIR/register-server.json"
lxc exec "$MANAGER_CONTAINER" -- chmod 600 "$MANAGER_REGISTER_DIR/register-server.json"
lxc exec "$MANAGER_CONTAINER" -- bash -c '
set -euo pipefail
REGISTER_DIR="$1"
PAYLOAD_FILE="$REGISTER_DIR/register-server.json"
CURL_CONFIG="$REGISTER_DIR/curl.conf"

cleanup() {
  rm -rf "$REGISTER_DIR"
}
trap cleanup EXIT

ADMIN_TOKEN=$(sed -n "s/^ADMIN_TOKEN=//p" /opt/mc-lxd-manager/.env | head -n1)
if [ -z "$ADMIN_TOKEN" ]; then
  echo "ADMIN_TOKEN is not set in /opt/mc-lxd-manager/.env" >&2
  exit 1
fi

install -m 600 -o root -g root /dev/null "$CURL_CONFIG"
{
  printf "%s\n" "request = \"POST\""
  printf "%s\n" "url = \"http://127.0.0.1:8080/api/servers/register\""
  printf "header = \"Authorization: Bearer %s\"\n" "$ADMIN_TOKEN"
  printf "%s\n" "header = \"Content-Type: application/json\""
  printf "data-binary = \"@%s\"\n" "$PAYLOAD_FILE"
  printf "%s\n" "fail"
  printf "%s\n" "silent"
  printf "%s\n" "show-error"
} > "$CURL_CONFIG"

curl --config "$CURL_CONFIG"
' -- "$MANAGER_REGISTER_DIR"

echo ""
echo "==> Minecraft server created and registered!"
echo ""
echo "Container: $CONTAINER_NAME"
echo "Edition: $EDITION $MC_VERSION"
echo ""
echo "Connection Info:"
echo "  Local Network: $HOST_IP:$PUBLIC_PORT"
echo "  (Only players on your WiFi can use this)"
echo ""
echo "RCON:"
echo "  Internal Port: $RCON_PORT (not exposed on the host)"
echo "  Password: stored in /opt/minecraft/server.properties"
echo "Agent:"
echo "  Shared token: generated and registered with $MANAGER_CONTAINER"
echo ""
echo "Management Commands:"
echo "  lxc exec $CONTAINER_NAME -- systemctl status minecraft"
echo "  lxc exec $CONTAINER_NAME -- systemctl status mc-agent"
echo "  lxc exec $CONTAINER_NAME -- journalctl -u minecraft -f"
echo ""
