import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { execSync } from "child_process";

const FORGE_PROMOTIONS_URL = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_MAVEN_URL = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const USER_AGENT = "MCLauncher/1.0 (https://github.com/Cordtus/mclauncher)";

interface ForgePromotions {
  homepage: string;
  promos: Record<string, string>;
}

export class ForgeDownloader {
  private async fetch(url: string): Promise<Response> {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Forge API error: ${response.statusText}`);
    }

    return response;
  }

  /**
   * Get available Minecraft versions with Forge support
   */
  async getAvailableVersions(): Promise<string[]> {
    const response = await this.fetch(FORGE_PROMOTIONS_URL);
    const data: ForgePromotions = await response.json();

    // Extract unique MC versions from promos (e.g., "1.20.1-recommended" -> "1.20.1")
    const versions = new Set<string>();
    for (const key of Object.keys(data.promos)) {
      const mcVersion = key.split("-")[0];
      versions.add(mcVersion);
    }

    return Array.from(versions).sort().reverse();
  }

  /**
   * Get the recommended Forge version for a Minecraft version
   */
  async getRecommendedForgeVersion(mcVersion: string): Promise<string | null> {
    const response = await this.fetch(FORGE_PROMOTIONS_URL);
    const data: ForgePromotions = await response.json();

    // Try recommended first, then latest
    const recommended = data.promos[`${mcVersion}-recommended`];
    const latest = data.promos[`${mcVersion}-latest`];

    return recommended || latest || null;
  }

  /**
   * Get the latest Forge version for a Minecraft version
   */
  async getLatestForgeVersion(mcVersion: string): Promise<string | null> {
    const response = await this.fetch(FORGE_PROMOTIONS_URL);
    const data: ForgePromotions = await response.json();

    return data.promos[`${mcVersion}-latest`] || null;
  }

  /**
   * Install Forge server
   * Forge requires running the installer which downloads additional files
   */
  async installForgeServer(
    mcDir: string,
    mcVersion: string,
    forgeVersion?: string
  ): Promise<void> {
    // Get forge version if not specified
    const version = forgeVersion || await this.getRecommendedForgeVersion(mcVersion);
    if (!version) {
      throw new Error(`No Forge version available for Minecraft ${mcVersion}`);
    }

    const fullVersion = `${mcVersion}-${version}`;
    const installerFileName = `forge-${fullVersion}-installer.jar`;
    const installerUrl = `${FORGE_MAVEN_URL}/${fullVersion}/${installerFileName}`;
    const installerPath = path.join(mcDir, installerFileName);

    console.log(`Downloading Forge installer from: ${installerUrl}`);

    // Download installer
    const response = await fetch(installerUrl, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (!response.ok || !response.body) {
      throw new Error(`Failed to download Forge installer: ${response.statusText}`);
    }

    const fileStream = fs.createWriteStream(installerPath);
    await pipeline(Readable.fromWeb(response.body as any), fileStream);

    console.log("Running Forge installer...");

    // Run the installer in server mode
    try {
      execSync(`java -jar ${installerPath} --installServer`, {
        cwd: mcDir,
        stdio: "pipe",
        timeout: 600000, // 10 minute timeout for large downloads
      });
    } catch (error: any) {
      throw new Error(`Forge installer failed: ${error.message}`);
    } finally {
      // Clean up installer
      if (fs.existsSync(installerPath)) {
        fs.unlinkSync(installerPath);
      }
      // Also clean up installer log if it exists
      const installerLog = path.join(mcDir, `${installerFileName}.log`);
      if (fs.existsSync(installerLog)) {
        fs.unlinkSync(installerLog);
      }
    }

    // Find the server JAR - naming convention varies by version
    // Newer: run.sh/run.bat with libraries
    // Older: forge-{version}-server.jar or forge-{version}.jar
    const serverJar = path.join(mcDir, "server.jar");
    const possibleJars = [
      path.join(mcDir, `forge-${fullVersion}-server.jar`),
      path.join(mcDir, `forge-${fullVersion}.jar`),
      path.join(mcDir, `forge-${fullVersion}-universal.jar`),
    ];

    // For modern Forge (1.17+), check for run.sh/run.bat
    const runSh = path.join(mcDir, "run.sh");
    const runBat = path.join(mcDir, "run.bat");

    if (fs.existsSync(runSh) || fs.existsSync(runBat)) {
      // Modern Forge uses a run script, we need to create a wrapper or use it directly
      console.log("Modern Forge installation detected. Using run script.");

      // Create a symlink or marker file so we know this is a Forge server
      const forgeMarker = path.join(mcDir, ".forge-server");
      fs.writeFileSync(forgeMarker, JSON.stringify({
        mcVersion,
        forgeVersion: version,
        fullVersion,
        installedAt: new Date().toISOString(),
      }));

      return;
    }

    // For older Forge, rename the JAR to server.jar
    for (const jarPath of possibleJars) {
      if (fs.existsSync(jarPath)) {
        if (fs.existsSync(serverJar)) {
          fs.unlinkSync(serverJar);
        }
        fs.renameSync(jarPath, serverJar);
        console.log(`Renamed ${path.basename(jarPath)} to server.jar`);
        return;
      }
    }

    // If we can't find a server JAR, the installation might have failed
    console.warn("Could not find Forge server JAR. Installation may have failed.");
  }

  /**
   * Check if a directory has a Forge server installed
   */
  isForgeInstalled(mcDir: string): boolean {
    const forgeMarker = path.join(mcDir, ".forge-server");
    const runSh = path.join(mcDir, "run.sh");
    return fs.existsSync(forgeMarker) || fs.existsSync(runSh);
  }

  /**
   * Get installed Forge info
   */
  getInstalledForgeInfo(mcDir: string): { mcVersion: string; forgeVersion: string } | null {
    const forgeMarker = path.join(mcDir, ".forge-server");
    if (fs.existsSync(forgeMarker)) {
      try {
        const data = JSON.parse(fs.readFileSync(forgeMarker, "utf8"));
        return {
          mcVersion: data.mcVersion,
          forgeVersion: data.forgeVersion,
        };
      } catch {
        return null;
      }
    }
    return null;
  }
}
