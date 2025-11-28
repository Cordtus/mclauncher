import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { execSync } from "child_process";

const FABRIC_META_API = "https://meta.fabricmc.net/v2";
const USER_AGENT = "MCLauncher/1.0 (https://github.com/Cordtus/mclauncher)";

export interface FabricLoaderVersion {
  separator: string;
  build: number;
  maven: string;
  version: string;
  stable: boolean;
}

export interface FabricInstallerVersion {
  url: string;
  maven: string;
  version: string;
  stable: boolean;
}

export class FabricDownloader {
  private async fetch(url: string): Promise<Response> {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Fabric API error: ${response.statusText}`);
    }

    return response;
  }

  /**
   * Get available Minecraft versions supported by Fabric
   */
  async getAvailableVersions(): Promise<string[]> {
    const response = await this.fetch(`${FABRIC_META_API}/versions/game`);
    const versions = await response.json();
    return versions
      .filter((v: any) => v.stable)
      .map((v: any) => v.version);
  }

  /**
   * Get available Fabric loader versions
   */
  async getLoaderVersions(): Promise<FabricLoaderVersion[]> {
    const response = await this.fetch(`${FABRIC_META_API}/versions/loader`);
    return await response.json();
  }

  /**
   * Get the latest stable Fabric loader version
   */
  async getLatestLoaderVersion(): Promise<string> {
    const loaders = await this.getLoaderVersions();
    const stable = loaders.find((l) => l.stable);
    return stable?.version || loaders[0]?.version;
  }

  /**
   * Get available Fabric installer versions
   */
  async getInstallerVersions(): Promise<FabricInstallerVersion[]> {
    const response = await this.fetch(`${FABRIC_META_API}/versions/installer`);
    return await response.json();
  }

  /**
   * Download the Fabric server JAR directly (bundled launcher)
   * This is the recommended way for servers
   */
  async downloadServerJar(
    mcVersion: string,
    loaderVersion: string | "latest",
    outputPath: string
  ): Promise<void> {
    const loader = loaderVersion === "latest"
      ? await this.getLatestLoaderVersion()
      : loaderVersion;

    // Get latest installer version
    const installers = await this.getInstallerVersions();
    const installerVersion = installers.find((i) => i.stable)?.version || installers[0]?.version;

    // Download the server JAR directly from Fabric's loader endpoint
    // Format: /v2/versions/loader/{game_version}/{loader_version}/{installer_version}/server/jar
    const downloadUrl = `${FABRIC_META_API}/versions/loader/${mcVersion}/${loader}/${installerVersion}/server/jar`;

    console.log(`Downloading Fabric server JAR from: ${downloadUrl}`);

    const response = await fetch(downloadUrl, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (!response.ok || !response.body) {
      throw new Error(`Failed to download Fabric server JAR: ${response.statusText}`);
    }

    const fileStream = fs.createWriteStream(outputPath);
    await pipeline(Readable.fromWeb(response.body as any), fileStream);

    console.log(`Fabric server JAR downloaded to: ${outputPath}`);
  }

  /**
   * Install Fabric using the installer JAR (alternative method)
   * This creates a fabric-server-launch.jar file
   */
  async installFabricServer(
    mcDir: string,
    mcVersion: string,
    loaderVersion: string | "latest"
  ): Promise<void> {
    const loader = loaderVersion === "latest"
      ? await this.getLatestLoaderVersion()
      : loaderVersion;

    // Get latest installer
    const installers = await this.getInstallerVersions();
    const installer = installers.find((i) => i.stable) || installers[0];

    if (!installer) {
      throw new Error("No Fabric installer available");
    }

    // Download installer
    const installerPath = path.join(mcDir, "fabric-installer.jar");
    const response = await fetch(installer.url, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (!response.ok || !response.body) {
      throw new Error(`Failed to download Fabric installer: ${response.statusText}`);
    }

    const fileStream = fs.createWriteStream(installerPath);
    await pipeline(Readable.fromWeb(response.body as any), fileStream);

    // Run installer
    try {
      execSync(
        `java -jar ${installerPath} server -mcversion ${mcVersion} -loader ${loader} -downloadMinecraft`,
        {
          cwd: mcDir,
          stdio: "pipe",
        }
      );
    } finally {
      // Clean up installer
      if (fs.existsSync(installerPath)) {
        fs.unlinkSync(installerPath);
      }
    }

    // Rename the output to server.jar
    const fabricLauncher = path.join(mcDir, "fabric-server-launch.jar");
    const serverJar = path.join(mcDir, "server.jar");

    if (fs.existsSync(fabricLauncher)) {
      if (fs.existsSync(serverJar)) {
        fs.unlinkSync(serverJar);
      }
      fs.renameSync(fabricLauncher, serverJar);
    }
  }
}
