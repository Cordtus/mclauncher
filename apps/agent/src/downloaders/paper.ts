import fs from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

const API_BASE = "https://api.papermc.io/v2";
const USER_AGENT = "MCLauncher/1.0 (https://github.com/Cordtus/mclauncher)";

interface PaperBuildInfo {
  project_id: string;
  project_name: string;
  version: string;
  build: number;
  time: string;
  channel: string;
  promoted: boolean;
  downloads: {
    application: {
      name: string;
      sha256: string;
    };
  };
}

export class PaperDownloader {
  private async fetch(path: string): Promise<Response> {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Paper API error: ${response.statusText}`);
    }

    return response;
  }

  async getAvailableVersions(): Promise<string[]> {
    const response = await this.fetch("/projects/paper");
    const data = await response.json();
    return data.versions;
  }

  async getLatestBuild(version: string): Promise<number> {
    const response = await this.fetch(`/projects/paper/versions/${version}`);
    const data = await response.json();
    const builds = data.builds;
    return builds[builds.length - 1];
  }

  async getBuildInfo(version: string, build: number): Promise<PaperBuildInfo> {
    const response = await this.fetch(
      `/projects/paper/versions/${version}/builds/${build}`
    );
    return await response.json();
  }

  async downloadPaperJar(
    version: string,
    build: number | "latest",
    outputPath: string
  ): Promise<void> {
    const buildNum =
      build === "latest" ? await this.getLatestBuild(version) : build;

    const buildInfo = await this.getBuildInfo(version, buildNum);
    const downloadName = buildInfo.downloads.application.name;

    const downloadUrl = `${API_BASE}/projects/paper/versions/${version}/builds/${buildNum}/downloads/${downloadName}`;

    const response = await fetch(downloadUrl, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (!response.ok || !response.body) {
      throw new Error(`Failed to download Paper JAR: ${response.statusText}`);
    }

    const fileStream = fs.createWriteStream(outputPath);
    await pipeline(Readable.fromWeb(response.body as any), fileStream);
  }
}
