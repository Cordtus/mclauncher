# UI Migration Audit: lxc-mc-ui Concept to mclauncher

## Scope

Source application: `/home/cordt/repos/mclauncher`

Concept UI: `/home/cordt/repos/lxc-mc-ui`

Goal: migrate the current application to the concept's new routed UI and workspace layout without losing current functionality, changing backend contracts accidentally, or importing mock/demo behavior that does not belong in production.

## Summary Decision

Migrate the concept's information architecture and interaction shape:

- Sidebar shell with Fleet Home, Archive Library, and Admin Access.
- Per-server workspace with tabs for Overview, Players, Content, Worlds, and Settings.
- Dedicated Archive Library instead of hiding archives only inside a dialog.
- Overview split between health/connection state, quick actions, logs, and RCON.
- Public player-share route as a first-class surface for modpack/player instructions.
- Signed-out root route as a read-only player directory backed by sanitized public server state.
- SWR-style polling and smaller page modules, if adapted to the existing auth/session model.

Do not migrate the concept as a direct code drop:

- `server.ts` in `lxc-mc-ui` is a mock API server, not a production-compatible backend.
- The concept auth flow persists an admin token in `localStorage` and treats passkey registration options as a completed registration. The real app uses HttpOnly cookies and full WebAuthn create/get plus verify.
- Several concept pages call endpoints that do not exist in the real gateway.
- Several current production features are missing from the concept screens.
- Some concept interactions use `alert`, `confirm`, and `prompt`; production should use existing dialog/toast patterns.

## Current Production Feature Surface

### Authentication and access gating

Current source:

- Frontend: `apps/web/src/App.tsx`, `apps/web/src/lib/auth.ts`, `apps/web/src/lib/passkeys.ts`
- Backend: `apps/server/src/index.ts`, `apps/server/src/services/passkeys.ts`

Current behavior:

- Reads `/api/auth/config` and `/api/auth/session`.
- Supports passkey login, first/admin passkey registration, setup-code registration, logout, listing setup codes, and revoking unused generated setup codes.
- Supports token login only when token auth is enabled.
- Stores admin sessions in HttpOnly same-origin cookies.
- Explicitly distinguishes an unauthenticated `401` server list from an empty fleet by showing an admin-gated inventory state.
- Exposes `/api/public/servers` and `/api/public/servers/events` without admin auth for running servers that have public join addresses. These responses intentionally omit agent URLs, local addresses, memory, CPU, lifecycle data, player access lists, logs, and write capabilities.

Migration requirement:

- Keep the current passkey implementation and cookie session semantics.
- The new routed app can move auth into a store, but it must call the existing `passkeys.ts` WebAuthn helper flow.
- Do not store admin tokens in `localStorage`.
- Do not show a hard-coded preview token.
- Preserve the "registered admin inventory is hidden until admin access is unlocked" state, while allowing the public player directory to show sanitized running server join data.

### Fleet lifecycle

Current source:

- Frontend: `apps/web/src/App.tsx`
- Backend: `apps/server/src/index.ts`
- Host controller: `apps/scripts/mc-server-lifecycle.mjs`

Current behavior:

- Lists lifecycle state from `/api/server-lifecycle`.
- Creates servers through `/api/server-lifecycle/create`.
- Archives active servers through `/api/servers/:name/archive`.
- Restores archives through `/api/server-lifecycle/archives/:id/restore`.
- Deletes archives through `DELETE /api/server-lifecycle/archives/:id`.
- Shows max active slot count, active count, slots available, archive count, and lifecycle-controller setup errors.
- The host lifecycle controller currently allows only `paper` and `vanilla` at create time.

Migration requirement:

- The concept Fleet Home and Archive Library are good layout targets.
- Keep lifecycle unavailable/setup messaging.
- In create forms, limit editions to `paper` and `vanilla` until the lifecycle script supports Fabric/Forge creation. Fabric/Forge can still be offered in Change Version for an existing server because the agent version manager supports those.
- Preserve the hard cap of three live servers.

### Server overview and operations

Current source:

- Frontend: `apps/web/src/App.tsx`
- Backend: `/api/servers`, `/start`, `/stop`, `/restart`, `/logs`, `/tps`, `/check-public`, `/backup`, `/command`

Current behavior:

- Lists server status, edition, Minecraft version, memory, CPU, player counts, MOTD, TPS, public reachability, LAN address, public join address, and player invite text.
- Starts, stops, restarts, backs up, and archives a server.
- Polls server list every 10 seconds.
- Polls logs every 5 seconds for the selected workspace server.
- Runs RCON commands from the settings console tab.

Migration requirement:

- Move these features into the concept workspace header and Overview tab.
- Keep the selected-server log polling behavior. Do not regress to the old first-server log stream.
- Preserve public reachability checks and player invite copy, not just raw internal address display.
- Keep start/stop/restart disabled/error states explicit.

### Network and player join guidance

Current source:

- Frontend: `apps/web/src/lib/minecraft.ts`, `apps/web/src/App.tsx`
- Backend: `PATCH /api/servers/:name/config`

Current behavior:

- Stores and edits `host_ip`, `public_domain`, `public_port`, and `host_proxy_port`.
- Computes public join address with no `:25565` suffix when the public port is default.
- Computes LAN join address from host IP/proxy port where available.
- Shows router/LXD proxy guidance and a player invite.

Migration requirement:

- The concept Settings page only edits `public_domain` and `public_port`; this is incomplete.
- Preserve `host_ip` and `host_proxy_port`.
- Preserve both LAN and public address display/copy.
- Keep route-test feedback from `/api/servers/:name/check-public`.

### Settings, players, bans, and JVM

Current source:

- Frontend: `apps/web/src/App.tsx`
- Backend: `/api/servers/:name/settings`, `/settings/whitelist/*`, `/settings/operators/*`, `/settings/bans/*`, `/jvm/settings`

Current behavior:

- Edits server properties: `motd`, `max-players`, `gamemode`, `difficulty`, `pvp`, `spawn-protection`, `view-distance`, `online-mode`, `allow-flight`, `white-list`, and `enforce-whitelist`.
- Manages whitelist and operators.
- Manages player bans and IP bans, each with optional reasons.
- Edits JVM Xms, Xmx, unit, GC, and custom flags.
- Saves selected recommended plugins after settings save.

Migration requirement:

- The concept Players tab is a good replacement for hiding whitelist/operators/bans inside one large dialog, but it must add IP bans and optional reason fields.
- Keep whitelist enable/disable in Settings, not only the whitelist membership list.
- Keep all current server.properties controls. The concept Settings page omits `gamemode`, `pvp`, `spawn-protection`, `view-distance`, `online-mode`, and `allow-flight`.
- Keep JVM controls.
- Replace concept `alert` feedback with toasts and inline errors.
- Avoid third-party player avatar calls by default. The concept uses Crafatar images; that adds external requests for player UUIDs and is not required for the product workflow.

### Content, mods, plugins, and modpacks

Current source:

- Frontend: `apps/web/src/components/ModBrowser.tsx`, `ModsManagementPanel.tsx`, `InstalledModCard.tsx`, `ModConfigEditor.tsx`, `ConfigFieldRenderer.tsx`, `ModpackExport.tsx`
- Backend: `/api/mods/*`, `/api/servers/:name/mods/*`, `/api/servers/:name/plugins`, `/api/servers/:name/plugins/installed`, `/api/servers/:name/plugins/:fileName/toggle`, `/api/servers/:name/plugins/recommended`, `/public/:name/modpack*`

Current behavior:

- For Paper/Purpur/Spigot: browse/install Modrinth plugins, upload plugin JARs, list installed plugins from the real `plugins/` directory, enable/disable plugins, remove plugins, and install recommended plugins.
- For Fabric/Forge/NeoForge: browse/search/filter Modrinth mods, show recommended mods, show compatible versions, estimate resource impact, check dependencies, install dependencies, upload mod JARs, list installed mods, filter installed mods, enable/disable mods, remove mods with optional config removal, edit mod config files, copy client setup guide, and export/share modpacks.
- Public modpack endpoints provide a player download page, `.mrpack`, and text mod list.

Migration requirement:

- Keep the existing `ModBrowser`, `ModsManagementPanel`, `ModConfigEditor`, and `ModpackExport` behavior. The concept Content tab is visually simpler but loses too much.
- If the concept Content tab becomes the new shell, embed the existing rich mod components inside it rather than replacing them.
- For plugin servers, use the real plugin inventory endpoints added during migration. Do not back plugin inventory with `/mods/manifest`.
- Encode `fileName`, `modId`, and `configFileName` path parameters. The concept API wrapper currently interpolates raw file names.
- Preserve public modpack sharing and client setup guidance.

### Worlds

Current source:

- Frontend: `apps/web/src/App.tsx`
- Backend gateway: `/api/servers/:name/worlds`, `/api/servers/:name/worlds/details`, `/api/servers/:name/worlds/switch`, `/api/servers/:name/worlds/upload`, `/api/servers/:name/worlds/generate`, `DELETE /api/servers/:name/worlds/:worldName`, `/api/servers/:name/worlds/:worldName/backup`, `/api/servers/:name/worlds/:worldName/download`
- Agent enhanced endpoints: `/worlds/list`, `/worlds/current`, `/worlds/generate`, `/worlds/switch-to`, `DELETE /worlds/:worldName`, `/worlds/:worldName/backup`, `/worlds/import`, `/worlds/:worldName/export`

Current behavior:

- Uploads a world zip and activates it.
- Lists worlds with active status, size, and last-played metadata when the enhanced agent endpoint is available.
- Switches active world through `/worlds/switch`.
- Generates real worlds by having Minecraft create `level.dat`, with optional seed and world type.
- Deletes inactive worlds after the agent creates a safety backup.
- Creates per-world backups and exports/downloads world zip files.

Concept behavior:

- Adds generate world, delete world, backup world, and download world UI.
- Those gateway and agent endpoints are now implemented rather than copied as mock-only controls.

Migration requirement:

- The concept Worlds tab is now migrated with real gateway and agent support for generate, delete, backup, and download/export.
- Keep the active-world delete guard. Active worlds must be switched before deletion.
- Keep encoding and validating world names on both gateway and agent paths.

### Help and guided tour

Current source:

- Frontend: `apps/web/src/App.tsx`

Current behavior:

- Has a Help dialog and first-run guided tour covering fleet, controls, addresses, settings, versioning, world upload, console, and documentation.

Concept behavior:

- No equivalent help/tour surface.

Migration requirement:

- Either preserve the tour/help content in the new layout or intentionally replace it with route-level help. Dropping it silently is a regression.

## Backend to UI Coverage Matrix

This table is the contract for the migration. The UI can be redesigned freely, but it should not add controls without backing routes, and it should not hide supported operations that are useful to an operator.

| Backend capability | Real routes/source | Current/intended UI surface | Migration decision |
| --- | --- | --- | --- |
| Auth config, session, token login, passkey login/register, setup-code inventory, passkey revoke, logout | `/api/auth/config`, `/api/auth/session`, `/api/auth/token/login`, `/api/auth/passkeys/*`, `/api/auth/logout`; `apps/web/src/lib/auth.ts`, `apps/web/src/lib/passkeys.ts` | Admin access gate and security/admin panel | Keep full WebAuthn helper flow and HttpOnly cookie session semantics. No preview bypass or localStorage admin token. |
| Fleet inventory and per-server status | `/api/servers` | Fleet Home, sidebar server list, workspace header | Keep as the primary source for live status, edition/version, memory, CPU, player counts, join metadata, and unreachable state. |
| Active server lifecycle: create, archive, restore, delete archive, max active slots | `/api/server-lifecycle`, `/api/server-lifecycle/create`, `/api/servers/:name/archive`, `/api/server-lifecycle/archives/:id/restore`, `DELETE /api/server-lifecycle/archives/:id`; `apps/scripts/mc-server-lifecycle.mjs` | Fleet Home and Archive Library | Keep concept fleet/archive workflow. Create remains Paper/Vanilla only until lifecycle creation supports more editions. Preserve controller-unavailable messaging and three-active-server cap. |
| Manual server registry operations | `/api/servers/register`, `DELETE /api/servers/:name/unregister` | Not a primary end-user surface | Do not make these prominent in the new UI. They remain setup/admin escape hatches unless a deliberate operator workflow is requested. |
| Server lifecycle operations | `/api/servers/:name/start`, `/stop`, `/restart`, `/backup` | Workspace header actions and Overview quick actions | Keep selected-server actions only. Surface in-progress/error feedback through toasts or inline status. |
| Logs, TPS, RCON command console | `/api/servers/:name/logs`, `/tps`, `/command` | Overview terminal/metrics | Keep selected-server polling, tolerate unavailable TPS without fake `20.00`, and keep command execution tied to real RCON route. |
| Public route check and join guidance | `/api/servers/:name/check-public`; `apps/web/src/lib/minecraft.ts` | Overview network/uplink panel and Settings network panel | Preserve public and LAN join address computation, default-port formatting, route-test result, and router/LXD guidance. |
| Server registry network config | `PATCH /api/servers/:name/config` | Settings network panel | Keep `host_ip`, `host_proxy_port`, `public_domain`, and `public_port`; the concept only exposed part of this. |
| Server properties | `/api/servers/:name/settings` | Settings gameplay/server properties | Keep all existing fields: MOTD, max players, gamemode, difficulty, PVP, spawn protection, view distance, online mode, allow flight, whitelist, and enforce whitelist. |
| Whitelist and operators | `/api/servers/:name/settings/whitelist/*`, `/settings/operators/*` | Players tab plus Settings whitelist toggle | Keep list/add/remove flows and keep whitelist enabled/enforced settings visible. |
| Player bans and IP bans | `/api/servers/:name/settings/bans`, `/settings/bans/player/*`, `/settings/bans/ip/*` | Players tab/security section | Keep both player and IP bans with optional reasons. The concept only covered part of this. |
| JVM runtime settings | `/api/servers/:name/jvm/settings` | Settings runtime panel | Keep Xms/Xmx values and units, GC selection, and custom flags. |
| Version and loader changes | `/api/servers/:name/version/change`; agent `/version/change`, `/version/switch-type`, version list helpers | Settings engine/version panel | Keep Paper/Vanilla/Fabric/Forge/NeoForge version-switch controls for existing servers where the agent supports them. Do not confuse this with lifecycle create support. |
| Plugin upload/list/toggle/delete/recommended install | `/api/servers/:name/plugins`, `/plugins/installed`, `/plugins/:fileName/toggle`, `DELETE /plugins/:fileName`, `/plugins/recommended` | Content tab for Paper/Purpur/Spigot-style servers | Keep real plugin inventory. Never back plugins with the mod manifest. Encode file names. |
| Modrinth browse, compatibility, dependencies, mod install | `/api/mods/search`, `/api/mods/:projectId`, `/versions`, `/check-compatibility`, `/check-dependencies`, `/api/servers/:name/mods/install` | Content tab for modded loaders | Keep the existing rich ModBrowser behavior inside the redesigned shell. |
| Mod upload/list/toggle/delete/metadata/icon/config editing | `/api/servers/:name/mods`, `/mods/installed`, `/mods/:fileName/*`, `/mods/:modId/configs`, `/mods/:modId/config/:fileName` | Content tab installed-mod management | Keep filtering, enable/disable, remove-with-config option, metadata, icons, and dynamic config editor. Encode path parameters. |
| Modpack export and public player share | `/api/servers/:name/modpack`, `/modpack/export/mrpack`, `/modpack/export/list`, `/modpack/page`, `/public/:name/modpack*` | Player Share route and Content share/export controls | Keep backend-generated public modpack page, `.mrpack`, and text list. The UI route can wrap or link to these routes. |
| World list/details/switch/upload/generate/delete/backup/download | `/api/servers/:name/worlds`, `/worlds/details`, `/worlds/switch`, `/worlds/upload`, `/worlds/generate`, `DELETE /worlds/:worldName`, `/worlds/:worldName/backup`, `/worlds/:worldName/download` | Worlds tab | Keep all controls because gateway and agent support are real. Active worlds remain delete-protected. Encode world names. |
| Packwiz and LuckPerms convenience installers | `/api/servers/:name/packwiz`, `/api/servers/:name/luckperms` | Content/settings convenience actions or recommended-plugin flow | Do not invent broad package-management UI around these. Expose only as concrete install actions if the surrounding workflow is clear. |
| Help and first-run tour | Frontend-only `apps/web/src/App.tsx` | Help/tour or route-level help | Preserve intentionally or replace intentionally. Silent removal is a regression. |

## Concept UI Elements Worth Migrating

- `src/App.tsx`: route structure with protected routes and a dedicated public player route.
- `src/components/Layout.tsx`: persistent sidebar and separate main scroll area.
- `src/pages/FleetHome.tsx`: fleet overview, empty slots, create flow, recent archives.
- `src/pages/ArchiveLibrary.tsx`: archive-focused restore/delete flow.
- `src/pages/ServerWorkspace.tsx`: per-server header, action bar, tabbed workspace routing.
- `src/pages/workspace/Overview.tsx`: health/public access/console split.
- `src/pages/workspace/Players.tsx`: move player/security management into a dedicated workspace tab.
- `src/pages/workspace/Settings.tsx`: card-based sections for network, properties, JVM, and engine version, after restoring missing fields.
- `src/pages/workspace/Worlds.tsx`: separate Worlds workspace tab, after gating unsupported actions.
- `src/pages/PlayerShare.tsx`: route-level player share page, preferably as a wrapper or redirect to the backend-generated public modpack page.

## Concept UI Elements to Avoid or Rework

- `server.ts`: mock-only; do not merge into this project.
- `@google/genai` and AI Studio metadata: unrelated to MC LXD Manager.
- React 19, React Router 7, Tailwind 4, `motion`, `zustand`, and `swr` should not be imported automatically. Adopt only after checking the current workspace and build impact.
- Auth token in `localStorage`: do not migrate.
- Passkey shortcut in `AdminAccess.tsx`: do not migrate; it is not WebAuthn.
- `window.alert`, `window.confirm`, `window.prompt`: replace with production dialogs/toasts.
- Crafatar avatar images in Players: avoid by default.
- Fabric/Forge server create options: hide until lifecycle creation supports them.
- World generate/delete/backup/download controls: keep enabled because real gateway and agent routes now exist.
- Installed plugin list backed by `/mods/manifest`: still inaccurate; use `/plugins/installed`.
- Raw path interpolation for file/world names: encode and validate.

## API Contract Mismatches

| Concept call | Current real status | Migration action |
| --- | --- | --- |
| `/api/auth/passkeys/register/options` treated as successful registration | Real flow returns WebAuthn creation options; registration is completed by `navigator.credentials.create` and `/api/auth/passkeys/register/verify` | Reuse `apps/web/src/lib/passkeys.ts` |
| Local `Authorization: Bearer ${localStorage.adminToken}` on every request | Real default is cookie session; bearer token works only when token auth is enabled | Use cookie session and token-login exchange only |
| Create server editions `paper`, `vanilla`, `fabric`, `forge` | Lifecycle script currently accepts only `paper` and `vanilla` | Limit create UI or extend lifecycle first |
| `/api/servers/:name/worlds/generate` | Implemented in gateway and agent | Generate real worlds through Minecraft startup |
| `DELETE /api/servers/:name/worlds/:world_name` | Implemented in gateway and proxied to `DELETE /worlds/:worldName` | Use only for inactive worlds |
| `/api/servers/:name/worlds/:world_name/backup` | Implemented in gateway and proxied to `/worlds/:worldName/backup` | Show backup path in toast |
| `/api/servers/:name/worlds/:world_name/download` | Implemented in gateway and proxied to `/worlds/:worldName/export` | Stream zip download |
| `/api/servers/:name/mods/manifest` used as generic installed content | Existing manifest is mod-oriented, not a plugin inventory | Use `/api/servers/:name/plugins/installed` for plugins |
| `/api/servers/:name/mods/:fileName` with raw `fileName` | Real route requires safe path segment and current UI encodes it | Encode path segments |
| Player bans only | Current UI also supports IP bans | Add IP ban section |

## Reference Mock Behavior Excluded from Implementation

- Forced authenticated state in `lxc-mc-ui/src/store/auth.ts`.
- Preview passkey bypass token in `AdminAccess.tsx`.
- LocalStorage bearer-token state as the normal admin session.
- Fake TPS fallback values such as `20.00` when `/tps` is unavailable.
- Raw string interpolation for server, file, mod, config, archive, or world path parameters.
- External Google Fonts and external player avatar calls in the protected operator UI.
- `window.alert`, `window.confirm`, and `window.prompt` as normal production feedback.
- New dependency stack migration to React Router 7, SWR, Zustand, Motion, React 19, or Tailwind 4 without a separate compatibility decision.
- Fabric/Forge lifecycle create options before `apps/scripts/mc-server-lifecycle.mjs` supports them.

## Suggested Migration Plan

1. Establish a shared typed API client in `apps/web/src` using the current backend contracts, cookie session semantics, and encoded path helpers.
2. Introduce the route shell under the existing React/Vite stack: Fleet Home, Archive Library, Server Workspace, Admin Access, and optional Player Share route.
3. Move current auth UI logic into the concept-style Admin Access page without changing WebAuthn behavior.
4. Move fleet lifecycle behavior into Fleet Home and Archive Library, keeping paper/vanilla create options and lifecycle-unavailable messaging.
5. Move per-server operations into Workspace Overview: header actions, public/LAN connection cards, route test, selected-server logs, RCON, backup, and archive.
6. Move current settings into the Settings and Players tabs, preserving all current property fields, whitelist toggle, operators, player bans, IP bans, and JVM settings.
7. Build Content around the existing rich Modrinth/mod management components; use the concept page as layout only.
8. Keep the Worlds tab feature-complete: list/details, switch, upload, generate, delete inactive worlds, backup, and download/export are now backed by gateway and agent routes.
9. Preserve or replace Help/Tour intentionally.
10. Expand Playwright coverage with route-aware e2e tests for fleet create/archive/restore, settings save, player lists/bans, selected-server logs/RCON, mod install/export, and world upload/switch.

## Regression Checklist

- Signed-out root route renders public running servers only, with no management controls.
- Auth-gated `/api/servers` `401` keeps admin inventory hidden from non-admins.
- Passkey login and passkey registration work over HTTPS/localhost.
- Setup-code registration consumes one-time codes and does not delete existing passkeys.
- Token fallback appears only when `ADMIN_AUTH_METHODS` includes token.
- Fleet count, max slots, archive count, create, archive, restore, and delete archive work.
- Lifecycle unconfigured state is visible and blocks lifecycle actions.
- Server cards/workspaces show status, version, edition, memory, CPU, players, TPS, public route status, LAN address, and public join address.
- Start, stop, restart, backup, archive, and refresh act on the selected server.
- Logs and RCON act on the selected server.
- Network settings include host IP, public domain, public port, and host proxy port.
- Player invite copy handles default port 25565 correctly.
- Server properties include all current fields.
- Whitelist membership and whitelist enabled state are both controllable.
- Operators can be added and removed.
- Player bans and IP bans both support add/remove with optional reason.
- JVM Xms/Xmx units, GC, and custom flags save.
- Paper/Purpur/Spigot servers can browse/install/upload/list/toggle/remove plugins.
- Fabric/Forge/NeoForge servers can browse/search/filter/install mods with dependency and compatibility handling.
- Installed mods can be searched, filtered, enabled/disabled, removed with optional configs, and configured.
- Client setup guide, public modpack page, `.mrpack`, and mod list downloads still work.
- World list, switch, upload, generate, delete, backup, and export/download work.
- Help/tour functionality is intentionally preserved or replaced.

## Verification Notes

`e2e/mod-management.spec.ts` has been updated to cover the migrated route-level surfaces that currently exist: auth-gated server inventory, content/plugin management, worlds generate/delete/backup/download, and the Overview TPS-unavailable regression path. More coverage is still needed for full parity across passkeys, lifecycle archive/restore, settings, player access, bans, RCON, and public player-share flows.
