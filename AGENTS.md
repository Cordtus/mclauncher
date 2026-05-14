# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

MC LXD Manager is a web-based management panel for Minecraft servers running in LXD containers. It uses a container-based architecture where everything runs in isolated LXD containers without Docker or host services.

## Architecture

### Three-Tier Container Architecture

**Management Container** (`mc-manager`)
- Runs the web UI (React/Vite) and API gateway (Express)
- Exposes port 8080 to host via LXD proxy
- Maintains server registry in `/opt/mc-lxd-manager/servers.json`
- Proxies API requests to control agents
- Code: `apps/server/` (API gateway) + `apps/web/` (frontend)

**Server Containers** (`mc-server-*`)
- Each runs a Minecraft server instance + control agent
- Minecraft service managed via systemd (`minecraft.service`)
- Control agent runs on port 9090 (internal only, not exposed)
- Agent provides HTTP API for server control
- Code: `apps/agent/`

**Communication Flow**
```
Browser → Management Container (8080)
         → API Gateway proxies to
         → Control Agent (internal:9090)
         → Executes systemctl/filesystem operations
```

### Key Architectural Patterns

1. **Proxy-based API**: Management backend doesn't control servers directly, it proxies to agents
2. **Registry-based discovery**: Server registry maps container names to agent URLs
3. **Systemd integration**: All Minecraft servers managed via systemd units
4. **Symlink-based worlds**: World switching uses symlinks for instant switching
5. **Version management**: VersionManager handles Paper/Vanilla downloads and updates
6. **Mod management**: Modrinth API integration for mod browsing, JAR metadata extraction for mod info
7. **Config parsing**: Multi-format config parser (TOML, JSON, JSON5, YAML, properties) for mod configs

## Technology Stack

- **Package Manager**: npm workspaces
- **Monorepo**: Workspace-based with 3 apps
- **Language**: TypeScript (ES modules)
- **Backend**: Express.js with CORS, multer for uploads
- **Frontend**: React 18 + Vite + shadcn/ui + Tailwind CSS
- **Build**: TypeScript compiler (backend), Vite (frontend)
- **Dev Tools**: tsx for watch mode
- **Testing**: vitest (unit), Playwright (e2e)

## Common Development Commands

### Root workspace commands
```bash
# Install all dependencies
npm install --workspaces

# Development (runs server in watch mode)
npm run dev

# Build all apps (web, server, agent)
npm run build

# Start production server
npm start

# Lint and format
npm run lint
npm run format

# Testing
npm test              # Run agent unit tests (vitest)
npm run test:e2e      # Run e2e tests (playwright)
npm run test:e2e:ui   # Run e2e tests with UI
```

### Per-app commands
```bash
# Web app (React frontend)
cd apps/web
npm run dev        # Vite dev server on port 5173
npm run build      # Build to apps/web/dist
npm run preview    # Preview production build

# Server (API gateway)
cd apps/server
npm run dev        # tsx watch mode
npm run build      # Compile TS to dist/
npm start          # Run compiled JS

# Agent (control agent)
cd apps/agent
npm run dev        # tsx watch mode
npm run build      # Compile TS to dist/
npm start          # Run compiled JS
npm test           # Run unit tests (vitest)
npm run test:ui    # Run tests with UI
```

### Testing deployment locally
```bash
# Create management container
sudo ./apps/scripts/create-management-container.sh mc-manager 8080

# Create Minecraft server container
sudo ./apps/scripts/create-mc-server.sh mc-server-1 paper 1.21.1 4096 2 25565

# View logs
lxc exec mc-manager -- journalctl -u mc-manager -f
lxc exec mc-server-1 -- journalctl -u minecraft -f
lxc exec mc-server-1 -- journalctl -u mc-agent -f
```

## Important File Locations

### Development (host)
- `apps/server/src/index.ts` - API gateway entry point
- `apps/server/src/services/modrinth.ts` - Modrinth API integration
- `apps/agent/src/index.ts` - Control agent entry point
- `apps/agent/src/managers/version.ts` - Version switching logic
- `apps/agent/src/managers/world.ts` - World management logic
- `apps/agent/src/downloaders/` - Paper and Vanilla downloaders
- `apps/agent/src/services/jar-metadata.ts` - Extract metadata from mod JARs
- `apps/agent/src/services/config-parser.ts` - Parse mod config files (TOML/JSON/YAML/properties)
- `apps/agent/src/services/mojang.ts` - Mojang API UUID resolution
- `apps/agent/src/services/properties-parser.ts` - Java .properties parser
- `apps/web/src/App.tsx` - Main React component
- `apps/web/src/components/ModBrowser.tsx` - Modrinth mod browser
- `apps/web/src/components/ModsManagementPanel.tsx` - Installed mods panel
- `apps/web/src/components/ModConfigEditor.tsx` - Dynamic config editor
- `e2e/` - Playwright end-to-end tests

### Production (containers)
- Management: `/opt/mc-lxd-manager/` - Deployed code and registry
- Server: `/opt/minecraft/` - Minecraft installation directory
- Server: `/opt/minecraft/worlds/` - All saved worlds
- Server: `/opt/minecraft/world` - Symlink to active world
- Server: `/var/backups/minecraft/` - Backup tarballs

## Code Patterns and Conventions

### API Gateway Pattern (apps/server)
- Registry loaded from filesystem on each request (no in-memory cache)
- All protected operations require `requireAdmin` middleware (passkey session, or token auth when explicitly enabled; optional CIDR filtering can add LAN/VPN gating)
- Proxy helper: `proxyToAgent(agentUrl, path, options)`
- File uploads proxied using FormData + Blob

### Control Agent Pattern (apps/agent)
- Uses systemd for all Minecraft operations (`systemctl start/stop/restart minecraft`)
- Synchronous shell commands: `sh()` throws on error, `shSafe()` returns status
- World operations always stop/start server for consistency
- File ownership always set to `mc:mc` after operations
- Metadata extraction before file deletion to prevent data loss

### Version Management
- Paper: Uses PaperMC API to list versions/builds and download JARs
- Vanilla: Uses Mojang manifest API for official releases
- Version changes create backup, validate JAR, monitor startup
- Type switching (Paper ↔ Vanilla) preserves world data

### World Management
- Worlds stored in `worlds/` subdirectories with `level.dat` validation
- Active world selected via symlink (`world` → `worlds/active-world-name`)
- Import/export uses zip files
- Switching stops server, updates symlink, restarts

### Mod Management
- Modrinth API for searching and downloading mods
- JAR metadata extraction for Forge/NeoForge (mods.toml) and Fabric (fabric.mod.json)
- Resource impact estimation (light/medium/heavy) based on categories
- Compatibility checking (version, loader, dependencies, conflicts)
- Multi-format config parser for mod configs (TOML, JSON, JSON5, YAML, properties)
- TOML parser tracks sections and preserves comments/formatting
- Config updates handle nested keys and missing fields

### Server Settings Management
- Mojang API integration for username to UUID resolution
- Properties parser preserving comments and formatting
- Structured API for updating server.properties
- Whitelist.json and ops.json management with UUID validation
- Automatic server restart after settings changes
- Rate limiting and caching for Mojang API requests

## Security Model

1. **Passkey gating**: Protected management operations require an admin passkey session by default; registered passkeys can start a new admin session without first entering a token
2. **One-time setup codes**: Pre-approved admins can use a one-time code only to register an ES256 P-256/secp256r1 passkey; setup codes do not authorize server management
3. **Optional CIDR filtering**: `ADMIN_REQUIRE_CIDR=true` restricts admin auth attempts to LAN and WireGuard VPN ranges
4. **Internal-only agents**: Control agents on port 9090 never exposed outside container network
5. **No host services**: Everything isolated in LXD containers

## Testing and Debugging

### Check server registration
```bash
lxc exec mc-manager -- cat /opt/mc-lxd-manager/servers.json
```

### Verify agent is running
```bash
lxc exec mc-server-1 -- systemctl status mc-agent
lxc exec mc-server-1 -- curl -s localhost:9090/health
```

### Check Minecraft status
```bash
lxc exec mc-server-1 -- systemctl status minecraft
```

### View recent logs
```bash
# Agent logs
lxc exec mc-server-1 -- journalctl -u mc-agent -n 50

# Minecraft logs
lxc exec mc-server-1 -- journalctl -u minecraft -n 100
```

### Test API endpoints
```bash
# List servers (no auth required for read)
curl http://localhost:8080/api/servers

# Register server (requires admin auth)
curl -X POST http://localhost:8080/api/servers/register \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"test","agent_url":"http://10.x.x.x:9090","public_port":25565}'
```

## Build Output Locations

- `apps/web/dist/` - Static frontend (served by management backend)
- `apps/server/dist/` - Compiled API gateway
- `apps/agent/dist/` - Compiled control agent

## Module System

All three apps use ES modules (`"type": "module"` in package.json):
- Import extensions required: `.js` (not `.ts`) in compiled output
- Use `import` syntax, not `require()`
- tsx handles TypeScript in dev mode, tsc compiles for production

## Frontend Details

- **UI Components**: shadcn/ui (Radix UI primitives + Tailwind)
- **Styling**: Tailwind CSS with tailwindcss-animate
- **Icons**: lucide-react
- **Toast notifications**: sonner
- **Theme support**: next-themes
- **Build tool**: Vite with @vitejs/plugin-react

## Key Dependencies

### Backend & Agent
- `express` - HTTP server framework
- `multer` - Multipart file upload handling
- `cors` - CORS middleware
- `tsx` - TypeScript execution and watch mode (dev)
- `dotenv` - Environment variable loading (server)
- `toml`, `json5`, `js-yaml`, `properties-reader` - Config parsing
- `yauzl` - ZIP file extraction for JAR metadata

### Testing
- `vitest` - Unit testing framework
- `@playwright/test` - End-to-end testing

## Environment Variables

### Management backend (`apps/server`)
- `HOST` - Bind address (default: 0.0.0.0)
- `PORT` - HTTP port (default: 8080)
- `REGISTRY_FILE` - Server registry path (default: /opt/mc-lxd-manager/servers.json)
- `ADMIN_TOKEN` - Optional authentication token when `ADMIN_AUTH_METHODS` includes `token`
- `ADMIN_AUTH_METHODS` - Comma-separated admin auth methods (default: token,passkey in the server; management setup script defaults to passkey)
- `PASSKEY_REGISTRATION_CODES` - Comma-separated one-time setup codes as `label:code` or `code`; codes authorize only passkey registration and are stored hashed after import
- `ADMIN_REQUIRE_CIDR` - Require `ALLOW_CIDRS` for admin auth and protected routes (default: false)
- `ALLOW_CIDRS` - Comma-separated CIDR ranges used when `ADMIN_REQUIRE_CIDR=true` (default: 127.0.0.0/8,192.168.0.0/24,10.70.48.0/24,10.172.19.0/24)
- `TRUST_PROXY` - Trust X-Forwarded-For header (default: false)

### Control agent (`apps/agent`)
- `AGENT_PORT` - HTTP port (default: 9090)
- `MC_DIR` - Minecraft directory (default: /opt/minecraft)
- `RCON_PORT` - RCON port (default: 25575)
