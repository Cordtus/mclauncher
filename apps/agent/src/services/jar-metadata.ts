import yauzl from 'yauzl';
import * as TOML from 'toml';

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
