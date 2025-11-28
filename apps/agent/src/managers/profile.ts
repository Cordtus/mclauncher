import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { PaperDownloader } from "../downloaders/paper.js";
import { VanillaDownloader } from "../downloaders/vanilla.js";
import { FabricDownloader } from "../downloaders/fabric.js";
import { ForgeDownloader } from "../downloaders/forge.js";

export type ProfileType = "paper" | "vanilla" | "fabric" | "forge";

export interface ProfileInfo {
  type: ProfileType;
  mcVersion: string;
  loaderVersion?: string;
  installedAt: string;
  isActive: boolean;
}

export interface ProfileConfig {
  activeProfile: ProfileType;
  profiles: Record<ProfileType, ProfileInfo | null>;
}

/**
 * ProfileManager handles multiple server types in a single container.
 * Each profile (paper, fabric, forge, vanilla) has its own directory with
 * server-specific files, while world data and configs are shared.
 */
export class ProfileManager {
  private profilesDir: string;
  private configPath: string;

  private paperDownloader: PaperDownloader;
  private vanillaDownloader: VanillaDownloader;
  private fabricDownloader: FabricDownloader;
  private forgeDownloader: ForgeDownloader;

  // Files/folders that are profile-specific (not shared)
  private readonly profileSpecificItems: Record<ProfileType, string[]> = {
    paper: ["server.jar", "plugins", "paper.yml", "paper-global.yml", "paper-world-defaults.yml", "cache", "bundler"],
    fabric: ["server.jar", "mods", ".fabric"],
    forge: ["server.jar", "mods", "libraries", "run.sh", "run.bat", "user_jvm_args.txt", ".forge-server"],
    vanilla: ["server.jar"],
  };

  // Files that should be shared across all profiles (symlinked)
  private readonly sharedItems = [
    "world",
    "world_nether",
    "world_the_end",
    "server.properties",
    "whitelist.json",
    "ops.json",
    "banned-ips.json",
    "banned-players.json",
    "eula.txt",
    "logs",
    "crash-reports",
  ];

  constructor(private mcDir: string = "/opt/minecraft") {
    this.profilesDir = path.join(mcDir, "profiles");
    this.configPath = path.join(mcDir, "profiles.json");

    this.paperDownloader = new PaperDownloader();
    this.vanillaDownloader = new VanillaDownloader();
    this.fabricDownloader = new FabricDownloader();
    this.forgeDownloader = new ForgeDownloader();
  }

  /**
   * Initialize the profile system - migrate from single-server if needed
   */
  async initialize(): Promise<void> {
    // Create profiles directory
    fs.mkdirSync(this.profilesDir, { recursive: true });

    // Create profile subdirectories
    for (const profileType of ["paper", "fabric", "forge", "vanilla"] as ProfileType[]) {
      const profileDir = path.join(this.profilesDir, profileType);
      fs.mkdirSync(profileDir, { recursive: true });
    }

    // If this is a fresh install or migration, set up config
    if (!fs.existsSync(this.configPath)) {
      // Check if there's an existing server.jar to migrate
      const existingJar = path.join(this.mcDir, "server.jar");
      let activeProfile: ProfileType = "paper";

      if (fs.existsSync(existingJar)) {
        // Detect current server type and migrate
        activeProfile = await this.detectAndMigrateExisting();
      }

      const config: ProfileConfig = {
        activeProfile,
        profiles: {
          paper: null,
          fabric: null,
          forge: null,
          vanilla: null,
        },
      };

      this.saveConfig(config);
    }

    // Ensure shared items exist and are in the right place
    await this.ensureSharedStructure();
  }

  /**
   * Detect existing server type and migrate files to profile structure
   */
  private async detectAndMigrateExisting(): Promise<ProfileType> {
    let detectedType: ProfileType = "vanilla";

    // Check for Paper-specific files
    if (fs.existsSync(path.join(this.mcDir, "paper.yml")) ||
        fs.existsSync(path.join(this.mcDir, "paper-global.yml"))) {
      detectedType = "paper";
    }
    // Check for Fabric
    else if (fs.existsSync(path.join(this.mcDir, ".fabric")) ||
             fs.existsSync(path.join(this.mcDir, "fabric-server-launcher.properties"))) {
      detectedType = "fabric";
    }
    // Check for Forge
    else if (fs.existsSync(path.join(this.mcDir, "run.sh")) ||
             fs.existsSync(path.join(this.mcDir, ".forge-server"))) {
      detectedType = "forge";
    }

    console.log(`Detected existing server type: ${detectedType}`);

    // Move profile-specific files to the profile directory
    const profileDir = path.join(this.profilesDir, detectedType);
    const itemsToMove = this.profileSpecificItems[detectedType];

    for (const item of itemsToMove) {
      const srcPath = path.join(this.mcDir, item);
      const destPath = path.join(profileDir, item);

      if (fs.existsSync(srcPath) && !fs.lstatSync(srcPath).isSymbolicLink()) {
        // Move the file/directory
        fs.renameSync(srcPath, destPath);
        console.log(`Migrated ${item} to ${detectedType} profile`);
      }
    }

    // Save profile info
    const config = this.loadConfig();
    config.profiles[detectedType] = {
      type: detectedType,
      mcVersion: "unknown", // Would need to detect from JAR
      installedAt: new Date().toISOString(),
      isActive: true,
    };
    config.activeProfile = detectedType;
    this.saveConfig(config);

    // Create symlinks for the active profile
    await this.activateProfile(detectedType);

    return detectedType;
  }

  /**
   * Ensure shared world/config structure exists
   */
  private async ensureSharedStructure(): Promise<void> {
    // Create world directories if they don't exist
    for (const item of ["world", "world_nether", "world_the_end", "logs", "crash-reports"]) {
      const itemPath = path.join(this.mcDir, item);
      if (!fs.existsSync(itemPath)) {
        fs.mkdirSync(itemPath, { recursive: true });
      }
    }

    // Ensure EULA exists
    const eulaPath = path.join(this.mcDir, "eula.txt");
    if (!fs.existsSync(eulaPath)) {
      fs.writeFileSync(eulaPath, "eula=true\n");
    }
  }

  /**
   * Load profile configuration
   */
  loadConfig(): ProfileConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    }
    return {
      activeProfile: "paper",
      profiles: { paper: null, fabric: null, forge: null, vanilla: null },
    };
  }

  /**
   * Save profile configuration
   */
  private saveConfig(config: ProfileConfig): void {
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  /**
   * Get all profiles with their status
   */
  getProfiles(): Record<ProfileType, ProfileInfo | null> {
    const config = this.loadConfig();

    // Update isActive flag
    for (const type of Object.keys(config.profiles) as ProfileType[]) {
      if (config.profiles[type]) {
        config.profiles[type]!.isActive = type === config.activeProfile;
      }
    }

    return config.profiles;
  }

  /**
   * Get the currently active profile
   */
  getActiveProfile(): ProfileType {
    return this.loadConfig().activeProfile;
  }

  /**
   * Check if a profile is installed
   */
  isProfileInstalled(profileType: ProfileType): boolean {
    const config = this.loadConfig();
    return config.profiles[profileType] !== null;
  }

  /**
   * Install a profile (download server JAR)
   */
  async installProfile(
    profileType: ProfileType,
    mcVersion: string,
    loaderVersion?: string
  ): Promise<void> {
    const profileDir = path.join(this.profilesDir, profileType);
    fs.mkdirSync(profileDir, { recursive: true });

    const serverJar = path.join(profileDir, "server.jar");

    console.log(`Installing ${profileType} profile for MC ${mcVersion}...`);

    switch (profileType) {
      case "paper":
        await this.paperDownloader.downloadPaperJar(mcVersion, "latest", serverJar);
        fs.mkdirSync(path.join(profileDir, "plugins"), { recursive: true });
        break;

      case "vanilla":
        await this.vanillaDownloader.downloadVanillaServer(mcVersion, serverJar);
        break;

      case "fabric":
        await this.fabricDownloader.downloadServerJar(mcVersion, loaderVersion || "latest", serverJar);
        fs.mkdirSync(path.join(profileDir, "mods"), { recursive: true });
        break;

      case "forge":
        // Forge is special - installer runs in the profile directory
        await this.forgeDownloader.installForgeServer(profileDir, mcVersion, loaderVersion);
        fs.mkdirSync(path.join(profileDir, "mods"), { recursive: true });
        break;
    }

    // Update config
    const config = this.loadConfig();
    config.profiles[profileType] = {
      type: profileType,
      mcVersion,
      loaderVersion,
      installedAt: new Date().toISOString(),
      isActive: false,
    };
    this.saveConfig(config);

    // Set ownership
    execSync(`chown -R mc:mc ${profileDir}`, { stdio: "pipe" });

    console.log(`${profileType} profile installed successfully`);
  }

  /**
   * Switch to a different profile
   */
  async switchProfile(profileType: ProfileType): Promise<void> {
    const config = this.loadConfig();

    if (!config.profiles[profileType]) {
      throw new Error(`Profile ${profileType} is not installed`);
    }

    if (config.activeProfile === profileType) {
      console.log(`Profile ${profileType} is already active`);
      return;
    }

    console.log(`Switching from ${config.activeProfile} to ${profileType}...`);

    // Stop the server
    await this.stopServer();

    // Deactivate current profile (remove symlinks)
    await this.deactivateProfile(config.activeProfile);

    // Activate new profile (create symlinks)
    await this.activateProfile(profileType);

    // Update config
    config.activeProfile = profileType;
    for (const type of Object.keys(config.profiles) as ProfileType[]) {
      if (config.profiles[type]) {
        config.profiles[type]!.isActive = type === profileType;
      }
    }
    this.saveConfig(config);

    // Start the server
    await this.startServer();

    console.log(`Switched to ${profileType} profile`);
  }

  /**
   * Activate a profile by creating symlinks
   */
  private async activateProfile(profileType: ProfileType): Promise<void> {
    const profileDir = path.join(this.profilesDir, profileType);
    const items = this.profileSpecificItems[profileType];

    for (const item of items) {
      const srcPath = path.join(profileDir, item);
      const linkPath = path.join(this.mcDir, item);

      // Remove existing file/symlink if present
      if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
        fs.rmSync(linkPath, { recursive: true, force: true });
      }

      // Create symlink if source exists
      if (fs.existsSync(srcPath)) {
        fs.symlinkSync(srcPath, linkPath);
        console.log(`Linked ${item} -> ${srcPath}`);
      }
    }
  }

  /**
   * Deactivate a profile by removing symlinks
   */
  private async deactivateProfile(profileType: ProfileType): Promise<void> {
    const items = this.profileSpecificItems[profileType];

    for (const item of items) {
      const linkPath = path.join(this.mcDir, item);

      try {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(linkPath);
          console.log(`Unlinked ${item}`);
        }
      } catch {
        // File doesn't exist, that's fine
      }
    }
  }

  /**
   * Get the mods/plugins directory for a profile
   */
  getProfileModsDir(profileType?: ProfileType): string | null {
    const type = profileType || this.getActiveProfile();

    switch (type) {
      case "fabric":
      case "forge":
        return path.join(this.profilesDir, type, "mods");
      case "paper":
        return path.join(this.profilesDir, type, "plugins");
      default:
        return null;
    }
  }

  /**
   * Get available MC versions for a profile type
   */
  async getAvailableVersions(profileType: ProfileType): Promise<string[]> {
    switch (profileType) {
      case "paper":
        return this.paperDownloader.getAvailableVersions();
      case "vanilla":
        return this.vanillaDownloader.getAvailableReleases();
      case "fabric":
        return this.fabricDownloader.getAvailableVersions();
      case "forge":
        return this.forgeDownloader.getAvailableVersions();
    }
  }

  /**
   * Update a profile to a new version
   */
  async updateProfile(
    profileType: ProfileType,
    mcVersion: string,
    loaderVersion?: string
  ): Promise<void> {
    const wasActive = this.getActiveProfile() === profileType;

    if (wasActive) {
      await this.stopServer();
      await this.deactivateProfile(profileType);
    }

    // Backup existing profile
    const profileDir = path.join(this.profilesDir, profileType);
    const backupDir = path.join(this.profilesDir, `${profileType}.backup.${Date.now()}`);

    if (fs.existsSync(profileDir)) {
      fs.renameSync(profileDir, backupDir);
    }

    try {
      await this.installProfile(profileType, mcVersion, loaderVersion);

      // Restore mods/plugins from backup
      const modsDir = profileType === "paper" ? "plugins" : "mods";
      const backupMods = path.join(backupDir, modsDir);
      const newMods = path.join(profileDir, modsDir);

      if (fs.existsSync(backupMods)) {
        fs.cpSync(backupMods, newMods, { recursive: true });
      }

      // Clean up backup
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (error) {
      // Restore from backup on failure
      if (fs.existsSync(backupDir)) {
        fs.rmSync(profileDir, { recursive: true, force: true });
        fs.renameSync(backupDir, profileDir);
      }
      throw error;
    }

    if (wasActive) {
      await this.activateProfile(profileType);
      await this.startServer();
    }
  }

  /**
   * Delete a profile
   */
  async deleteProfile(profileType: ProfileType): Promise<void> {
    const config = this.loadConfig();

    if (config.activeProfile === profileType) {
      throw new Error("Cannot delete the active profile");
    }

    const profileDir = path.join(this.profilesDir, profileType);

    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }

    config.profiles[profileType] = null;
    this.saveConfig(config);
  }

  private async stopServer(): Promise<void> {
    try {
      execSync("systemctl stop minecraft", { stdio: "pipe" });
      // Wait for stop
      let attempts = 0;
      while (attempts < 30) {
        try {
          const status = execSync("systemctl is-active minecraft", { encoding: "utf8", stdio: "pipe" }).trim();
          if (status !== "active") break;
        } catch {
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
        attempts++;
      }
    } catch {
      // Server might not be running
    }
  }

  private async startServer(): Promise<void> {
    execSync("systemctl start minecraft", { stdio: "pipe" });
  }
}
