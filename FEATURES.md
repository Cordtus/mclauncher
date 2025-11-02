# User-Facing Features (to preserve in new architecture)

## Server Management
- List all servers with status, ports, memory, CPU limits
- Create new server with configuration:
  - Container name
  - Edition: Paper or Vanilla
  - Minecraft version
  - Memory limit (MB)
  - CPU limit (cores or percentage)
  - EULA acceptance
  - Public port
  - RCON enable/port/password
- Start/Stop/Restart server
- Delete server
- View real-time logs

## File Management
- Upload plugins (.jar files) via drag-and-drop
- Upload mods (.jar files) via drag-and-drop
- Upload world files (.zip) via drag-and-drop
- List available worlds
- Switch between worlds without data loss

## Configuration
- View server.properties
- Edit server.properties in browser
- Save and auto-restart on config change

## Integrations
- Packwiz: Sync modpack from URL
- LuckPerms: One-click install
- RCON: Send commands directly from UI

## Networking
- Add proxy devices (port forwarding)

## Backups
- Create snapshot backup on demand
- Export to tarball

## Security
- LAN-only access via CIDR filtering
- Admin token authentication (Bearer token)
- Trust proxy headers for IP detection

## UI Features
- Simple form-based server creation
- Card-based server list
- Collapsible sections for advanced features
- Drag-and-drop file uploads
- Real-time status display
