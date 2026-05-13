import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { PaperDownloader } from "../downloaders/paper.js";
import { VanillaDownloader } from "../downloaders/vanilla.js";
import { FabricDownloader } from "../downloaders/fabric.js";
import { ForgeDownloader } from "../downloaders/forge.js";

type ServerType = "paper" | "vanilla" | "fabric" | "forge";

function run(cmd: string, args: string[], options: Parameters<typeof execFileSync>[2] = {}) {
  return execFileSync(cmd, args, { stdio: "pipe", ...options });
}

function isConcreteLoaderBuild(build: number | string | undefined): build is string {
  return typeof build === "string" && build.trim() !== "" && build.toLowerCase() !== "latest";
}

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
    const currentJar = path.join(this.mcDir, "server.jar");
    const jarBackupPath = fs.existsSync(currentJar)
      ? path.join(this.mcDir, `server.jar.backup.${Date.now()}`)
      : null;
    const serviceBackup = this.readServiceFile();

    try {
      await this.stopServer();
      await this.waitForServerStop();

      if (jarBackupPath) {
        fs.copyFileSync(currentJar, jarBackupPath);
      }

      fs.copyFileSync(newJarPath, currentJar);
      fs.chmodSync(currentJar, 0o644);
      run("chown", ["mc:mc", currentJar]);

      const jarValid = await this.validateJar(currentJar);
      if (!jarValid) {
        throw new Error("Invalid JAR file");
      }

      this.configureServiceForServerType(serverType);
      await this.startServer();
      await this.monitorStartup();
    } catch (error) {
      console.error("JAR replacement failed:", error);
      this.restoreServiceFile(serviceBackup);
      if (jarBackupPath && fs.existsSync(jarBackupPath)) {
        fs.copyFileSync(jarBackupPath, currentJar);
        run("chown", ["mc:mc", currentJar]);
      }
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
    let resolvedBuild: number | string = build || "latest";

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
          const fabricLoaderVersion = isConcreteLoaderBuild(build)
            ? build
            : await this.fabricDownloader.getLatestLoaderVersion();
          resolvedBuild = fabricLoaderVersion;
          await this.fabricDownloader.downloadServerJar(
            version,
            fabricLoaderVersion,
            tempJar
          );
          await this.replaceServerJar(tempJar, serverType);
          // Create mods folder if it doesn't exist
          const modsDir = path.join(this.mcDir, "mods");
          fs.mkdirSync(modsDir, { recursive: true });
          run("chown", ["-R", "mc:mc", modsDir]);
          break;

        case "forge":
          // Forge uses an installer that runs in the MC directory
          const backup = await this.createFullBackup();
          const serviceBackup = this.readServiceFile();
          try {
            const forgeVersion = isConcreteLoaderBuild(build)
              ? build
              : await this.forgeDownloader.getRecommendedForgeVersion(version);
            if (!forgeVersion) {
              throw new Error(`No Forge version available for Minecraft ${version}`);
            }
            resolvedBuild = forgeVersion;
            await this.stopServer();
            await this.waitForServerStop();
            await this.forgeDownloader.installForgeServer(
              this.mcDir,
              version,
              forgeVersion
            );
            // Create mods folder if it doesn't exist
            const forgeModsDir = path.join(this.mcDir, "mods");
            fs.mkdirSync(forgeModsDir, { recursive: true });
            run("chown", ["-R", "mc:mc", this.mcDir]);
            this.configureServiceForServerType("forge");
            await this.startServer();
            await this.monitorStartup();
          } catch (error) {
            this.restoreServiceFile(serviceBackup);
            await this.restoreBackup(backup);
            throw error;
          }
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
        build: resolvedBuild,
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
      const forgeInfo = this.forgeDownloader.getInstalledForgeInfo(this.mcDir);
      return {
        type: "forge",
        mcVersion: forgeInfo?.mcVersion,
        build: forgeInfo?.forgeVersion,
      };
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
      run("systemctl", ["stop", "minecraft"]);
    } catch (error) {
      console.warn("Failed to stop via systemctl:", error);
    }
  }

  private async startServer(): Promise<void> {
    run("systemctl", ["start", "minecraft"]);
  }

  private configureServiceForServerType(serverType: ServerType): void {
    const serviceFile = "/etc/systemd/system/minecraft.service";
    if (!fs.existsSync(serviceFile)) return;

    let serviceContent = fs.readFileSync(serviceFile, "utf8");
    const existingUserJvmArgs = path.join(this.mcDir, "user_jvm_args.txt");
    const currentFlags = fs.existsSync(existingUserJvmArgs)
      ? fs.readFileSync(existingUserJvmArgs, "utf8").split(/\r?\n/).filter((line) => !line.trim().startsWith("#")).join(" ").trim()
      : serviceContent.match(/ExecStart=\/usr\/bin\/java\s+(.*?)\s+-jar/)?.[1] ||
      "-Xms512M -Xmx2048M";
    const execStart = serverType === "forge" && fs.existsSync(path.join(this.mcDir, "run.sh"))
      ? "ExecStart=/usr/bin/env bash run.sh nogui"
      : `ExecStart=/usr/bin/java ${currentFlags} -jar server.jar nogui`;

    if (serverType === "forge" && fs.existsSync(path.join(this.mcDir, "run.sh"))) {
      const userJvmArgs = path.join(this.mcDir, "user_jvm_args.txt");
      if (!fs.existsSync(userJvmArgs)) {
        fs.writeFileSync(userJvmArgs, `${currentFlags}\n`);
        run("chown", ["mc:mc", userJvmArgs]);
      }
    }

    serviceContent = serviceContent.replace(/ExecStart=.*/, execStart);
    fs.writeFileSync(serviceFile, serviceContent);
    run("systemctl", ["daemon-reload"]);
  }

  private readServiceFile(): string | null {
    const serviceFile = "/etc/systemd/system/minecraft.service";
    return fs.existsSync(serviceFile) ? fs.readFileSync(serviceFile, "utf8") : null;
  }

  private restoreServiceFile(content: string | null): void {
    if (content === null) return;

    const serviceFile = "/etc/systemd/system/minecraft.service";
    fs.writeFileSync(serviceFile, content);
    run("systemctl", ["daemon-reload"]);
  }

  private async waitForServerStop(timeout: number = 60000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const status = execFileSync("systemctl", ["is-active", "minecraft"], {
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
      run("unzip", ["-t", jarPath]);
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
    const worldDirs = ["world", "world_nether", "world_the_end"].filter((entry) =>
      fs.existsSync(path.join(this.mcDir, entry))
    );
    if (worldDirs.length > 0) {
      run("tar", ["-czf", backupFile, "-C", this.mcDir, ...worldDirs]);
    } else {
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
    run("tar", ["-czf", backupFile, "-C", this.mcDir, "."]);

    return backupFile;
  }

  private async restoreBackup(backupPath: string): Promise<void> {
    console.log(`Restoring backup: ${backupPath}`);
    await this.stopServer();
    if (fs.existsSync(backupPath) && fs.statSync(backupPath).size > 0) {
      run("tar", ["-xzf", backupPath, "-C", this.mcDir]);
    }
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
