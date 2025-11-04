# Mod Management System Architecture

## Overview
Native mod browser, installer, and compatibility checker integrated into the Minecraft Server Control UI.

## Features

### 1. Mod Browser
- Search mods from Modrinth API (primary) and CurseForge (secondary)
- Filter by:
  - Minecraft version (matches server version)
  - Mod loader (Forge, Fabric, NeoForge)
  - Category (optimization, decoration, gameplay, etc.)
  - Performance impact (client, server, both)
  - Popularity (downloads, last updated)
- Display:
  - Mod name, description, author
  - Download count, last updated
  - Compatible versions
  - Dependencies
  - Performance impact indicators
  - Resource usage warnings

### 2. Compatibility Checking
- **Version Compatibility**: Auto-filter by server MC version and loader
- **Dependency Resolution**: Show required and optional dependencies
- **Conflict Detection**: Known incompatibilities between mods
- **Resource Usage**: Warn about memory-intensive mods
- **Server vs Client**: Indicate server-side, client-side, or both

### 3. Resource Usage Warnings
Categorize mods by impact:
- **Light**: < 100MB RAM, minimal CPU (optimization mods)
- **Medium**: 100-300MB RAM, moderate CPU (gameplay mods)
- **Heavy**: > 300MB RAM, high CPU (world gen, large content mods)

Check against server configuration:
- < 4GB RAM: Light mods only
- 4-8GB RAM: Light + Medium mods
- > 8GB RAM: All mods (with warnings for Heavy)

### 4. Installation Flow
1. User selects mod from browser
2. System checks:
   - Version compatibility
   - Dependency requirements
   - Resource availability
   - Existing mod conflicts
3. Display warnings/errors or confirm install
4. Download mod from Modrinth/CurseForge
5. Upload to server via existing API
6. Update installed mods list
7. Prompt server restart if needed

## API Integration

### Modrinth API (Primary)
**Base URL**: `https://api.modrinth.com/v2`

**Search Endpoint**:
```
GET /search?query={term}&facets=[["project_type:mod"],["versions:{mc_version}"],["categories:{loader}"]]
```

**Project Details**:
```
GET /project/{id}
```

**Version List**:
```
GET /project/{id}/version
```

**Download**:
```
GET /version/{version_id}/download
```

**Rate Limit**: 300 requests/minute
**Required**: User-Agent header

### CurseForge API (Secondary/Fallback)
**Base URL**: `https://api.curseforge.com/v1`
**Requires**: API Key (less permissive than Modrinth)

## Data Structures

### ModInfo
```typescript
interface ModInfo {
  id: string;
  name: string;
  slug: string;
  description: string;
  author: string;
  categories: string[];
  downloads: number;
  follows: number;
  lastUpdated: Date;

  // Compatibility
  supportedVersions: string[];
  loaders: ('forge' | 'fabric' | 'neoforge')[];
  clientSide: 'required' | 'optional' | 'unsupported';
  serverSide: 'required' | 'optional' | 'unsupported';

  // Dependencies
  dependencies: {
    id: string;
    type: 'required' | 'optional' | 'incompatible';
  }[];

  // Resource usage
  resourceImpact: 'light' | 'medium' | 'heavy';
  estimatedMemory: number; // MB

  // Download info
  latestVersion: {
    id: string;
    name: string;
    downloadUrl: string;
    fileSize: number;
  };
}
```

### InstalledMod
```typescript
interface InstalledMod {
  id: string;
  name: string;
  version: string;
  fileName: string;
  installedAt: Date;
  enabled: boolean;
}
```

## UI Components

### 1. Mod Browser Dialog
- Search bar with filters
- Grid/list view of mods
- Mod detail panel (right sidebar)
- Install/Remove buttons
- Compatibility badges

### 2. Installed Mods Panel
- List of currently installed mods
- Enable/Disable toggles
- Update available indicators
- Remove button
- Total resource usage display

### 3. Compatibility Warnings
- Yellow warning for heavy resource usage
- Red error for incompatibilities
- Blue info for dependencies
- Green success for verified compatibility

## Implementation Phases

### Phase 1: Modrinth API Integration (Current)
- [ ] Create Modrinth API service
- [ ] Search endpoint with facets
- [ ] Mod details fetching
- [ ] Version filtering

### Phase 2: Mod Browser UI
- [ ] Search and filter interface
- [ ] Mod card components
- [ ] Detail view with dependencies
- [ ] Install button with checks

### Phase 3: Compatibility System
- [ ] Version matching
- [ ] Dependency resolution
- [ ] Conflict detection database
- [ ] Resource usage calculator

### Phase 4: Installation & Management
- [ ] Download from Modrinth
- [ ] Upload to server
- [ ] Track installed mods
- [ ] Enable/disable functionality
- [ ] Update checking

## Known Mod Conflicts Database

### Optimization Mods (Generally Compatible)
- Sodium + Lithium + Phosphor (Fabric) - Safe
- OptiFine (standalone) - May conflict with Sodium

### World Generation
- Biomes O' Plenty + Terralith - Incompatible
- Terralith + William Wythers' Overhauled Overworld - Compatible

### Performance Impact Categories

**Heavy Mods** (> 300MB RAM):
- Large worldgen mods (Biomes O' Plenty, Twilight Forest)
- Tech mods with automation (Create, Applied Energistics)
- Large content packs

**Medium Mods** (100-300MB):
- Gameplay additions (Farmer's Delight, Ice and Fire)
- Decoration mods (Macaw's series)
- Small tech mods

**Light Mods** (< 100MB):
- Optimization mods (Sodium, Lithium, Starlight)
- QoL mods (JEI, AppleSkin, Waystones)
- Small tweaks

## Security Considerations
- Only download from verified sources (Modrinth, CurseForge)
- Verify file hashes when available
- Scan for known malicious mods
- User confirmation for all installations
- No automatic execution of mod code

## Future Enhancements
- Modpack support (import from Modrinth)
- One-click modpack installation
- Server-wide mod sync for clients
- Performance profiling of installed mods
- Automatic dependency installation
- Mod update notifications
