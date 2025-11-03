/**
 * @file Control Agent for Minecraft Server Container
 * @description
 * Runs inside each Minecraft server container on port 9090
 * Provides HTTP API for the management UI to control this server
 * - Start/stop/restart Minecraft service
 * - Stream logs
 * - Upload plugins/mods/worlds
 * - Edit server.properties
 * - Execute RCON commands
 * - Create backups
 */

import express, { Request, Response } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { spawnSync, spawn } from "child_process";
import os from "os";
import { VersionManager } from "./managers/version.js";
import { WorldManager } from "./managers/world.js";
import { PaperDownloader } from "./downloaders/paper.js";
import { VanillaDownloader } from "./downloaders/vanilla.js";
import { pingMinecraftServer } from "./utils/mcping.js";

const PORT = Number(process.env.AGENT_PORT || 9090);
const MC_DIR = process.env.MC_DIR || "/opt/minecraft";
const MC_PORT = Number(process.env.MC_PORT || 25565);
const WORLDS_HOME = path.join(MC_DIR, "worlds");
const WORLD_LINK = path.join(MC_DIR, "world");
const RCON_PORT = Number(process.env.RCON_PORT || 25575);

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: os.tmpdir() });

// Initialize managers
const versionManager = new VersionManager(MC_DIR);
const worldManager = new WorldManager(MC_DIR);
const paperDownloader = new PaperDownloader();
const vanillaDownloader = new VanillaDownloader();

// Helper: run command synchronously
function sh(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`Failed: ${cmd} ${args.join(" ")}\n${res.stderr}`);
  return res.stdout;
}

// Helper: run command without throwing
function shSafe(cmd: string, args: string[]) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  return { stdout: res.stdout, stderr: res.stderr, code: res.status ?? -1 };
}

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mc-agent" });
});

// Get server status
app.get("/status", async (_req, res) => {
  const status = shSafe("systemctl", ["is-active", "minecraft"]);
  const enabled = shSafe("systemctl", ["is-enabled", "minecraft"]);
  const isActive = status.stdout.trim() === "active";

  let mcStatus = null;
  if (isActive) {
    try {
      mcStatus = await pingMinecraftServer("localhost", MC_PORT, 3000);
    } catch (err) {
      // Server might be starting up or not responding to pings
      mcStatus = { online: false };
    }
  }

  res.json({
    active: isActive,
    enabled: enabled.stdout.trim() === "enabled",
    status: status.stdout.trim(),
    minecraft: mcStatus,
  });
});

// Start Minecraft server
app.post("/start", (_req, res) => {
  try {
    sh("systemctl", ["start", "minecraft"]);
    res.json({ ok: true, message: "Server started" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Stop Minecraft server
app.post("/stop", (_req, res) => {
  try {
    sh("systemctl", ["stop", "minecraft"]);
    res.json({ ok: true, message: "Server stopped" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Restart Minecraft server
app.post("/restart", (_req, res) => {
  try {
    sh("systemctl", ["restart", "minecraft"]);
    res.json({ ok: true, message: "Server restarted" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get logs
app.get("/logs", (_req, res) => {
  const result = shSafe("journalctl", ["-u", "minecraft", "--no-pager", "-n", "200"]);
  if (result.code !== 0) {
    // Fallback to log file
    const logPath = path.join(MC_DIR, "logs", "latest.log");
    if (fs.existsSync(logPath)) {
      const logs = sh("tail", ["-n", "200", logPath]);
      return res.type("text/plain").send(logs);
    }
  }
  res.type("text/plain").send(result.stdout);
});

// Get server.properties
app.get("/config", (_req, res) => {
  const configPath = path.join(MC_DIR, "server.properties");
  if (!fs.existsSync(configPath)) {
    return res.status(404).send("server.properties not found");
  }
  res.type("text/plain").send(fs.readFileSync(configPath, "utf8"));
});

// Update server.properties
app.post("/config", (req, res) => {
  const { content } = req.body;
  if (typeof content !== "string") {
    return res.status(400).send("Missing content");
  }
  const configPath = path.join(MC_DIR, "server.properties");
  try {
    fs.writeFileSync(configPath, content, "utf8");
    sh("chown", ["mc:mc", configPath]);
    sh("systemctl", ["restart", "minecraft"]);
    res.send("Configuration saved and server restarted");
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload plugin
app.post("/plugins", upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send("Missing file");
  if (!file.originalname.endsWith(".jar")) {
    fs.unlinkSync(file.path);
    return res.status(400).send("File must be a .jar");
  }

  try {
    const dest = path.join(MC_DIR, "plugins", file.originalname);
    fs.mkdirSync(path.join(MC_DIR, "plugins"), { recursive: true });
    fs.copyFileSync(file.path, dest);
    fs.unlinkSync(file.path);
    sh("chown", ["-R", "mc:mc", path.join(MC_DIR, "plugins")]);
    res.send(`Plugin ${file.originalname} uploaded. Restart server to load.`);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload mod
app.post("/mods", upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send("Missing file");
  if (!file.originalname.endsWith(".jar")) {
    fs.unlinkSync(file.path);
    return res.status(400).send("File must be a .jar");
  }

  try {
    const dest = path.join(MC_DIR, "mods", file.originalname);
    fs.mkdirSync(path.join(MC_DIR, "mods"), { recursive: true });
    fs.copyFileSync(file.path, dest);
    fs.unlinkSync(file.path);
    sh("chown", ["-R", "mc:mc", path.join(MC_DIR, "mods")]);
    res.send(`Mod ${file.originalname} uploaded. Restart server to load.`);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Packwiz sync
app.post("/packwiz", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).send("Missing url");

  const cmd = `cd ${MC_DIR} && curl -sL ${JSON.stringify(url)} -o pack.toml && packwiz refresh || packwiz modrinth install || true && chown -R mc:mc ${MC_DIR}`;
  const result = shSafe("bash", ["-c", cmd]);
  res.type("text/plain").send(result.stdout + "\n" + result.stderr);
});

// Install LuckPerms
app.post("/luckperms", (_req, res) => {
  try {
    const pluginsDir = path.join(MC_DIR, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    sh("bash", [
      "-c",
      `cd ${pluginsDir} && curl -sL https://download.luckperms.net/latest/bukkit.jar -o LuckPerms.jar && chown mc:mc LuckPerms.jar`,
    ]);
    res.send("LuckPerms installed. Restart server to load.");
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List worlds
app.get("/worlds", (_req, res) => {
  try {
    // Ensure worlds directory structure
    fs.mkdirSync(WORLDS_HOME, { recursive: true });

    // If world exists and is not a symlink, migrate it
    if (fs.existsSync(WORLD_LINK) && !fs.lstatSync(WORLD_LINK).isSymbolicLink()) {
      const defaultWorld = path.join(WORLDS_HOME, "default");
      fs.mkdirSync(defaultWorld, { recursive: true });
      sh("rsync", ["-a", "--delete", `${WORLD_LINK}/`, `${defaultWorld}/`]);
      fs.rmSync(WORLD_LINK, { recursive: true, force: true });
      fs.symlinkSync(defaultWorld, WORLD_LINK);
    }

    const worlds: string[] = [];
    if (fs.existsSync(WORLDS_HOME)) {
      const entries = fs.readdirSync(WORLDS_HOME);
      for (const entry of entries) {
        const levelDat = path.join(WORLDS_HOME, entry, "level.dat");
        if (fs.existsSync(levelDat)) {
          worlds.push(entry);
        }
      }
    }
    res.json(worlds);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload world
app.post("/worlds/upload", upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send("Missing file");
  if (!file.originalname.endsWith(".zip")) {
    fs.unlinkSync(file.path);
    return res.status(400).send("File must be a .zip");
  }

  const worldName = path.parse(file.originalname).name;
  const worldPath = path.join(WORLDS_HOME, worldName);

  try {
    // Stop server
    shSafe("systemctl", ["stop", "minecraft"]);

    // Create world directory
    fs.mkdirSync(WORLDS_HOME, { recursive: true });
    fs.rmSync(worldPath, { recursive: true, force: true });
    fs.mkdirSync(worldPath, { recursive: true });

    // Extract zip
    sh("unzip", ["-oq", file.path, "-d", worldPath]);
    fs.unlinkSync(file.path);

    // Update symlink
    if (fs.existsSync(WORLD_LINK)) {
      fs.unlinkSync(WORLD_LINK);
    }
    fs.symlinkSync(worldPath, WORLD_LINK);

    // Fix permissions
    sh("chown", ["-R", "mc:mc", worldPath]);

    // Start server
    sh("systemctl", ["start", "minecraft"]);

    res.send(`World '${worldName}' uploaded and activated`);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Switch world
app.post("/worlds/switch", (req, res) => {
  const { world_name } = req.body;
  if (!world_name) return res.status(400).send("Missing world_name");

  const worldPath = path.join(WORLDS_HOME, world_name);
  if (!fs.existsSync(worldPath)) {
    return res.status(404).send(`World '${world_name}' not found`);
  }

  try {
    // Stop server
    sh("systemctl", ["stop", "minecraft"]);

    // Update symlink
    if (fs.existsSync(WORLD_LINK)) {
      fs.unlinkSync(WORLD_LINK);
    }
    fs.symlinkSync(worldPath, WORLD_LINK);

    // Start server
    sh("systemctl", ["start", "minecraft"]);

    res.send(`Switched to world '${world_name}'`);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// RCON command
app.post("/command", (req, res) => {
  const { rcon_password, command } = req.body;
  if (!rcon_password || !command) {
    return res.status(400).send("Missing rcon_password or command");
  }

  const result = shSafe("mcrcon", [
    "-P",
    String(RCON_PORT),
    "-p",
    rcon_password,
    command,
  ]);

  res.type("text/plain").send(result.stdout + "\n" + result.stderr);
});

// Create backup
app.post("/backup", (_req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    const backupDir = "/var/backups/minecraft";
    fs.mkdirSync(backupDir, { recursive: true });

    const backupFile = path.join(backupDir, `backup-${timestamp}.tar.gz`);

    // Stop server for consistent backup
    sh("systemctl", ["stop", "minecraft"]);

    // Create tarball
    sh("tar", ["-czf", backupFile, "-C", MC_DIR, "."]);

    // Start server
    sh("systemctl", ["start", "minecraft"]);

    res.send(`Backup created: ${backupFile}`);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Version Management Endpoints =====

// Get available Paper versions
app.get("/versions/paper", async (_req, res) => {
  try {
    const versions = await paperDownloader.getAvailableVersions();
    res.json({ versions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get available Vanilla versions
app.get("/versions/vanilla", async (_req, res) => {
  try {
    const releases = await vanillaDownloader.getAvailableReleases();
    const manifest = await vanillaDownloader.getManifest();
    res.json({
      latest: manifest.latest,
      releases,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get builds for Paper version
app.get("/versions/paper/:version/builds", async (req, res) => {
  try {
    const buildNum = await paperDownloader.getLatestBuild(req.params.version);
    const buildInfo = await paperDownloader.getBuildInfo(
      req.params.version,
      buildNum
    );
    res.json({ latestBuild: buildNum, buildInfo });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Change server version
app.post("/version/change", async (req, res) => {
  const { type, version, build } = req.body;

  if (!["paper", "vanilla"].includes(type)) {
    return res.status(400).send("Invalid type. Must be paper or vanilla");
  }

  if (!version) {
    return res.status(400).send("Version is required");
  }

  try {
    await versionManager.changeVersion(type, version, build);
    res.json({
      ok: true,
      message: `Server updated to ${type} ${version}`,
      type,
      version,
      build: type === "paper" ? build : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Switch server type (Paper ↔ Vanilla)
app.post("/version/switch-type", async (req, res) => {
  const { type, version, build } = req.body;

  if (!["paper", "vanilla"].includes(type)) {
    return res.status(400).send("Invalid type");
  }

  try {
    await versionManager.switchServerType(type, version, build);
    res.json({
      ok: true,
      message: `Switched to ${type} ${version}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Enhanced World Management Endpoints =====

// List worlds with details
app.get("/worlds/list", async (_req, res) => {
  try {
    await worldManager.initialize();
    const worlds = await worldManager.listWorlds();
    res.json(worlds);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get current world
app.get("/worlds/current", (_req, res) => {
  try {
    const current = worldManager.getCurrentWorld();
    res.json({ current });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Switch to world
app.post("/worlds/switch-to", async (req, res) => {
  const { worldName } = req.body;
  if (!worldName) return res.status(400).send("Missing worldName");

  try {
    await worldManager.switchWorld(worldName);
    res.json({ ok: true, message: `Switched to world '${worldName}'` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete world
app.delete("/worlds/:worldName", async (req, res) => {
  try {
    await worldManager.deleteWorld(req.params.worldName, false);
    res.json({ ok: true, message: `World '${req.params.worldName}' deleted` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Backup world
app.post("/worlds/:worldName/backup", async (req, res) => {
  try {
    const backupPath = await worldManager.backupWorld(req.params.worldName);
    res.json({ ok: true, backupPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Import world
app.post("/worlds/import", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send("Missing file");

  try {
    const worldName = await worldManager.importWorld(file.path, req.body.worldName);
    fs.unlinkSync(file.path);
    res.json({ ok: true, worldName, message: `World '${worldName}' imported` });
  } catch (err: any) {
    if (file) fs.unlinkSync(file.path);
    res.status(500).json({ error: err.message });
  }
});

// Export world
app.get("/worlds/:worldName/export", async (req, res) => {
  try {
    const outputPath = `/tmp/${req.params.worldName}-${Date.now()}.zip`;
    await worldManager.exportWorld(req.params.worldName, outputPath);
    res.download(outputPath, `${req.params.worldName}.zip`, (err) => {
      fs.unlinkSync(outputPath);
      if (err) console.error("Download error:", err);
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Control agent listening on port ${PORT}`);
});
