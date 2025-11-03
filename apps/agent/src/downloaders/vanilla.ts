import fs from "fs";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

const MANIFEST_URL =
  "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

interface MojangManifest {
  latest: {
    release: string;
    snapshot: string;
  };
  versions: Array<{
    id: string;
    type: "release" | "snapshot" | "old_beta" | "old_alpha";
    url: string;
    time: string;
    releaseTime: string;
    sha1: string;
    complianceLevel: number;
  }>;
}

interface VersionManifest {
  id: string;
  type: string;
  downloads: {
    client: {
      sha1: string;
      size: number;
      url: string;
    };
    server: {
      sha1: string;
      size: number;
      url: string;
    };
  };
}

export class VanillaDownloader {
  async getManifest(): Promise<MojangManifest> {
    const response = await fetch(MANIFEST_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.statusText}`);
    }
    return await response.json();
  }

  async getVersionManifest(versionId: string): Promise<VersionManifest> {
    const manifest = await this.getManifest();
    const version = manifest.versions.find((v) => v.id === versionId);

    if (!version) {
      throw new Error(`Version ${versionId} not found`);
    }

    const response = await fetch(version.url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch version manifest: ${response.statusText}`
      );
    }
    return await response.json();
  }

  async getLatestVersion(
    type: "release" | "snapshot" = "release"
  ): Promise<string> {
    const manifest = await this.getManifest();
    return manifest.latest[type];
  }

  async getAvailableReleases(): Promise<string[]> {
    const manifest = await this.getManifest();
    return manifest.versions
      .filter((v) => v.type === "release")
      .map((v) => v.id);
  }

  async downloadVanillaServer(
    versionId: string,
    outputPath: string,
    validateHash: boolean = true
  ): Promise<void> {
    const versionManifest = await this.getVersionManifest(versionId);

    if (!versionManifest.downloads?.server) {
      throw new Error(
        `No server download available for version ${versionId}`
      );
    }

    const { url, sha1, size } = versionManifest.downloads.server;

    console.log(
      `Downloading ${versionId} server (${(size / 1024 / 1024).toFixed(2)} MB)...`
    );

    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download server JAR: ${response.statusText}`);
    }

    if (validateHash) {
      // Download to temp file for hash validation
      const tempPath = `${outputPath}.tmp`;
      const fileStream = fs.createWriteStream(tempPath);
      await pipeline(Readable.fromWeb(response.body as any), fileStream);

      // Validate hash
      const hash = crypto.createHash("sha1");
      const readStream = fs.createReadStream(tempPath);
      readStream.on("data", (chunk) => hash.update(chunk));

      await new Promise<void>((resolve, reject) => {
        readStream.on("end", () => {
          const calculatedHash = hash.digest("hex");
          if (calculatedHash !== sha1) {
            fs.unlinkSync(tempPath);
            reject(new Error("SHA1 hash mismatch - download corrupted"));
          } else {
            fs.renameSync(tempPath, outputPath);
            resolve();
          }
        });
        readStream.on("error", reject);
      });
    } else {
      const fileStream = fs.createWriteStream(outputPath);
      await pipeline(Readable.fromWeb(response.body as any), fileStream);
    }

    console.log("Download complete!");
  }
}
