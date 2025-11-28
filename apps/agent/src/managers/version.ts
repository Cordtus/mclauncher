import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { PaperDownloader } from "../downloaders/paper.js";
import { VanillaDownloader } from "../downloaders/vanilla.js";
import { FabricDownloader } from "../downloaders/fabric.js";
import { ForgeDownloader } from "../downloaders/forge.js";

type ServerType = "paper" | "vanilla" | "fabric" | "forge";

export class VersionManager {
  private paperDownloader: PaperDownloader;
  private vanillaDownloader: VanillaDownloader;
  private fabricDownloader: FabricDownloader;
  private forgeDownloader: ForgeDownloader;

  constructor(private mcDir: string = "/opt/minecraft") {
    this.paperDownloader = new PaperDownloader();
    this.vanillaDownloader = new VanillaDownloader();
    this.fabricDownloader = new FabricDownloader();
    this.forgeDownloader = new ForgeDownloader();
  }

  /**
   * Get available versions for a server type
   */
  async getAvailableVersions(serverType: ServerType): Promise<string[]> {
    switch (serverType) {
      case "paper":
        return this.paperDownloader.getAvailableVersions();
      case "vanilla":
        return this.vanillaDownloader.getAvailableReleases();
      case "fabric":
        return this.fabricDownloader.getAvailableVersions();
      case "forge":
        return this.forgeDownloader.getAvailableVersions();
      default:
        throw new Error(`Unknown server type: ${serverType}`);
    }
  }

  async replaceServerJar(
    newJarPath: string,
    serverType: ServerType
  ): Promise<void> {
    const backupPath = await this.createBackup();

    try {
      await this.stopServer();
      await this.waitForServerStop();

      const currentJar = path.join(this.mcDir, "server.jar");
      if (fs.existsSync(currentJar)) {
        fs.copyFileSync(
          currentJar,
          path.join(this.mcDir, `server.jar.backup.${Date.now()}`)
        );
      }

      fs.copyFileSync(newJarPath, currentJar);
      fs.chmodSync(currentJar, 0o644);
      execSync(`chown mc:mc ${currentJar}`);

      const jarValid = await this.validateJar(currentJar);
      if (!jarValid) {
        throw new Error("Invalid JAR file");
      }

      await this.startServer();
      await this.monitorStartup();
    } catch (error) {
      console.error("JAR replacement failed:", error);
      await this.restoreBackup(backupPath);
      throw error;
    }
  }

  async changeVersion(
    serverType: ServerType,
    version: string,
    build?: number | string
  ): Promise<void> {
    const tempJar = `/tmp/server-${Date.now()}.jar`;

    try {
      switch (serverType) {
        case "paper":
          await this.paperDownloader.downloadPaperJar(
            version,
            typeof build === "number" ? build : "latest",
            tempJar
          );
          await this.replaceServerJar(tempJar, serverType);
          break;

        case "vanilla":
          await this.vanillaDownloader.downloadVanillaServer(version, tempJar);
          await this.replaceServerJar(tempJar, serverType);
          break;

        case "fabric":
          // Fabric uses a direct download, not an installer
          await this.fabricDownloader.downloadServerJar(
            version,
            typeof build === "string" ? build : "latest",
            tempJar
          );
          await this.replaceServerJar(tempJar, serverType);
          // Create mods folder if it doesn't exist
          const modsDir = path.join(this.mcDir, "mods");
          fs.mkdirSync(modsDir, { recursive: true });
          execSync(`chown -R mc:mc ${modsDir}`);
          break;

        case "forge":
          // Forge uses an installer that runs in the MC directory
          await this.stopServer();
          await this.waitForServerStop();
          await this.createFullBackup();
          await this.forgeDownloader.installForgeServer(
            this.mcDir,
            version,
            typeof build === "string" ? build : undefined
          );
          // Create mods folder if it doesn't exist
          const forgeModsDir = path.join(this.mcDir, "mods");
          fs.mkdirSync(forgeModsDir, { recursive: true });
          execSync(`chown -R mc:mc ${this.mcDir}`);
          await this.startServer();
          await this.monitorStartup();
          break;
      }

      if (fs.existsSync(tempJar)) {
        fs.unlinkSync(tempJar);
      }

      // Write server type marker
      const markerPath = path.join(this.mcDir, ".server-type");
      fs.writeFileSync(markerPath, JSON.stringify({
        type: serverType,
        mcVersion: version,
        build: build || "latest",
        installedAt: new Date().toISOString(),
      }));

    } catch (error) {
      if (fs.existsSync(tempJar)) {
        fs.unlinkSync(tempJar);
      }
      throw error;
    }
  }

  /**
   * Get the current server type
   */
  getServerType(): { type: ServerType; mcVersion?: string; build?: string } | null {
    const markerPath = path.join(this.mcDir, ".server-type");
    if (fs.existsSync(markerPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(markerPath, "utf8"));
        return {
          type: data.type,
          mcVersion: data.mcVersion,
          build: data.build,
        };
      } catch {
        return null;
      }
    }

    // Try to detect based on files
    if (this.forgeDownloader.isForgeInstalled(this.mcDir)) {
      return { type: "forge" };
    }

    return null;
  }

  async switchServerType(
    targetType: ServerType,
    version: string,
    build?: number | string
  ): Promise<void> {
    console.log(`Switching to ${targetType} ${version}...`);
    console.log("WARNING: This may cause world data changes");

    const backup = await this.createFullBackup();
    console.log(`Full backup created: ${backup}`);

    try {
      // Clean up previous server type files
      const currentType = this.getServerType();
      if (currentType) {
        await this.cleanServerTypeFiles(currentType.type);
      }

      await this.changeVersion(targetType, version, build);

      console.log(`Successfully switched to ${targetType} ${version}`);
    } catch (error) {
      console.error("Server type switch failed:", error);
      await this.restoreBackup(backup);
      throw error;
    }
  }

  private async cleanServerTypeFiles(serverType: ServerType): Promise<void> {
    switch (serverType) {
      case "paper":
        this.cleanPaperFiles();
        break;
      case "forge":
        this.cleanForgeFiles();
        break;
      case "fabric":
        this.cleanFabricFiles();
        break;
      // Vanilla has no special files to clean
    }
  }

  private async stopServer(): Promise<void> {
    try {
      execSync("systemctl stop minecraft", { stdio: "pipe" });
    } catch (error) {
      console.warn("Failed to stop via systemctl:", error);
    }
  }

  private async startServer(): Promise<void> {
    execSync("systemctl start minecraft", { stdio: "pipe" });
  }

  private async waitForServerStop(timeout: number = 60000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const status = execSync("systemctl is-active minecraft", {
          encoding: "utf8",
          stdio: "pipe",
        }).trim();

        if (status !== "active") {
          return;
        }
      } catch {
        // Command failed, likely means service is not active
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Server stop timeout");
  }

  private async validateJar(jarPath: string): Promise<boolean> {
    try {
      execSync(`unzip -t ${jarPath}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  private async monitorStartup(): Promise<void> {
    const logPath = path.join(this.mcDir, "logs/latest.log");
    let attempts = 0;
    const maxAttempts = 120; // Extended for modded servers

    while (attempts < maxAttempts) {
      if (fs.existsSync(logPath)) {
        const logs = fs.readFileSync(logPath, "utf8");
        if (logs.includes("Done!") || logs.includes("Server started")) {
          return;
        }
        if (logs.includes("Failed to start") || logs.match(/error.*fatal/i)) {
          throw new Error("Server startup failed");
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    }
    throw new Error("Server startup timeout");
  }

  private async createBackup(): Promise<string> {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 15);
    const backupDir = "/var/backups/minecraft";
    fs.mkdirSync(backupDir, { recursive: true });

    const backupFile = path.join(backupDir, `world-${timestamp}.tar.gz`);
    try {
      execSync(
        `tar -czf ${backupFile} -C ${this.mcDir} world world_nether world_the_end 2>/dev/null || tar -czf ${backupFile} -C ${this.mcDir} world`,
        { stdio: "pipe" }
      );
    } catch {
      // If world doesn't exist, create empty backup marker
      fs.writeFileSync(backupFile, "");
    }

    return backupFile;
  }

  private async createFullBackup(): Promise<string> {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 15);
    const backupDir = "/var/backups/minecraft";
    fs.mkdirSync(backupDir, { recursive: true });

    const backupFile = path.join(backupDir, `full-${timestamp}.tar.gz`);
    execSync(`tar -czf ${backupFile} -C ${this.mcDir} .`, { stdio: "pipe" });

    return backupFile;
  }

  private async restoreBackup(backupPath: string): Promise<void> {
    console.log(`Restoring backup: ${backupPath}`);
    await this.stopServer();
    execSync(`tar -xzf ${backupPath} -C ${this.mcDir}`, { stdio: "pipe" });
    await this.startServer();
  }

  private cleanPaperFiles(): void {
    const filesToRemove = [
      "paper.yml",
      "paper-global.yml",
      "paper-world-defaults.yml",
      "cache",
    ];

    for (const file of filesToRemove) {
      const fullPath = path.join(this.mcDir, file);
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`Removed: ${file}`);
      }
    }
  }

  private cleanForgeFiles(): void {
    const filesToRemove = [
      ".forge-server",
      "run.sh",
      "run.bat",
      "user_jvm_args.txt",
      "libraries",
    ];

    for (const file of filesToRemove) {
      const fullPath = path.join(this.mcDir, file);
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`Removed: ${file}`);
      }
    }
  }

  private cleanFabricFiles(): void {
    const filesToRemove = [
      ".fabric",
      "fabric-server-launcher.properties",
    ];

    for (const file of filesToRemove) {
      const fullPath = path.join(this.mcDir, file);
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`Removed: ${file}`);
      }
    }
  }
}
