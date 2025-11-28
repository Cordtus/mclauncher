/**
 * Modrinth API Service
 * Handles mod searching, filtering, and metadata retrieval
 */

const MODRINTH_API_BASE = 'https://api.modrinth.com/v2';
const USER_AGENT = 'cordtus/mclauncher/1.0.0 (minecraft server manager)';

export interface ModrinthSearchResult {
  hits: ModrinthMod[];
  offset: number;
  limit: number;
  total_hits: number;
}

export interface ModrinthMod {
  slug: string;
  title: string;
  description: string;
  categories: string[];
  client_side: 'required' | 'optional' | 'unsupported';
  server_side: 'required' | 'optional' | 'unsupported';
  project_type: string;
  downloads: number;
  follows: number;
  icon_url?: string;
  date_created: string;
  date_modified: string;
  latest_version: string;
  license: string;
  gallery?: string[];
  author: string;
  versions: string[]; // Supported MC versions
  project_id: string;
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  changelog?: string;
  dependencies: ModrinthDependency[];
  game_versions: string[];
  loaders: string[];
  files: ModrinthFile[];
  date_published: string;
  downloads: number;
}

export interface ModrinthDependency {
  project_id: string;
  dependency_type: 'required' | 'optional' | 'incompatible';
}

export interface ModrinthFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  file_type?: string;
}

export interface ModSearchParams {
  query: string;
  mcVersion?: string;
  loader?: 'forge' | 'fabric' | 'neoforge' | 'paper' | 'bukkit' | 'spigot' | 'purpur' | 'folia';
  projectType?: 'mod' | 'plugin';
  category?: string;
  limit?: number;
  offset?: number;
  sort?: 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated';
}

export interface ModCompatibilityInfo {
  compatible: boolean;
  warnings: string[];
  resourceImpact: 'light' | 'medium' | 'heavy';
  estimatedMemoryMB: number;
}

/**
 * Search for mods or plugins on Modrinth
 */
export async function searchMods(params: ModSearchParams): Promise<ModrinthSearchResult> {
  const facets: string[][] = [
    [`project_type:${params.projectType || 'mod'}`]
  ];

  // Filter by Minecraft version
  if (params.mcVersion) {
    facets.push([`versions:${params.mcVersion}`]);
  }

  // Filter by mod loader
  if (params.loader) {
    facets.push([`categories:${params.loader}`]);
  }

  // Filter by category
  if (params.category) {
    facets.push([`categories:${params.category}`]);
  }

  const url = new URL(`${MODRINTH_API_BASE}/search`);
  url.searchParams.set('query', params.query || '');
  url.searchParams.set('facets', JSON.stringify(facets));
  url.searchParams.set('limit', (params.limit || 20).toString());
  url.searchParams.set('offset', (params.offset || 0).toString());
  url.searchParams.set('index', params.sort || 'relevance');

  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Modrinth API error: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Get detailed information about a specific mod
 */
export async function getModDetails(projectId: string): Promise<ModrinthMod> {
  const response = await fetch(`${MODRINTH_API_BASE}/project/${projectId}`, {
    headers: {
      'User-Agent': USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Modrinth API error: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Get versions for a specific mod
 */
export async function getModVersions(
  projectId: string,
  mcVersion?: string,
  loader?: string
): Promise<ModrinthVersion[]> {
  const url = new URL(`${MODRINTH_API_BASE}/project/${projectId}/version`);

  if (mcVersion) {
    url.searchParams.set('game_versions', JSON.stringify([mcVersion]));
  }

  if (loader) {
    url.searchParams.set('loaders', JSON.stringify([loader]));
  }

  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Modrinth API error: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Download a mod file
 */
export async function downloadMod(downloadUrl: string): Promise<Buffer> {
  const response = await fetch(downloadUrl, {
    headers: {
      'User-Agent': USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download mod: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Estimate resource impact based on mod categories and metadata
 */
export function estimateResourceImpact(mod: ModrinthMod): ModCompatibilityInfo {
  const warnings: string[] = [];
  let resourceImpact: 'light' | 'medium' | 'heavy' = 'light';
  let estimatedMemoryMB = 50; // Base estimate

  // Heavy categories (world generation, large content mods)
  const heavyCategories = [
    'worldgen',
    'world-generation',
    'biomes',
    'dimensions',
    'technology',
    'magic',
    'adventure'
  ];

  // Medium categories (gameplay additions)
  const mediumCategories = [
    'decoration',
    'food',
    'mobs',
    'equipment',
    'storage',
    'farming'
  ];

  // Light categories (optimization, utilities)
  const lightCategories = [
    'optimization',
    'utility',
    'library',
    'minimap',
    'hud'
  ];

  // Check categories
  const hasHeavyCategory = mod.categories.some(cat =>
    heavyCategories.includes(cat.toLowerCase())
  );
  const hasMediumCategory = mod.categories.some(cat =>
    mediumCategories.includes(cat.toLowerCase())
  );

  if (hasHeavyCategory) {
    resourceImpact = 'heavy';
    estimatedMemoryMB = 400;
    warnings.push('This mod may significantly impact server performance');
    warnings.push('Recommended for servers with 8GB+ RAM');
  } else if (hasMediumCategory) {
    resourceImpact = 'medium';
    estimatedMemoryMB = 200;
    warnings.push('This mod has moderate resource usage');
  } else {
    resourceImpact = 'light';
    estimatedMemoryMB = 50;
  }

  // Check if server-side is required
  if (mod.server_side === 'unsupported') {
    warnings.push('This mod is client-side only and cannot be installed on the server');
  }

  // Check if client-side is required
  if (mod.client_side === 'required' && mod.server_side === 'optional') {
    warnings.push('Players must install this mod to connect to the server');
  }

  return {
    compatible: mod.server_side !== 'unsupported',
    warnings,
    resourceImpact,
    estimatedMemoryMB
  };
}

/**
 * Check for known mod conflicts
 */
export function checkModConflicts(
  newModId: string,
  newModCategories: string[],
  installedMods: string[]
): string[] {
  const conflicts: string[] = [];

  // Known conflict database
  const knownConflicts: Record<string, string[]> = {
    'sodium': ['optifine'], // Sodium conflicts with OptiFine
    'optifine': ['sodium', 'iris'], // OptiFine conflicts with Sodium/Iris
    'terralith': ['biomes-o-plenty', 'bop'], // Terralith conflicts with Biomes O' Plenty
    'biomes-o-plenty': ['terralith'],
    'create': ['immersive-engineering'], // Sometimes conflict
  };

  const newModSlug = newModId.toLowerCase();

  // Check direct conflicts
  if (knownConflicts[newModSlug]) {
    const conflictingMods = knownConflicts[newModSlug].filter(conflictMod =>
      installedMods.some(installed => installed.toLowerCase().includes(conflictMod))
    );

    if (conflictingMods.length > 0) {
      conflicts.push(`May conflict with installed mods: ${conflictingMods.join(', ')}`);
    }
  }

  // Check category-based potential conflicts
  if (newModCategories.includes('optimization') && installedMods.length > 0) {
    conflicts.push('Multiple optimization mods may cause issues - test thoroughly');
  }

  return conflicts;
}

/**
 * Check if server has enough resources for a mod
 */
export function checkResourceAvailability(
  serverMemoryMB: number,
  modImpact: ModCompatibilityInfo,
  currentModsMemoryUsage: number
): { sufficient: boolean; warning?: string } {
  const totalMemoryNeeded = currentModsMemoryUsage + modImpact.estimatedMemoryMB;
  const availableMemory = serverMemoryMB * 0.7; // Reserve 30% for Minecraft itself

  if (totalMemoryNeeded > availableMemory) {
    return {
      sufficient: false,
      warning: `Insufficient memory. This mod needs ~${modImpact.estimatedMemoryMB}MB, but only ${Math.floor(availableMemory - currentModsMemoryUsage)}MB available.`
    };
  }

  if (modImpact.resourceImpact === 'heavy' && serverMemoryMB < 8192) {
    return {
      sufficient: true,
      warning: 'Server has less than 8GB RAM. This heavy mod may cause performance issues.'
    };
  }

  return { sufficient: true };
}

/**
 * Dependency information for a mod
 */
export interface DependencyInfo {
  projectId: string;
  versionId?: string;
  dependencyType: 'required' | 'optional' | 'incompatible' | 'embedded';
  projectName?: string;
  projectSlug?: string;
  downloadUrl?: string;
  fileName?: string;
}

/**
 * Get dependencies for a specific mod version
 */
export async function getModDependencies(
  versionId: string,
  mcVersion: string,
  loader: string,
  installedModIds: string[] = []
): Promise<{
  required: DependencyInfo[];
  optional: DependencyInfo[];
  incompatible: DependencyInfo[];
}> {
  try {
    // Get version details
    const response = await fetch(`${MODRINTH_API_BASE}/version/${versionId}`, {
      headers: { 'User-Agent': USER_AGENT }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch version: ${response.statusText}`);
    }

    const version = await response.json() as ModrinthVersion;

    const required: DependencyInfo[] = [];
    const optional: DependencyInfo[] = [];
    const incompatible: DependencyInfo[] = [];

    // Process each dependency
    for (const dep of version.dependencies || []) {
      // Skip if already installed
      if (installedModIds.includes(dep.project_id)) {
        continue;
      }

      const depInfo: DependencyInfo = {
        projectId: dep.project_id,
        dependencyType: dep.dependency_type,
      };

      // Get project details for name and slug
      try {
        const projectRes = await fetch(`${MODRINTH_API_BASE}/project/${dep.project_id}`, {
          headers: { 'User-Agent': USER_AGENT }
        });

        if (projectRes.ok) {
          const project = await projectRes.json();
          depInfo.projectName = project.title;
          depInfo.projectSlug = project.slug;

          // Get compatible version
          const versions = await getModVersions(dep.project_id, mcVersion, loader);
          if (versions.length > 0) {
            const compatVersion = versions[0];
            depInfo.versionId = compatVersion.id;
            const primaryFile = compatVersion.files.find((f) => f.primary) || compatVersion.files[0];
            if (primaryFile) {
              depInfo.downloadUrl = primaryFile.url;
              depInfo.fileName = primaryFile.filename;
            }
          }
        }
      } catch (err) {
        console.warn(`Failed to get details for dependency ${dep.project_id}:`, err);
      }

      // Categorize by type
      switch (dep.dependency_type) {
        case 'required':
          required.push(depInfo);
          break;
        case 'optional':
          optional.push(depInfo);
          break;
        case 'incompatible':
          incompatible.push(depInfo);
          break;
      }
    }

    return { required, optional, incompatible };
  } catch (err) {
    console.error('Failed to get mod dependencies:', err);
    return { required: [], optional: [], incompatible: [] };
  }
}

/**
 * Get multiple projects by their IDs
 */
export async function getMultipleProjects(projectIds: string[]): Promise<ModrinthMod[]> {
  if (projectIds.length === 0) return [];

  const response = await fetch(
    `${MODRINTH_API_BASE}/projects?ids=${JSON.stringify(projectIds)}`,
    { headers: { 'User-Agent': USER_AGENT } }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch projects: ${response.statusText}`);
  }

  return await response.json();
}
