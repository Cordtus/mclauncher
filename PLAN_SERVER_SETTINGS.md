# Plan: Server Settings Backend Integration

## Problem Statement
The Server Settings dialog in the frontend (App.tsx:1439-1447) has TODO comments indicating the backend integration is incomplete. Settings are saved to localStorage but never applied to the actual server.

## Current State
- **Frontend**: Complete UI with 6 tabs (Network, Properties, Gameplay, Security, Plugins, Admins)
- **Frontend State**: Comprehensive `serverSettings` object tracking all settings
- **Backend**: Basic `/config` endpoint exists but only accepts raw text, not structured JSON
- **Missing**: Structured API to update server.properties, whitelist.json, ops.json

## Architecture Decision
Create a new structured endpoint `/settings` that:
1. Accepts JSON settings object
2. Updates server.properties using key-value pairs (preserving comments)
3. Manages whitelist.json and ops.json
4. Optionally restarts server
5. Returns updated state

## Implementation Plan

### Phase 1: Backend - Agent Endpoints (apps/agent/src/index.ts)

#### 1.1 Add Structured Settings Endpoint
```typescript
POST /settings
Body: {
  properties: { [key: string]: string | number | boolean },
  whitelist?: string[],
  operators?: string[],
  restart?: boolean
}
Response: { success: true, message: string }
```

#### 1.2 Create Properties Parser/Writer Utility
- Read server.properties line by line
- Update only specified keys, preserve comments
- Handle different data types (boolean, number, string)
- Write back to file maintaining format

#### 1.3 Whitelist Management
- Read/write `/opt/minecraft/whitelist.json`
- Format: `[{ "uuid": "...", "name": "..." }]`
- Need to resolve UUID from username (use Mojang API)
- Enable whitelist in server.properties if not empty

#### 1.4 Operators Management
- Read/write `/opt/minecraft/ops.json`
- Format: `[{ "uuid": "...", "name": "...", "level": 4 }]`
- Need to resolve UUID from username (use Mojang API)

#### 1.5 Add Helper Endpoints
```typescript
GET /settings/whitelist - Get current whitelist
POST /settings/whitelist/add - Add player to whitelist
POST /settings/whitelist/remove - Remove player from whitelist
GET /settings/operators - Get current operators
POST /settings/operators/add - Add operator
POST /settings/operators/remove - Remove operator
```

### Phase 2: Backend - Mojang API Integration

#### 2.1 Create UUID Resolution Service
```typescript
// apps/agent/src/services/mojang.ts
async function resolveUsername(username: string): Promise<{ uuid: string, name: string }>
```
- Use Mojang API: `https://api.mojang.com/users/profiles/minecraft/{username}`
- Handle rate limiting (10 requests/minute)
- Cache results temporarily
- Return proper error for invalid usernames

### Phase 3: Backend - Gateway Proxy (apps/server/src/index.ts)

#### 3.1 Add Proxy Routes
```typescript
POST /api/servers/:name/settings -> proxyToAgent(agentUrl, '/settings')
GET /api/servers/:name/settings/whitelist -> proxyToAgent(agentUrl, '/settings/whitelist')
POST /api/servers/:name/settings/whitelist/add -> proxyToAgent(agentUrl, '/settings/whitelist/add')
// ... etc
```

### Phase 4: Frontend Integration (apps/web/src/App.tsx)

#### 4.1 Update Save Button Handler
```typescript
const handleSaveSettings = async (serverName: string) => {
  setIsSavingSettings(true);
  try {
    // Map frontend state to backend format
    const payload = {
      properties: {
        'motd': serverSettings.motd,
        'max-players': serverSettings.maxPlayers,
        'gamemode': serverSettings.gamemode,
        'difficulty': serverSettings.difficulty,
        'pvp': serverSettings.pvp,
        'spawn-protection': serverSettings.spawnProtection,
        'view-distance': serverSettings.viewDistance,
        'online-mode': serverSettings.onlineMode,
        'allow-flight': serverSettings.allowFlight,
        'enforce-whitelist': serverSettings.enforceWhitelist,
      },
      whitelist: serverSettings.whitelist,
      operators: serverSettings.operators,
      restart: true
    };

    const response = await fetch(`${apiUrl}/servers/${serverName}/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(await response.text());

    toast.success('Settings applied successfully');
    setServerSettingsDialog(false);
    await loadServers(); // Refresh
  } catch (err) {
    toast.error(`Failed to save settings: ${err.message}`);
  } finally {
    setIsSavingSettings(false);
  }
};
```

#### 4.2 Add Loading State
- Add `isSavingSettings` state variable
- Disable buttons during save
- Show spinner in Save button

#### 4.3 Add Whitelist/Operators Management UI
- "Add Player" button with validation
- List of current players with remove button
- UUID resolution feedback
- Error handling for invalid usernames

### Phase 5: Testing

#### 5.1 Unit Tests
- Test properties parser (preserves comments, handles types)
- Test UUID resolution (valid/invalid usernames, rate limiting)
- Test whitelist/ops JSON read/write

#### 5.2 Integration Tests
- Test full flow: frontend -> gateway -> agent -> files
- Test server restart after settings change
- Test error handling (invalid settings, missing files)

#### 5.3 Manual Testing
- Apply settings and verify server.properties updated
- Add player to whitelist and verify file + in-game
- Add operator and verify file + in-game permissions
- Test with server running and stopped

## Data Mappings

### Frontend to server.properties
```
serverSettings.motd -> server.properties: motd
serverSettings.maxPlayers -> server.properties: max-players
serverSettings.gamemode -> server.properties: gamemode
serverSettings.difficulty -> server.properties: difficulty
serverSettings.pvp -> server.properties: pvp
serverSettings.spawnProtection -> server.properties: spawn-protection
serverSettings.viewDistance -> server.properties: view-distance
serverSettings.onlineMode -> server.properties: online-mode
serverSettings.allowFlight -> server.properties: allow-flight
serverSettings.enforceWhitelist -> server.properties: enforce-whitelist
```

### Whitelist Format
```json
[
  {
    "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    "name": "Notch"
  }
]
```

### Operators Format
```json
[
  {
    "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    "name": "Notch",
    "level": 4,
    "bypassesPlayerLimit": false
  }
]
```

## Error Handling

### Backend Errors
- Invalid property key/value -> 400 Bad Request
- Username not found (Mojang API) -> 404 Not Found
- Rate limit exceeded -> 429 Too Many Requests
- File write failed -> 500 Internal Server Error
- Server restart failed -> 500 Internal Server Error

### Frontend Errors
- Show toast notifications for all errors
- Parse error message from response
- Keep dialog open on error (allow retry)

## Security Considerations
- All endpoints require admin token (already implemented via requireAdmin middleware)
- Validate property keys against known set
- Sanitize string values (prevent injection)
- Limit array sizes (whitelist/operators)

## Rollback Strategy
- Keep backup of server.properties before modification
- On error, restore from backup
- Log all changes for audit trail

## Success Criteria
- ✅ Can update server properties from UI
- ✅ Changes reflected in server.properties file
- ✅ Server restarts automatically after save
- ✅ Can add/remove whitelist players
- ✅ Can add/remove operators
- ✅ UUID resolution works correctly
- ✅ Proper error messages for invalid inputs
- ✅ No loss of comments in server.properties
- ✅ All settings persist across server restarts

## Estimated Complexity
- **Lines of Code**: ~400-500 lines total
  - Agent endpoints: ~200 lines
  - Mojang service: ~50 lines
  - Properties parser: ~100 lines
  - Frontend integration: ~100 lines
  - Tests: ~100 lines
- **Time**: 3-4 hours
- **Risk**: Low (isolated feature, clear requirements)
