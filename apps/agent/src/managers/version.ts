import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { PaperDownloader } from "../downloaders/paper.js";
import { VanillaDownloader } from "../downloaders/vanilla.js";

type ServerType = "paper" | "vanilla";

export class VersionManager {
  private paperDownloader: PaperDownloader;
  private vanillaDownloader: VanillaDownloader;

  constructor(private mcDir: string = "/opt/minecraft") {
    this.paperDownloader = new PaperDownloader();
    this.vanillaDownloader = new VanillaDownloader();
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
    build?: number
  ): Promise<void> {
    const tempJar = `/tmp/server-${Date.now()}.jar`;

    try {
      if (serverType === "paper") {
        await this.paperDownloader.downloadPaperJar(
          version,
          build || "latest",
          tempJar
        );
      } else {
        await this.vanillaDownloader.downloadVanillaServer(version, tempJar);
      }

      await this.replaceServerJar(tempJar, serverType);

      if (fs.existsSync(tempJar)) {
        fs.unlinkSync(tempJar);
      }
    } catch (error) {
      if (fs.existsSync(tempJar)) {
        fs.unlinkSync(tempJar);
      }
      throw error;
    }
  }

  async switchServerType(
    targetType: ServerType,
    version: string,
    build?: number
  ): Promise<void> {
    console.log(`Switching to ${targetType} ${version}...`);
    console.log("WARNING: This may cause world data changes");

    const backup = await this.createFullBackup();
    console.log(`Full backup created: ${backup}`);

    try {
      await this.changeVersion(targetType, version, build);

      if (targetType === "vanilla") {
        this.cleanPaperFiles();
      }

      console.log(`Successfully switched to ${targetType} ${version}`);
    } catch (error) {
      console.error("Server type switch failed:", error);
      await this.restoreBackup(backup);
      throw error;
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
      const status = execSync("systemctl is-active minecraft", {
        encoding: "utf8",
        stdio: "pipe",
      }).trim();

      if (status !== "active") {
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
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
      if (fs.existsSync(logPath)) {
        const logs = fs.readFileSync(logPath, "utf8");
        if (logs.includes("Done!") || logs.includes("Server started")) {
          return;
        }
        if (logs.includes("Failed to start") || logs.includes("error")) {
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
    execSync(
      `tar -czf ${backupFile} -C ${this.mcDir} world world_nether world_the_end`,
      { stdio: "pipe" }
    );

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
}
