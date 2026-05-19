import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import os from "os";
import { updateProperties } from "../services/properties-parser.js";

type CommandRunner = typeof execFileSync;

export interface WorldInfo {
  name: string;
  size: number;
  lastPlayed: Date;
  isActive: boolean;
}

export interface GenerateWorldInput {
  name: string;
  seed?: string;
  levelType?: string;
}

export interface WorldManagerOptions {
  execFileSync?: CommandRunner;
  generationTimeoutMs?: number;
  generationPollMs?: number;
}

function assertSafePathSegment(value: string, label: string) {
  if (
    !value ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".." ||
    value.includes("..")
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertSafePropertyValue(value: string, label: string) {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`Invalid ${label}`);
  }
}

function normalizeLevelType(value: string | undefined) {
  const normalized = (value || "default").trim().toLowerCase();
  const aliases: Record<string, string> = {
    default: "minecraft:normal",
    normal: "minecraft:normal",
    flat: "minecraft:flat",
    large_biomes: "minecraft:large_biomes",
    amplified: "minecraft:amplified",
    single_biome_surface: "minecraft:single_biome_surface",
  };
  const levelType = aliases[normalized] || normalized;
  if (!/^[a-z0-9_:-]+$/.test(levelType)) {
    throw new Error("Invalid levelType");
  }
  return levelType;
}

function safeChildPath(root: string, ...segments: string[]) {
  for (const segment of segments) {
    assertSafePathSegment(segment, "path segment");
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Invalid path");
  }

  return resolvedPath;
}

function assertSafeZipEntries(zipPath: string) {
  const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  for (const rawEntry of listing.split(/\r?\n/)) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (entry.startsWith("/") || entry.startsWith("\\") || entry.includes("..") || entry.includes("\\")) {
      throw new Error("ZIP contains unsafe entry paths");
    }
  }

  const types = execFileSync("unzip", ["-Z", "-l", zipPath], { encoding: "utf8" });
  for (const rawLine of types.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Archive:") || line.startsWith("Zip file") || /^\d+\s+files?,/.test(line)) {
      continue;
    }
    const mode = line.split(/\s+/)[0];
    if (mode && mode[0] !== "-" && mode[0] !== "d") {
      throw new Error("ZIP contains unsafe entry types");
    }
  }

  execFileSync("unzip", ["-tq", zipPath], { encoding: "utf8" });
}

export class WorldManager {
  private readonly worldsHome: string;
  private readonly worldLink: string;
  private readonly execFileSync: CommandRunner;
  private readonly generationTimeoutMs: number;
  private readonly generationPollMs: number;

  constructor(private mcDir: string = "/opt/minecraft", options: WorldManagerOptions = {}) {
    this.worldsHome = path.join(mcDir, "worlds");
    this.worldLink = path.join(mcDir, "world");
    this.execFileSync = options.execFileSync || execFileSync;
    this.generationTimeoutMs = options.generationTimeoutMs ?? Number(process.env.WORLD_GENERATION_TIMEOUT_MS || 120_000);
    this.generationPollMs = options.generationPollMs ?? Number(process.env.WORLD_GENERATION_POLL_MS || 1000);
  }

  async initialize(): Promise<void> {
    fs.mkdirSync(this.worldsHome, { recursive: true });

    if (fs.existsSync(this.worldLink)) {
      const stats = fs.lstatSync(this.worldLink);

      if (!stats.isSymbolicLink()) {
        console.log("Migrating existing world to multi-world system...");
        const defaultWorld = path.join(this.worldsHome, "default");

        fs.mkdirSync(defaultWorld, { recursive: true });
        this.execFileSync("rsync", ["-a", "--delete", `${this.worldLink}/`, `${defaultWorld}/`]);
        fs.rmSync(this.worldLink, { recursive: true, force: true });
        fs.symlinkSync(defaultWorld, this.worldLink);

        console.log("Migration complete");
      }
    }
  }

  async listWorlds(): Promise<WorldInfo[]> {
    const worlds: WorldInfo[] = [];

    if (!fs.existsSync(this.worldsHome)) {
      return worlds;
    }

    const activeWorld = this.getCurrentWorld();
    const entries = fs.readdirSync(this.worldsHome);

    for (const entry of entries) {
      const worldPath = path.join(this.worldsHome, entry);
      const levelDat = path.join(worldPath, "level.dat");

      if (fs.existsSync(levelDat)) {
        const stats = fs.statSync(levelDat);
        const size = this.getDirectorySize(worldPath);

        worlds.push({
          name: entry,
          size: size,
          lastPlayed: stats.mtime,
          isActive: entry === activeWorld,
        });
      }
    }

    return worlds.sort(
      (a, b) => b.lastPlayed.getTime() - a.lastPlayed.getTime()
    );
  }

  getCurrentWorld(): string | null {
    if (!fs.existsSync(this.worldLink)) {
      return null;
    }

    try {
      const target = fs.readlinkSync(this.worldLink);
      return path.basename(target);
    } catch {
      return null;
    }
  }

  async switchWorld(worldName: string): Promise<void> {
    const worldPath = safeChildPath(this.worldsHome, worldName);

    if (!fs.existsSync(worldPath)) {
      throw new Error(`World '${worldName}' does not exist`);
    }

    const levelDat = path.join(worldPath, "level.dat");
    if (!fs.existsSync(levelDat)) {
      throw new Error(`World '${worldName}' is corrupted (missing level.dat)`);
    }

    await this.stopServer();
    let restarted = false;

    try {
      this.unlinkWorldLinkIfPresent();
      fs.symlinkSync(worldPath, this.worldLink);

      this.execFileSync("chown", ["-R", "mc:mc", worldPath]);

      await this.startServer();
      restarted = true;
    } finally {
      if (!restarted) {
        await this.startServer();
      }
    }

    console.log(`Switched to world: ${worldName}`);
  }

  async generateWorld(input: GenerateWorldInput): Promise<WorldInfo> {
    const worldName = input.name.trim();
    assertSafePathSegment(worldName, "worldName");
    await this.initialize();

    const worldPath = safeChildPath(this.worldsHome, worldName);
    if (fs.existsSync(worldPath)) {
      throw new Error(`World '${worldName}' already exists`);
    }

    const previousWorldTarget = this.readWorldLinkTarget();
    const wasActive = this.isServerActive();
    const propertiesPath = path.join(this.mcDir, "server.properties");
    const originalProperties = fs.existsSync(propertiesPath) ? fs.readFileSync(propertiesPath, "utf8") : null;
    let generated = false;
    let serverStarted = false;

    try {
      fs.mkdirSync(worldPath, { recursive: false });
      this.execFileSync("chown", ["-R", "mc:mc", worldPath]);

      if (originalProperties !== null) {
        const seed = input.seed?.trim() || "";
        if (seed) assertSafePropertyValue(seed, "seed");
        updateProperties(propertiesPath, {
          "level-name": "world",
          "level-seed": seed,
          "level-type": normalizeLevelType(input.levelType),
        });
        this.execFileSync("chown", ["mc:mc", propertiesPath]);
      }

      if (wasActive) {
        await this.stopServer();
      }

      this.unlinkWorldLinkIfPresent();
      fs.symlinkSync(worldPath, this.worldLink);

      await this.startServer();
      serverStarted = true;
      await this.waitForGeneratedWorld(worldPath, this.generationTimeoutMs);
      generated = true;

      if (!wasActive) {
        await this.stopServer();
        serverStarted = false;
      }

      return {
        name: worldName,
        size: this.getDirectorySize(worldPath),
        lastPlayed: fs.statSync(path.join(worldPath, "level.dat")).mtime,
        isActive: true,
      };
    } finally {
      const cleanupErrors: unknown[] = [];
      if (originalProperties !== null) {
        try {
          fs.writeFileSync(propertiesPath, originalProperties, "utf8");
          if (generated) {
            updateProperties(propertiesPath, {
              "level-name": "world",
            });
          }
          this.execFileSync("chown", ["mc:mc", propertiesPath]);
        } catch (err) {
          cleanupErrors.push(err);
        }
      }

      if (!generated) {
        if (serverStarted) {
          try {
            await this.stopServer();
          } catch {
            // Restore attempt continues below.
          }
        }

        try {
          this.unlinkWorldLinkIfPresent();
        } catch (err) {
          cleanupErrors.push(err);
        }

        if (previousWorldTarget) {
          try {
            fs.symlinkSync(previousWorldTarget, this.worldLink);
          } catch (err) {
            cleanupErrors.push(err);
          }

          if (wasActive) {
            try {
              await this.startServer();
            } catch {
              // Surface the original generation error.
            }
          }
        }

        try {
          fs.rmSync(worldPath, { recursive: true, force: true });
        } catch (err) {
          cleanupErrors.push(err);
        }
      }

      if (cleanupErrors.length > 0) {
        throw cleanupErrors[0];
      }
    }
  }

  async deleteWorld(worldName: string, force: boolean = false): Promise<void> {
    const worldPath = safeChildPath(this.worldsHome, worldName);

    if (!fs.existsSync(worldPath)) {
      throw new Error(`World '${worldName}' does not exist`);
    }

    const currentWorld = this.getCurrentWorld();
    if (currentWorld === worldName && !force) {
      throw new Error("Cannot delete active world");
    }

    const backup = await this.backupWorld(worldName);
    console.log(`Backup created: ${backup}`);

    fs.rmSync(worldPath, { recursive: true, force: true });
    console.log(`Deleted world: ${worldName}`);
  }

  async backupWorld(worldName: string): Promise<string> {
    const worldPath = safeChildPath(this.worldsHome, worldName);

    if (!fs.existsSync(worldPath)) {
      throw new Error(`World '${worldName}' does not exist`);
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 15);
    const backupDir = "/var/backups/minecraft/worlds";
    fs.mkdirSync(backupDir, { recursive: true });

    const backupFile = safeChildPath(backupDir, `${worldName}-${timestamp}.tar.gz`);

    this.execFileSync("tar", ["-czf", backupFile, "-C", this.worldsHome, worldName]);

    return backupFile;
  }

  async importWorld(zipPath: string, worldName?: string): Promise<string> {
    const name = worldName || path.parse(zipPath).name;
    const worldPath = safeChildPath(this.worldsHome, name);

    if (fs.existsSync(worldPath)) {
      throw new Error(`World '${name}' already exists`);
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "world-"));

    try {
      assertSafeZipEntries(zipPath);
      this.execFileSync("unzip", ["-q", zipPath, "-d", tempDir]);

      const levelDat = this.findLevelDat(tempDir);
      if (!levelDat) {
        throw new Error("No level.dat found in ZIP - invalid world");
      }

      const worldRoot = path.dirname(levelDat);

      fs.mkdirSync(this.worldsHome, { recursive: true });
      fs.cpSync(worldRoot, worldPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      this.execFileSync("chown", ["-R", "mc:mc", worldPath]);

      console.log(`Imported world: ${name}`);
      return name;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async exportWorld(worldName: string, outputPath: string): Promise<void> {
    const worldPath = safeChildPath(this.worldsHome, worldName);

    if (!fs.existsSync(worldPath)) {
      throw new Error(`World '${worldName}' does not exist`);
    }

    this.execFileSync("zip", ["-r", outputPath, worldName], { cwd: this.worldsHome });
    console.log(`Exported world to: ${outputPath}`);
  }

  private findLevelDat(dir: string): string | null {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile() && entry.name === "level.dat") {
        return fullPath;
      }

      if (entry.isDirectory()) {
        const found = this.findLevelDat(fullPath);
        if (found) return found;
      }
    }

    return null;
  }

  private getDirectorySize(dirPath: string): number {
    let size = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile()) {
        size += fs.statSync(fullPath).size;
      } else if (entry.isDirectory()) {
        size += this.getDirectorySize(fullPath);
      }
    }

    return size;
  }

  private async stopServer(): Promise<void> {
    this.execFileSync("systemctl", ["stop", "minecraft"]);
  }

  private async startServer(): Promise<void> {
    this.execFileSync("systemctl", ["start", "minecraft"]);
  }

  private isServerActive(): boolean {
    try {
      const status = this.execFileSync("systemctl", ["is-active", "minecraft"], { encoding: "utf8" });
      return status.trim() === "active";
    } catch {
      return false;
    }
  }

  private readWorldLinkTarget(): string | null {
    try {
      if (!fs.lstatSync(this.worldLink).isSymbolicLink()) return null;
      return fs.readlinkSync(this.worldLink);
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  private unlinkWorldLinkIfPresent(): void {
    try {
      fs.unlinkSync(this.worldLink);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  private async waitForGeneratedWorld(worldPath: string, timeoutMs: number): Promise<void> {
    const levelDat = path.join(worldPath, "level.dat");
    const startedAt = Date.now();
    let previousSize = -1;
    let previousMtime = -1;

    while (Date.now() - startedAt < timeoutMs) {
      if (fs.existsSync(levelDat)) {
        const stats = fs.statSync(levelDat);
        if (stats.size === previousSize && stats.mtimeMs === previousMtime) return;
        previousSize = stats.size;
        previousMtime = stats.mtimeMs;
      }
      await new Promise((resolve) => setTimeout(resolve, this.generationPollMs));
    }

    throw new Error("World generation timed out before level.dat was stable");
  }
}
