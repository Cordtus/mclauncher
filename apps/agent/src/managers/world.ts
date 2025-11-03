import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import os from "os";

interface WorldInfo {
  name: string;
  size: number;
  lastPlayed: Date;
  isActive: boolean;
}

export class WorldManager {
  private readonly worldsHome: string;
  private readonly worldLink: string;

  constructor(private mcDir: string = "/opt/minecraft") {
    this.worldsHome = path.join(mcDir, "worlds");
    this.worldLink = path.join(mcDir, "world");
  }

  async initialize(): Promise<void> {
    fs.mkdirSync(this.worldsHome, { recursive: true });

    if (fs.existsSync(this.worldLink)) {
      const stats = fs.lstatSync(this.worldLink);

      if (!stats.isSymbolicLink()) {
        console.log("Migrating existing world to multi-world system...");
        const defaultWorld = path.join(this.worldsHome, "default");

        fs.mkdirSync(defaultWorld, { recursive: true });
        execSync(`rsync -a --delete ${this.worldLink}/ ${defaultWorld}/`);
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
    const worldPath = path.join(this.worldsHome, worldName);

    if (!fs.existsSync(worldPath)) {
      throw new Error(`World '${worldName}' does not exist`);
    }

    const levelDat = path.join(worldPath, "level.dat");
    if (!fs.existsSync(levelDat)) {
      throw new Error(`World '${worldName}' is corrupted (missing level.dat)`);
    }

    await this.stopServer();

    if (fs.existsSync(this.worldLink)) {
      fs.unlinkSync(this.worldLink);
    }
    fs.symlinkSync(worldPath, this.worldLink);

    execSync(`chown -R mc:mc ${worldPath}`);

    await this.startServer();

    console.log(`Switched to world: ${worldName}`);
  }

  async deleteWorld(worldName: string, force: boolean = false): Promise<void> {
    const worldPath = path.join(this.worldsHome, worldName);

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
    const worldPath = path.join(this.worldsHome, worldName);

    if (!fs.existsSync(worldPath)) {
      throw new Error(`World '${worldName}' does not exist`);
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 15);
    const backupDir = "/var/backups/minecraft/worlds";
    fs.mkdirSync(backupDir, { recursive: true });

    const backupFile = path.join(backupDir, `${worldName}-${timestamp}.tar.gz`);

    execSync(`tar -czf ${backupFile} -C ${this.worldsHome} ${worldName}`);

    return backupFile;
  }

  async importWorld(zipPath: string, worldName?: string): Promise<string> {
    const name = worldName || path.parse(zipPath).name;
    const worldPath = path.join(this.worldsHome, name);

    if (fs.existsSync(worldPath)) {
      throw new Error(`World '${name}' already exists`);
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "world-"));

    try {
      execSync(`unzip -q ${zipPath} -d ${tempDir}`);

      const levelDat = this.findLevelDat(tempDir);
      if (!levelDat) {
        throw new Error("No level.dat found in ZIP - invalid world");
      }

      const worldRoot = path.dirname(levelDat);

      fs.mkdirSync(this.worldsHome, { recursive: true });
      execSync(`mv ${worldRoot} ${worldPath}`);
      execSync(`chown -R mc:mc ${worldPath}`);

      console.log(`Imported world: ${name}`);
      return name;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async exportWorld(worldName: string, outputPath: string): Promise<void> {
    const worldPath = path.join(this.worldsHome, worldName);

    if (!fs.existsSync(worldPath)) {
      throw new Error(`World '${worldName}' does not exist`);
    }

    execSync(`cd ${this.worldsHome} && zip -r ${outputPath} ${worldName}`);
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
    execSync("systemctl stop minecraft");
  }

  private async startServer(): Promise<void> {
    execSync("systemctl start minecraft");
  }
}
