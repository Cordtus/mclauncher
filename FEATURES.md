# MC LXD Manager - Feature List

## Server Management
- List all servers with status, ports, memory, CPU limits
- Create new server with configuration:
  - Container name
  - Edition: Paper, Vanilla, Forge, NeoForge, Fabric
  - Minecraft version
  - Memory limit (MB)
  - CPU limit (cores or percentage)
  - EULA acceptance
  - Public port
  - RCON enable/port/password
- Start/Stop/Restart server
- Delete server
- View real-time logs with auto-refresh
- Server status with Minecraft ping (player count, MOTD)

## Version Management
- Switch between Paper versions
- Switch between Vanilla versions
- Switch between Paper and Vanilla (preserves worlds)
- List available versions and builds
- Automatic backup before version change
- Startup monitoring and validation

## World Management
- Upload world files (.zip) via drag-and-drop
- List all available worlds with metadata
- Switch between worlds without data loss (symlink-based)
- Import world from ZIP
- Export world to ZIP
- Delete world with automatic backup
- View active world name

## Advanced Mod Management
- Browse mods from Modrinth with search and filters
  - Search by name, category, loader type
  - Filter by Minecraft version
  - Sort by relevance, downloads, updated date
- Install mods directly from Modrinth
- View installed mods with metadata:
  - Mod name, version, description
  - Author information
  - Mod icon extracted from JAR
  - Resource impact estimation (light/medium/heavy)
  - Loader type (Forge/NeoForge/Fabric)
  - Dependencies and conflicts
- Enable/disable mods (rename to .disabled)
- Remove mods with optional config cleanup
- Mod config editor:
  - List all config files for each mod
  - Edit configs in browser with syntax highlighting
  - Support for multiple formats (TOML, JSON, JSON5, YAML, properties)
  - Dynamic UI generation from config structure
  - Backup before saving changes

## Server Settings (Structured Configuration)
- Network settings:
  - Host IP configuration
  - Public domain configuration
- Server properties:
  - MOTD (Message of the Day)
  - Max players
  - Game mode (survival/creative/adventure/spectator)
  - Difficulty (peaceful/easy/normal/hard)
  - PVP enabled/disabled
  - Spawn protection radius
  - View distance
  - Online mode (Mojang authentication)
  - Allow flight
- Whitelist management:
  - Add/remove players by username
  - Automatic UUID resolution via Mojang API
  - Enable/disable whitelist enforcement
- Operator management:
  - Add/remove operators by username
  - Automatic UUID resolution
  - Level 4 permissions by default
- All changes applied with automatic server restart

## File Management
- Upload plugins (.jar files) via drag-and-drop
- Upload mods (.jar files) via drag-and-drop
- Context-aware upload buttons based on server loader type

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
