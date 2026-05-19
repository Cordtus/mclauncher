import yauzl from 'yauzl';
import * as TOML from 'toml';
import * as yaml from 'js-yaml';

export interface ModMetadata {
  modId: string;
  name: string;
  version: string;
  description?: string;
  authors?: string[];
  loader: 'forge' | 'neoforge' | 'fabric' | 'unknown';
  mcVersions?: string[];
  iconPath?: string;
}

export interface PluginMetadata {
  pluginId: string;
  name: string;
  version: string;
  description?: string;
  authors?: string[];
  main?: string;
  apiVersion?: string;
  dependencies?: string[];
  softDependencies?: string[];
}

/**
 * Extract mod metadata from JAR file
 * Reads META-INF/mods.toml (Forge/NeoForge) or fabric.mod.json (Fabric)
 */
export async function extractModMetadata(jarPath: string): Promise<ModMetadata | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(jarPath, { lazyEntries: true }, (err, zipFile) => {
      if (err) {
        reject(err);
        return;
      }
      if (!zipFile) {
        resolve(null);
        return;
      }

      let resolved = false;
      zipFile.readEntry();

      zipFile.on('entry', (entry: yauzl.Entry) => {
        if (resolved) return;

        // Check for Forge/NeoForge metadata
        if (entry.fileName === 'META-INF/mods.toml') {
          zipFile.openReadStream(entry, (err, readStream) => {
            if (err) {
              zipFile.readEntry();
              return;
            }

            const chunks: Buffer[] = [];
            readStream.on('data', (chunk) => chunks.push(chunk));
            readStream.on('end', () => {
              try {
                const content = Buffer.concat(chunks).toString('utf8');
                const metadata = parseForgeMetadata(content);
                resolved = true;
                zipFile.close();
                resolve(metadata);
              } catch (e) {
                zipFile.readEntry();
              }
            });
          });
        }
        // Check for Fabric metadata
        else if (entry.fileName === 'fabric.mod.json') {
          zipFile.openReadStream(entry, (err, readStream) => {
            if (err) {
              zipFile.readEntry();
              return;
            }

            const chunks: Buffer[] = [];
            readStream.on('data', (chunk) => chunks.push(chunk));
            readStream.on('end', () => {
              try {
                const content = Buffer.concat(chunks).toString('utf8');
                const metadata = parseFabricMetadata(content);
                resolved = true;
                zipFile.close();
                resolve(metadata);
              } catch (e) {
                zipFile.readEntry();
              }
            });
          });
        }
        // Look for icon
        else if (entry.fileName.match(/^(icon|logo)\.(png|jpg|jpeg)$/i)) {
          // Icon found, but we'll handle this separately
          zipFile.readEntry();
        }
        else {
          zipFile.readEntry();
        }
      });

      zipFile.on('end', () => {
        if (!resolved) {
          resolve(null);
        }
      });

      zipFile.on('error', (err) => {
        reject(err);
      });
    });
  });
}

/**
 * Extract Bukkit/Paper plugin metadata from plugin.yml or paper-plugin.yml.
 */
export async function extractPluginMetadata(jarPath: string): Promise<PluginMetadata | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(jarPath, { lazyEntries: true }, (err, zipFile) => {
      if (err) {
        reject(err);
        return;
      }
      if (!zipFile) {
        resolve(null);
        return;
      }

      let resolved = false;
      zipFile.readEntry();

      zipFile.on('entry', (entry: yauzl.Entry) => {
        if (resolved) return;

        if (entry.fileName === 'plugin.yml' || entry.fileName === 'paper-plugin.yml') {
          zipFile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr) {
              zipFile.readEntry();
              return;
            }

            const chunks: Buffer[] = [];
            readStream.on('data', (chunk) => chunks.push(chunk));
            readStream.on('end', () => {
              try {
                const content = Buffer.concat(chunks).toString('utf8');
                const metadata = parsePluginMetadata(content);
                resolved = true;
                zipFile.close();
                resolve(metadata);
              } catch {
                zipFile.readEntry();
              }
            });
          });
        } else {
          zipFile.readEntry();
        }
      });

      zipFile.on('end', () => {
        if (!resolved) {
          resolve(null);
        }
      });

      zipFile.on('error', (zipErr) => {
        reject(zipErr);
      });
    });
  });
}

function parsePluginMetadata(yamlContent: string): PluginMetadata {
  const parsed = yaml.load(yamlContent) as Record<string, any> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Plugin metadata is empty');
  }

  const name = String(parsed.name || '').trim();
  if (!name) {
    throw new Error('Plugin metadata is missing name');
  }

  return {
    pluginId: String(parsed.name || name).toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
    name,
    version: String(parsed.version || 'unknown'),
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    authors: normalizeStringList(parsed.authors || parsed.author),
    main: typeof parsed.main === 'string' ? parsed.main : undefined,
    apiVersion: typeof parsed['api-version'] === 'string' ? parsed['api-version'] : undefined,
    dependencies: normalizeStringList(parsed.depend),
    softDependencies: normalizeStringList(parsed.softdepend),
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).filter(Boolean);
  }
  return [String(value)].filter(Boolean);
}

function parseForgeMetadata(tomlContent: string): ModMetadata {
  const parsed = TOML.parse(tomlContent);

  // mods.toml format:
  // [[mods]]
  //   modId="sodium"
  //   version="0.5.8"
  //   displayName="Sodium"
  //   description="Modern rendering engine"
  //   authors="JellySquid"

  const mods = parsed.mods as any[];
  if (!mods || mods.length === 0) {
    throw new Error('No mods found in mods.toml');
  }

  const mod = mods[0]; // Take first mod in file

  return {
    modId: mod.modId || 'unknown',
    name: mod.displayName || mod.modId || 'Unknown Mod',
    version: mod.version || '0.0.0',
    description: mod.description,
    authors: mod.authors ? (Array.isArray(mod.authors) ? mod.authors : [mod.authors]) : [],
    loader: parsed.loaderVersion ? 'neoforge' : 'forge',
    mcVersions: [], // Would need to parse dependencies
  };
}

function parseFabricMetadata(jsonContent: string): ModMetadata {
  const parsed = JSON.parse(jsonContent);

  // fabric.mod.json format:
  // {
  //   "id": "sodium",
  //   "version": "0.5.8",
  //   "name": "Sodium",
  //   "description": "Modern rendering engine",
  //   "authors": ["JellySquid"],
  //   "depends": {
  //     "minecraft": ">=1.20"
  //   }
  // }

  const mcVersions: string[] = [];
  if (parsed.depends && parsed.depends.minecraft) {
    // Parse Minecraft version from dependency string
    // This is a simplification - real parsing would be more complex
    const mcDep = parsed.depends.minecraft;
    mcVersions.push(mcDep.replace(/[><=]/g, '').trim());
  }

  return {
    modId: parsed.id || 'unknown',
    name: parsed.name || parsed.id || 'Unknown Mod',
    version: parsed.version || '0.0.0',
    description: parsed.description,
    authors: Array.isArray(parsed.authors) ? parsed.authors : (parsed.authors ? [parsed.authors] : []),
    loader: 'fabric',
    mcVersions,
    iconPath: parsed.icon,
  };
}

/**
 * Extract icon image from JAR file
 */
export async function extractModIcon(jarPath: string, iconPath?: string): Promise<Buffer | null> {
  if (!iconPath) {
    // Try common icon paths
    iconPath = 'icon.png';
  }

  return new Promise((resolve, reject) => {
    yauzl.open(jarPath, { lazyEntries: true }, (err, zipFile) => {
      if (err) {
        reject(err);
        return;
      }
      if (!zipFile) {
        resolve(null);
        return;
      }

      let resolved = false;
      zipFile.readEntry();

      zipFile.on('entry', (entry: yauzl.Entry) => {
        if (resolved) return;

        if (entry.fileName === iconPath || entry.fileName.match(/^(icon|logo)\.(png|jpg|jpeg)$/i)) {
          zipFile.openReadStream(entry, (err, readStream) => {
            if (err) {
              zipFile.readEntry();
              return;
            }

            const chunks: Buffer[] = [];
            readStream.on('data', (chunk) => chunks.push(chunk));
            readStream.on('end', () => {
              resolved = true;
              zipFile.close();
              resolve(Buffer.concat(chunks));
            });
          });
        } else {
          zipFile.readEntry();
        }
      });

      zipFile.on('end', () => {
        if (!resolved) {
          resolve(null);
        }
      });

      zipFile.on('error', (err) => {
        reject(err);
      });
    });
  });
}
