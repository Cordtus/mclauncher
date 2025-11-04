# Advanced Mod Management System Architecture

## Overview

Enhanced mod management with visual mod library, automatic configuration parsing, and dynamic settings UI generation.

## Features

### 1. Tabbed Configuration Interface

**Two Main Tabs:**
- **Base/Server Config**: Existing server settings (network, properties, gameplay, security, plugins, admins)
- **Mod Management**: New comprehensive mod management interface

### 2. Installed Mods Library

**Visual Mod Cards:**
- Mod icon/artwork (from Modrinth API)
- Mod name and version
- Description
- Resource impact badge (light/medium/heavy)
- Enabled/Disabled toggle
- Update available indicator
- Configure button (opens dynamic settings UI)
- Remove button

**Actions:**
- Enable/disable individual mods (renames .jar to .jar.disabled)
- Update to latest compatible version
- Remove mod and configs
- Configure mod settings

### 3. Mod Config File Parser

**Supported Formats:**
- TOML (.toml) - Most common for Forge/NeoForge mods
- JSON (.json, .json5) - Common for Fabric mods
- YAML (.yml, .yaml) - Some mods use this
- Properties (.properties) - Legacy format

**Parser Features:**
- Recursively scan mod config directories
- Identify config files by mod ID/name
- Parse config structure and comments
- Extract default values and types
- Preserve formatting and comments on save

**Config File Locations:**
- Forge/NeoForge: `/config/{modid}.toml`, `/config/{modid}/`
- Fabric: `/config/{modid}.json`, `/config/{modid}/`
- Common: `/config/` directory in Minecraft root

### 4. Dynamic Settings UI Generator

**UI Component Types:**
- **Boolean**: Toggle switch
- **Number**: Number input with min/max validation
- **String**: Text input
- **Enum/Choice**: Dropdown select
- **List**: Array input with add/remove
- **Section**: Collapsible groups

**Features:**
- Auto-generate form from config structure
- Preserve comments as help text/tooltips
- Validation based on type and constraints
- Real-time preview of changes
- Save/revert functionality

**Example TOML Config:**
```toml
# Server-side settings
[server]
    # Maximum number of entities per chunk
    # Range: 1 ~ 1000
    # Default: 50
    maxEntitiesPerChunk = 50

    # Enable advanced entity AI
    # Default: true
    advancedAI = true

    # Difficulty multiplier
    # Range: 0.5 ~ 5.0
    # Default: 1.0
    difficultyMultiplier = 1.0
```

**Generated UI:**
```
Server Settings
├─ Max Entities Per Chunk: [50] (Number: 1-1000)
│  ℹ Maximum number of entities per chunk
├─ Advanced AI: [✓] (Toggle)
│  ℹ Enable advanced entity AI
└─ Difficulty Multiplier: [1.0] (Number: 0.5-5.0)
   ℹ Difficulty multiplier
```

### 5. Mod Update System

**Update Flow:**
1. Check Modrinth for newer versions compatible with MC version
2. Display "Update Available" badge on mod card
3. On update click:
   - Download new version
   - Stop server
   - Remove old .jar file
   - Install new .jar file
   - Preserve all config files
   - Start server
   - Show changelog/release notes

**Version Management:**
- Track installed mod versions in registry
- Compare with Modrinth latest version
- Support manual version selection (in case latest breaks)

### 6. Backend Additions

**New Agent Endpoints:**
```typescript
// List installed mods with metadata
GET /mods/list
Response: {
  mods: [{
    fileName: string,
    modId: string,
    name: string,
    version: string,
    enabled: boolean,
    configFiles: string[]
  }]
}

// Read mod config file
GET /mods/:modId/config/:fileName
Response: { content: string, format: 'toml' | 'json' | 'yaml' | 'properties' }

// Update mod config file
POST /mods/:modId/config/:fileName
Body: { content: string }

// Enable/disable mod
PATCH /mods/:fileName/toggle
Body: { enabled: boolean }

// Remove mod completely
DELETE /mods/:fileName?removeConfigs=true

// Get mod metadata from JAR
GET /mods/:fileName/metadata
Response: { modId, name, version, description, authors, etc }
```

**Config Parser Library:**
- Install TOML parser: `@iarna/toml` or `toml`
- JSON5 parser: `json5`
- YAML parser: `js-yaml`
- Properties parser: `properties-reader`

**Mod Metadata Extraction:**
- Parse `META-INF/mods.toml` (Forge/NeoForge)
- Parse `fabric.mod.json` (Fabric)
- Extract: modId, name, version, description, authors, icon

### 7. UI Components

**New Components to Create:**

1. **ModsManagementPanel.tsx**
   - Main container for mod management tab
   - Lists installed mods
   - Shows mod browser integration

2. **InstalledModCard.tsx**
   - Visual card for each installed mod
   - Icon, name, version, status
   - Enable/disable, configure, update, remove actions

3. **ModConfigEditor.tsx**
   - Dynamic form generator
   - Parses config structure
   - Renders appropriate input types
   - Handles save/revert

4. **ConfigFieldRenderer.tsx**
   - Renders individual config fields
   - Switches on field type
   - Shows validation and help text

## Implementation Phases

### Phase 1: Backend Config Infrastructure
- [ ] Install config parser libraries (TOML, JSON5, YAML, properties)
- [ ] Create JAR metadata extractor
- [ ] Add agent endpoints for config file operations
- [ ] Add agent endpoint for listing installed mods with metadata
- [ ] Add enable/disable mod functionality

### Phase 2: Installed Mods UI
- [ ] Create tabbed interface (Base vs Mods)
- [ ] Build InstalledModCard component
- [ ] Integrate with agent to list mods
- [ ] Add enable/disable toggle
- [ ] Add remove mod functionality

### Phase 3: Config Parsing & UI Generation
- [ ] Create config file parser service
- [ ] Build ModConfigEditor component
- [ ] Implement field type detection and rendering
- [ ] Add save/revert functionality
- [ ] Test with real mod configs

### Phase 4: Update System
- [ ] Check for mod updates via Modrinth
- [ ] Show update badges
- [ ] Implement safe update flow
- [ ] Show changelogs
- [ ] Test update process

### Phase 5: Polish & Integration
- [ ] Add search/filter for installed mods
- [ ] Add bulk enable/disable
- [ ] Add config templates/presets
- [ ] Performance optimization
- [ ] Error handling and validation
- [ ] Documentation

## Data Structures

### Installed Mod Registry
```typescript
interface InstalledMod {
  fileName: string;           // sodium-fabric-0.5.8.jar
  modId: string;              // sodium
  name: string;               // Sodium
  version: string;            // 0.5.8
  mcVersions: string[];       // ["1.20.1", "1.20.2"]
  loader: string;             // fabric, forge, neoforge
  enabled: boolean;           // true
  modrinthId?: string;        // AANobbMI (if from Modrinth)
  iconUrl?: string;           // https://cdn.modrinth.com/...
  description?: string;       // Modern rendering engine
  authors: string[];          // ["JellySquid"]
  configFiles: ConfigFile[];  // List of config files
  installedDate: string;      // ISO timestamp
}

interface ConfigFile {
  path: string;               // config/sodium-options.json
  format: 'toml' | 'json' | 'yaml' | 'properties';
  lastModified: string;       // ISO timestamp
}
```

### Parsed Config Structure
```typescript
interface ConfigSchema {
  sections: ConfigSection[];
}

interface ConfigSection {
  name: string;
  description?: string;
  fields: ConfigField[];
}

interface ConfigField {
  key: string;
  type: 'boolean' | 'number' | 'string' | 'enum' | 'list';
  value: any;
  defaultValue: any;
  description?: string;
  constraints?: {
    min?: number;
    max?: number;
    options?: string[];  // for enum
    pattern?: string;    // regex for string
  };
}
```

## Security Considerations

1. **Config File Validation**: Ensure modified configs are valid before saving
2. **Path Traversal**: Validate config file paths to prevent directory traversal
3. **JAR File Handling**: Only read metadata, never execute JAR code on backend
4. **Server Restart**: Require admin token for mod enable/disable/remove
5. **Config Backup**: Auto-backup configs before modifications

## User Experience

### Typical Workflow

1. User navigates to Server Settings → Mods tab
2. Sees list of installed mods with icons and status
3. Clicks "Configure" on a mod (e.g., Sodium)
4. Dynamic settings UI appears with all Sodium options
5. User changes "Max FPS" from 260 to 144
6. Clicks "Save" → config file updated
7. System prompts "Restart server to apply changes?"
8. User clicks "Update" on Create mod
9. System downloads latest version, removes old, installs new
10. Server restarts automatically, new version active

## Technical Notes

### JAR Metadata Extraction

Use Java to read JAR manifests:
```javascript
// Using unzipper or yauzl library
const metadata = await extractModMetadata('/opt/minecraft/mods/sodium.jar');
// Reads META-INF/mods.toml or fabric.mod.json
```

### Config File Watching

Option to watch config files for external changes and reload UI.

### Conflict Detection

Warn if two mods modify the same config section or have known incompatibilities.
