/**
 * Modpack Export Service
 * Generates modpack files that players can import into their launchers
 * Supports: Modrinth .mrpack format (widely supported by Prism, ATLauncher, etc.)
 */

import JSZip from 'jszip';
import * as modrinth from './modrinth.js';

export interface InstalledModInfo {
  fileName: string;
  modId: string;
  name: string;
  version: string;
  description?: string;
  authors?: string[];
  loader: string;
  enabled: boolean;
  // These are stored when installing from Modrinth
  modrinthProjectId?: string;
  modrinthVersionId?: string;
}

export interface ModpackMetadata {
  name: string;
  summary: string;
  versionId: string;
  mcVersion: string;
  loader: 'forge' | 'fabric' | 'neoforge' | 'quilt';
  loaderVersion?: string;
}

export interface ModpackFile {
  path: string;
  hashes: {
    sha1: string;
    sha512: string;
  };
  env?: {
    client: 'required' | 'optional' | 'unsupported';
    server: 'required' | 'optional' | 'unsupported';
  };
  downloads: string[];
  fileSize: number;
}

export interface ModrinthPackIndex {
  formatVersion: 1;
  game: 'minecraft';
  versionId: string;
  name: string;
  summary?: string;
  files: ModpackFile[];
  dependencies: {
    minecraft: string;
    [loader: string]: string;
  };
}

/**
 * Try to find Modrinth project info for an installed mod by searching
 */
export async function findModrinthProject(
  modName: string,
  modId: string,
  mcVersion: string,
  loader: string
): Promise<{ projectId: string; versionId: string; file: modrinth.ModrinthFile } | null> {
  try {
    // Search for the mod on Modrinth
    const results = await modrinth.searchMods({
      query: modName,
      mcVersion,
      loader: loader as any,
      limit: 5,
    });

    if (!results.hits || results.hits.length === 0) {
      return null;
    }

    // Try to find exact match by mod ID or name
    const exactMatch = results.hits.find(
      (hit) => hit.slug.toLowerCase() === modId.toLowerCase() ||
               hit.title.toLowerCase() === modName.toLowerCase()
    );

    const mod = exactMatch || results.hits[0];

    // Get versions for this mod
    const versions = await modrinth.getModVersions(mod.project_id, mcVersion, loader);

    if (!versions || versions.length === 0) {
      return null;
    }

    // Get the first compatible version
    const version = versions[0];
    const primaryFile = version.files.find((f) => f.primary) || version.files[0];

    return {
      projectId: mod.project_id,
      versionId: version.id,
      file: primaryFile,
    };
  } catch (err) {
    console.error(`Failed to find Modrinth project for ${modName}:`, err);
    return null;
  }
}

/**
 * Generate a Modrinth modpack (.mrpack) from installed mods
 * Format spec: https://docs.modrinth.com/docs/modpacks/format_definition/
 */
export async function generateMrpack(
  metadata: ModpackMetadata,
  installedMods: InstalledModInfo[]
): Promise<{ buffer: Buffer; unmatchedMods: string[] }> {
  const files: ModpackFile[] = [];
  const unmatchedMods: string[] = [];

  // Only include enabled mods
  const enabledMods = installedMods.filter((mod) => mod.enabled);

  // Try to resolve each mod to its Modrinth project
  for (const mod of enabledMods) {
    // If we already have Modrinth info stored
    if (mod.modrinthProjectId && mod.modrinthVersionId) {
      try {
        const versions = await modrinth.getModVersions(mod.modrinthProjectId);
        const version = versions.find((v) => v.id === mod.modrinthVersionId);

        if (version) {
          const file = version.files.find((f) => f.primary) || version.files[0];
          files.push({
            path: `mods/${file.filename}`,
            hashes: {
              sha1: '', // Would need to compute or get from Modrinth
              sha512: '',
            },
            downloads: [file.url],
            fileSize: file.size,
          });
          continue;
        }
      } catch (err) {
        console.warn(`Failed to fetch stored Modrinth info for ${mod.name}`);
      }
    }

    // Try to find the mod on Modrinth
    const modrinthInfo = await findModrinthProject(
      mod.name,
      mod.modId,
      metadata.mcVersion,
      metadata.loader
    );

    if (modrinthInfo) {
      files.push({
        path: `mods/${modrinthInfo.file.filename}`,
        hashes: {
          sha1: '',
          sha512: '',
        },
        downloads: [modrinthInfo.file.url],
        fileSize: modrinthInfo.file.size,
      });
    } else {
      // Mod not found on Modrinth - will need manual download
      unmatchedMods.push(mod.name);
    }
  }

  // Create the modrinth.index.json
  const index: ModrinthPackIndex = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: metadata.versionId,
    name: metadata.name,
    summary: metadata.summary,
    files,
    dependencies: {
      minecraft: metadata.mcVersion,
      [metadata.loader]: metadata.loaderVersion || '*',
    },
  };

  // Create the ZIP archive
  const zip = new JSZip();
  zip.file('modrinth.index.json', JSON.stringify(index, null, 2));

  // Add overrides folder (empty for now, could add config files later)
  zip.folder('overrides');

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  return { buffer, unmatchedMods };
}

/**
 * Generate a simple mod list for manual installation
 */
export function generateModList(
  metadata: ModpackMetadata,
  installedMods: InstalledModInfo[]
): string {
  const enabledMods = installedMods.filter((mod) => mod.enabled);

  let output = `# ${metadata.name} Mod List\n\n`;
  output += `**Minecraft Version:** ${metadata.mcVersion}\n`;
  output += `**Mod Loader:** ${metadata.loader}\n`;
  output += `**Total Mods:** ${enabledMods.length}\n\n`;
  output += `## Required Mods\n\n`;

  for (const mod of enabledMods) {
    output += `- **${mod.name}** v${mod.version}`;
    if (mod.description) {
      output += ` - ${mod.description}`;
    }
    output += '\n';
  }

  output += `\n## Installation Instructions\n\n`;
  output += `1. Install ${metadata.loader} for Minecraft ${metadata.mcVersion}\n`;
  output += `2. Download all mods listed above from Modrinth or CurseForge\n`;
  output += `3. Place the .jar files in your mods folder\n`;
  output += `4. Launch Minecraft with the ${metadata.loader} profile\n`;

  return output;
}

/**
 * Generate HTML page for mod downloads
 */
export async function generateDownloadPage(
  serverName: string,
  serverAddress: string,
  metadata: ModpackMetadata,
  installedMods: InstalledModInfo[]
): Promise<string> {
  const enabledMods = installedMods.filter((mod) => mod.enabled);

  // Try to find Modrinth links for each mod
  const modLinks: Array<{
    name: string;
    version: string;
    description?: string;
    modrinthUrl?: string;
    clientRequired: boolean;
  }> = [];

  for (const mod of enabledMods) {
    let modrinthUrl: string | undefined;
    let clientRequired = true;

    if (mod.modrinthProjectId) {
      try {
        const details = await modrinth.getModDetails(mod.modrinthProjectId);
        modrinthUrl = `https://modrinth.com/mod/${details.slug}`;
        clientRequired = details.client_side === 'required';
      } catch (err) {
        // Ignore
      }
    }

    if (!modrinthUrl) {
      // Try to find on Modrinth by searching
      try {
        const results = await modrinth.searchMods({
          query: mod.name,
          mcVersion: metadata.mcVersion,
          loader: metadata.loader as any,
          limit: 1,
        });

        if (results.hits && results.hits.length > 0) {
          const hit = results.hits[0];
          modrinthUrl = `https://modrinth.com/mod/${hit.slug}`;
          clientRequired = hit.client_side === 'required';
        }
      } catch (err) {
        // Ignore
      }
    }

    modLinks.push({
      name: mod.name,
      version: mod.version,
      description: mod.description,
      modrinthUrl,
      clientRequired,
    });
  }

  // Sort: client-required first, then by name
  modLinks.sort((a, b) => {
    if (a.clientRequired !== b.clientRequired) {
      return a.clientRequired ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const requiredMods = modLinks.filter((m) => m.clientRequired);
  const optionalMods = modLinks.filter((m) => !m.clientRequired);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${serverName} - Mod Pack</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --card-bg: #16213e;
      --accent: #0f3460;
      --highlight: #e94560;
      --text: #eaeaea;
      --text-muted: #a0a0a0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2rem;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    header {
      text-align: center;
      margin-bottom: 3rem;
    }
    h1 {
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
    }
    .subtitle {
      color: var(--text-muted);
      font-size: 1.1rem;
    }
    .server-info {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 2rem;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
    }
    .info-item {
      text-align: center;
    }
    .info-label {
      color: var(--text-muted);
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .info-value {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--highlight);
    }
    .download-section {
      background: var(--accent);
      border-radius: 12px;
      padding: 2rem;
      text-align: center;
      margin-bottom: 2rem;
    }
    .download-btn {
      display: inline-block;
      background: var(--highlight);
      color: white;
      padding: 1rem 2rem;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      font-size: 1.1rem;
      margin: 0.5rem;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .download-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(233, 69, 96, 0.4);
    }
    .download-btn.secondary {
      background: var(--card-bg);
    }
    h2 {
      font-size: 1.5rem;
      margin: 2rem 0 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid var(--accent);
    }
    .mod-list {
      display: grid;
      gap: 0.75rem;
    }
    .mod-card {
      background: var(--card-bg);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }
    .mod-info {
      flex: 1;
    }
    .mod-name {
      font-weight: 600;
    }
    .mod-version {
      color: var(--text-muted);
      font-size: 0.85rem;
    }
    .mod-desc {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin-top: 0.25rem;
    }
    .mod-link {
      background: var(--accent);
      color: var(--text);
      padding: 0.5rem 1rem;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.9rem;
      white-space: nowrap;
      transition: background 0.2s;
    }
    .mod-link:hover {
      background: var(--highlight);
    }
    .instructions {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 2rem;
      margin-top: 2rem;
    }
    .instructions ol {
      margin-left: 1.5rem;
    }
    .instructions li {
      margin-bottom: 0.75rem;
    }
    .instructions code {
      background: var(--accent);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-family: monospace;
    }
    .badge {
      display: inline-block;
      background: var(--highlight);
      color: white;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-left: 0.5rem;
    }
    .badge.optional {
      background: var(--accent);
    }
    footer {
      text-align: center;
      margin-top: 3rem;
      color: var(--text-muted);
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${serverName}</h1>
      <p class="subtitle">Download and install the mod pack to join our server</p>
    </header>

    <div class="server-info">
      <div class="info-item">
        <div class="info-label">Server Address</div>
        <div class="info-value">${serverAddress}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Minecraft Version</div>
        <div class="info-value">${metadata.mcVersion}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Mod Loader</div>
        <div class="info-value">${metadata.loader}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Total Mods</div>
        <div class="info-value">${enabledMods.length}</div>
      </div>
    </div>

    <div class="download-section">
      <h2 style="border: none; margin: 0 0 1rem;">Quick Install</h2>
      <p style="margin-bottom: 1rem; color: var(--text-muted);">
        Download the modpack and import it into your launcher
      </p>
      <a href="modpack.mrpack" class="download-btn">Download Modpack (.mrpack)</a>
      <a href="modlist.txt" class="download-btn secondary">Download Mod List</a>
    </div>

    ${requiredMods.length > 0 ? `
    <h2>Required Mods <span class="badge">${requiredMods.length}</span></h2>
    <p style="color: var(--text-muted); margin-bottom: 1rem;">
      You must install these mods to connect to the server
    </p>
    <div class="mod-list">
      ${requiredMods.map((mod) => `
        <div class="mod-card">
          <div class="mod-info">
            <div class="mod-name">${mod.name} <span class="mod-version">v${mod.version}</span></div>
            ${mod.description ? `<div class="mod-desc">${mod.description}</div>` : ''}
          </div>
          ${mod.modrinthUrl ? `<a href="${mod.modrinthUrl}" target="_blank" class="mod-link">Modrinth</a>` : ''}
        </div>
      `).join('')}
    </div>
    ` : ''}

    ${optionalMods.length > 0 ? `
    <h2>Server-Side Only <span class="badge optional">${optionalMods.length}</span></h2>
    <p style="color: var(--text-muted); margin-bottom: 1rem;">
      These mods run on the server only - you don't need to install them
    </p>
    <div class="mod-list">
      ${optionalMods.map((mod) => `
        <div class="mod-card">
          <div class="mod-info">
            <div class="mod-name">${mod.name} <span class="mod-version">v${mod.version}</span></div>
            ${mod.description ? `<div class="mod-desc">${mod.description}</div>` : ''}
          </div>
          ${mod.modrinthUrl ? `<a href="${mod.modrinthUrl}" target="_blank" class="mod-link">Modrinth</a>` : ''}
        </div>
      `).join('')}
    </div>
    ` : ''}

    <div class="instructions">
      <h2 style="margin-top: 0;">Installation Instructions</h2>
      <ol>
        <li>Download and install <a href="https://prismlauncher.org/" target="_blank" style="color: var(--highlight);">Prism Launcher</a> (recommended) or your preferred Minecraft launcher</li>
        <li>Click the <strong>Download Modpack</strong> button above</li>
        <li>In Prism Launcher: <code>Add Instance</code> → <code>Import</code> → Select the downloaded .mrpack file</li>
        <li>Launch the instance and connect to <code>${serverAddress}</code></li>
      </ol>
      <p style="margin-top: 1rem; color: var(--text-muted);">
        <strong>Alternative:</strong> If using a different launcher, download each mod from the list above and place them in your mods folder.
      </p>
    </div>

    <footer>
      <p>Generated by MC LXD Manager</p>
    </footer>
  </div>
</body>
</html>`;
}
