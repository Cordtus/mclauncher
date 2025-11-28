/**
 * @file Management Backend - API Gateway
 * @description
 * Runs in the management container
 * Provides HTTP API for the web UI and proxies requests to server control agents
 * Maintains registry of Minecraft servers and their control agent endpoints
 */

import express, { Request, Response } from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const REGISTRY_FILE = process.env.REGISTRY_FILE || "/opt/mc-lxd-manager/servers.json";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ALLOW_CIDRS = (process.env.ALLOW_CIDRS ?? "192.168.0.0/16,10.0.0.0/8")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TRUST_PROXY = (process.env.TRUST_PROXY ?? "true").toLowerCase() === "true";

interface ServerEntry {
  name: string;
  agent_url: string; // http://container-ip:9090
  local_ip?: string; // Container IP (e.g., 10.70.48.204)
  local_port?: number; // Minecraft port (usually 25565)
  host_ip?: string; // LXD host IP for local network connections (e.g., 192.168.0.170)
  public_port: number; // LXD proxy port on host
  public_domain?: string; // Optional public domain (e.g., mc.yourdomain.com)
  memory_mb: number;
  cpu_limit?: string;
  edition: string;
  mc_version: string;
}

interface ServerRegistry {
  servers: ServerEntry[];
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

if (TRUST_PROXY) {
  app.set("trust proxy", true);
}

// Load server registry
function loadRegistry(): ServerRegistry {
  if (!fs.existsSync(REGISTRY_FILE)) {
    return { servers: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  } catch {
    return { servers: [] };
  }
}

// Save server registry
function saveRegistry(registry: ServerRegistry) {
  const dir = path.dirname(REGISTRY_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

// Get client IP
function clientIp(req: Request): string {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const first = Array.isArray(xff) ? xff[0] : xff.split(",")[0];
      return String(first).trim();
    }
  }
  return req.socket?.remoteAddress || "";
}

// CIDR check
function ipInCidr(ip: string, cidr: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const n = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d{1,2})$/);
  if (!m || !n) return false;
  const ipParts = m.slice(1).map(Number);
  const netParts = n.slice(1, 5).map(Number);
  const bits = Number(n[5]);
  const ipNum = ((ipParts[0] << 24) >>> 0) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
  const netNum = ((netParts[0] << 24) >>> 0) + (netParts[1] << 16) + (netParts[2] << 8) + netParts[3];
  const mask = bits === 0 ? 0 : (~0 >>> (32 - bits)) << (32 - bits);
  return (ipNum & mask) === (netNum & mask);
}

// Auth middleware
function requireAdmin(req: Request, res: Response, next: () => void) {
  const ip = clientIp(req);
  const allowed = ALLOW_CIDRS.some((c) => ipInCidr(ip, c));
  if (!allowed) return res.status(403).json({ error: `Forbidden from ${ip}` });
  if (ADMIN_TOKEN) {
    const auth = String(req.headers["authorization"] || "");
    if (!auth.startsWith("Bearer ") || auth.split(" ", 2)[1] !== ADMIN_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  return next();
}

// Proxy helper
async function proxyToAgent(agentUrl: string, path: string, options: RequestInit = {}) {
  const url = `${agentUrl}${path}`;
  const response = await fetch(url, options);
  return response;
}

// Serve static frontend
app.use(express.static(path.resolve(process.cwd(), "apps/web/dist")));

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// List servers
app.get("/api/servers", async (_req, res) => {
  const registry = loadRegistry();
  const results = [];

  for (const server of registry.servers) {
    // Extract local IP from agent URL
    const localIp = server.local_ip || server.agent_url.match(/https?:\/\/([^:]+)/)?.[1] || "";
    const localPort = server.local_port || 25565;

    try {
      const statusRes = await proxyToAgent(server.agent_url, "/status");
      const status = await statusRes.json();

      results.push({
        name: server.name,
        status: status.active ? "Running" : "Stopped",

        // Connection info
        local_ip: localIp,
        local_port: localPort,
        host_ip: server.host_ip || null,
        public_port: server.public_port,
        public_domain: server.public_domain || null,

        // Server info
        memory_mb: server.memory_mb,
        cpu_limit: server.cpu_limit || "",
        edition: server.edition,
        mc_version: server.mc_version,
        agent_url: server.agent_url,

        // Minecraft status (players, MOTD, etc.)
        minecraft: status.minecraft || null,
      });
    } catch {
      results.push({
        name: server.name,
        status: "Unreachable",

        // Connection info
        local_ip: localIp,
        local_port: localPort,
        host_ip: server.host_ip || null,
        public_port: server.public_port,
        public_domain: server.public_domain || null,

        // Server info
        memory_mb: server.memory_mb,
        cpu_limit: server.cpu_limit || "",
        edition: server.edition,
        mc_version: server.mc_version,
        agent_url: server.agent_url,

        minecraft: null,
      });
    }
  }

  res.json(results);
});

// Register server (called manually or by setup script)
app.post("/api/servers/register", requireAdmin, (req, res) => {
  const { name, agent_url, public_port, memory_mb, cpu_limit, edition, mc_version } = req.body;
  if (!name || !agent_url) {
    return res.status(400).json({ error: "Missing name or agent_url" });
  }

  const registry = loadRegistry();
  const existing = registry.servers.find((s) => s.name === name);
  if (existing) {
    return res.status(400).json({ error: "Server already registered" });
  }

  registry.servers.push({
    name,
    agent_url,
    public_port: Number(public_port || 25565),
    memory_mb: Number(memory_mb || 2048),
    cpu_limit,
    edition: edition || "paper",
    mc_version: mc_version || "1.21.1",
  });

  saveRegistry(registry);
  res.json({ ok: true, message: `Server ${name} registered` });
});

// Unregister server
app.delete("/api/servers/:name/unregister", requireAdmin, (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const index = registry.servers.findIndex((s) => s.name === name);
  if (index === -1) {
    return res.status(404).json({ error: "Server not found" });
  }

  registry.servers.splice(index, 1);
  saveRegistry(registry);
  res.json({ ok: true, message: `Server ${name} unregistered` });
});

// Update server configuration
app.patch("/api/servers/:name/config", requireAdmin, (req, res) => {
  const { name } = req.params;
  const { public_domain, local_port, host_ip } = req.body;

  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) {
    return res.status(404).json({ error: "Server not found" });
  }

  // Update fields
  if (public_domain !== undefined) {
    server.public_domain = public_domain || undefined;
  }
  if (local_port !== undefined) {
    server.local_port = Number(local_port);
  }
  if (host_ip !== undefined) {
    server.host_ip = host_ip || undefined;
  }

  saveRegistry(registry);
  res.json({ ok: true, message: `Server ${name} configuration updated`, server });
});

// Proxy endpoints to server agents

// Start server
app.post("/api/servers/:name/start", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).json({ error: "Server not found" });

  try {
    const response = await proxyToAgent(server.agent_url, "/start", { method: "POST" });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Stop server
app.post("/api/servers/:name/stop", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).json({ error: "Server not found" });

  try {
    const response = await proxyToAgent(server.agent_url, "/stop", { method: "POST" });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Restart server
app.post("/api/servers/:name/restart", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).json({ error: "Server not found" });

  try {
    const response = await proxyToAgent(server.agent_url, "/restart", { method: "POST" });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get logs
app.get("/api/servers/:name/logs", async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/logs");
    const text = await response.text();
    res.type("text/plain").send(text);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// Get TPS
app.get("/api/servers/:name/tps", async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/tps");
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get JVM settings
app.get("/api/servers/:name/jvm/settings", async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/jvm/settings");
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update JVM settings
app.post("/api/servers/:name/jvm/settings", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/jvm/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Check if public connection is accessible
app.get("/api/servers/:name/check-public", async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  if (!server.public_domain) {
    return res.json({ accessible: false, reason: "No public domain configured" });
  }

  try {
    // Try to connect to the public domain on the Minecraft port
    // Use a simple TCP connection check (could also use mcsrvstat.us API)
    const publicUrl = `https://api.mcsrvstat.us/3/${server.public_domain}:${server.public_port}`;
    const response = await fetch(publicUrl, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();

    return res.json({
      accessible: data.online === true,
      info: data
    });
  } catch (err: any) {
    return res.json({
      accessible: false,
      reason: err.message
    });
  }
});

// Get config
app.get("/api/servers/:name/config", async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/config");
    const text = await response.text();
    res.type("text/plain").send(text);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// Update config
app.post("/api/servers/:name/config", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const text = await response.text();
    res.type("text/plain").send(text);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// ============================================================================
// Settings Management Routes
// ============================================================================

// Apply structured server settings
app.post("/api/servers/:name/settings", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get whitelist
app.get("/api/servers/:name/settings/whitelist", async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings/whitelist");
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Add to whitelist
app.post("/api/servers/:name/settings/whitelist/add", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings/whitelist/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Remove from whitelist
app.post("/api/servers/:name/settings/whitelist/remove", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings/whitelist/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get operators
app.get("/api/servers/:name/settings/operators", async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings/operators");
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Add operator
app.post("/api/servers/:name/settings/operators/add", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings/operators/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Remove operator
app.post("/api/servers/:name/settings/operators/remove", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings/operators/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// BAN MANAGEMENT ENDPOINTS
// ============================================================================

// Get all bans
app.get("/api/servers/:name/settings/bans", async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings/bans");
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Ban a player
app.post("/api/servers/:name/settings/bans/player/add", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings/bans/player/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Pardon a player
app.post("/api/servers/:name/settings/bans/player/remove", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings/bans/player/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Ban an IP
app.post("/api/servers/:name/settings/bans/ip/add", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings/bans/ip/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Pardon an IP
app.post("/api/servers/:name/settings/bans/ip/remove", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings/bans/ip/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Proxy file uploads (plugins/mods/worlds)
async function proxyFileUpload(req: Request, res: Response, endpoint: string) {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const formData = new FormData();
    if (req.file) {
      const blob = new Blob([fs.readFileSync(req.file.path)]);
      formData.append("file", blob, req.file.originalname);
      fs.unlinkSync(req.file.path); // Clean up temp file
    }

    const response = await proxyToAgent(server.agent_url, endpoint, {
      method: "POST",
      body: formData,
    });
    const text = await response.text();
    res.type("text/plain").send(text);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
}

// File upload endpoints (need multer in this app too)
import multer from "multer";
import os from "os";
const upload = multer({ dest: os.tmpdir() });

app.post("/api/servers/:name/plugins", requireAdmin, upload.single("file"), (req, res) =>
  proxyFileUpload(req, res, "/plugins")
);

app.post("/api/servers/:name/mods", requireAdmin, upload.single("file"), (req, res) =>
  proxyFileUpload(req, res, "/mods")
);

app.post("/api/servers/:name/worlds/upload", requireAdmin, upload.single("file"), (req, res) =>
  proxyFileUpload(req, res, "/worlds/upload")
);

// Packwiz
app.post("/api/servers/:name/packwiz", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/packwiz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const text = await response.text();
    res.type("text/plain").send(text);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// LuckPerms
app.post("/api/servers/:name/luckperms", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/luckperms", { method: "POST" });
    const text = await response.text();
    res.type("text/plain").send(text);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// List worlds
app.get("/api/servers/:name/worlds", async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).json({ error: "Server not found" });

  try {
    const response = await proxyToAgent(server.agent_url, "/worlds");
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Switch world
app.post("/api/servers/:name/worlds/switch", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/worlds/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const text = await response.text();
    res.type("text/plain").send(text);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// RCON command
app.post("/api/servers/:name/command", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const text = await response.text();
    res.type("text/plain").send(text);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// Backup
app.post("/api/servers/:name/backup", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/backup", { method: "POST" });
    const text = await response.text();
    res.type("text/plain").send(text);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// ============================================================================
// MOD MANAGEMENT ENDPOINTS (Modrinth API Integration)
// ============================================================================

import * as modrinth from './services/modrinth.js';

// Search for mods or plugins
app.get("/api/mods/search", async (req, res) => {
  try {
    const {
      query = '',
      mcVersion,
      loader,
      projectType,
      category,
      limit,
      offset,
      sort
    } = req.query;

    const results = await modrinth.searchMods({
      query: query as string,
      mcVersion: mcVersion as string | undefined,
      loader: loader as any,
      projectType: projectType as 'mod' | 'plugin' | undefined,
      category: category as string | undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
      sort: sort as any
    });

    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get mod details
app.get("/api/mods/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const mod = await modrinth.getModDetails(projectId);
    res.json(mod);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get mod versions
app.get("/api/mods/:projectId/versions", async (req, res) => {
  try {
    const { projectId } = req.params;
    const { mcVersion, loader } = req.query;

    const versions = await modrinth.getModVersions(
      projectId,
      mcVersion as string | undefined,
      loader as string | undefined
    );

    res.json(versions);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Check mod compatibility
app.post("/api/mods/check-compatibility", async (req, res) => {
  try {
    const { mod, serverMemoryMB, installedMods, currentMemoryUsage } = req.body;

    // Estimate resource impact
    const compatibility = modrinth.estimateResourceImpact(mod);

    // Check conflicts
    const conflicts = modrinth.checkModConflicts(
      mod.project_id,
      mod.categories,
      installedMods || []
    );

    // Check resource availability
    const resourceCheck = modrinth.checkResourceAvailability(
      serverMemoryMB || 8192,
      compatibility,
      currentMemoryUsage || 0
    );

    res.json({
      ...compatibility,
      conflicts,
      resourceAvailable: resourceCheck.sufficient,
      resourceWarning: resourceCheck.warning
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Check mod dependencies
app.post("/api/mods/check-dependencies", async (req, res) => {
  try {
    const { versionId, mcVersion, loader, installedModIds } = req.body;

    if (!versionId || !mcVersion || !loader) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const dependencies = await modrinth.getModDependencies(
      versionId,
      mcVersion,
      loader,
      installedModIds || []
    );

    res.json(dependencies);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Install a mod (download and upload to server)
app.post("/api/servers/:name/mods/install", requireAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const { downloadUrl, fileName, projectId, versionId } = req.body;

    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    // Download the mod from Modrinth
    const modData = await modrinth.downloadMod(downloadUrl);

    // Create form data to upload to the server
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', modData, fileName);

    // Upload to the server's mods folder via agent
    const uploadResponse = await fetch(`${server.agent_url}/mods`, {
      method: 'POST',
      body: form as any,
      headers: form.getHeaders()
    });

    if (!uploadResponse.ok) {
      throw new Error('Failed to upload mod to server');
    }

    res.json({
      success: true,
      message: `Mod ${fileName} installed successfully`,
      projectId,
      versionId
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List installed mods
app.get("/api/servers/:name/mods/installed", async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    // Get list of installed mods from agent
    const response = await fetch(`${server.agent_url}/mods/list`);
    if (!response.ok) {
      throw new Error('Failed to fetch installed mods');
    }

    const mods = await response.json();
    res.json(mods);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a mod
app.delete("/api/servers/:name/mods/:fileName", requireAdmin, async (req, res) => {
  try {
    const { name, fileName } = req.params;
    const { removeConfigs } = req.query;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    // Delete mod via agent
    const url = `${server.agent_url}/mods/${fileName}${removeConfigs ? '?removeConfigs=true' : ''}`;
    const response = await fetch(url, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error('Failed to remove mod');
    }

    res.json({ success: true, message: `Mod ${fileName} removed` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get mod metadata
app.get("/api/servers/:name/mods/:fileName/metadata", async (req, res) => {
  try {
    const { name, fileName } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(`${server.agent_url}/mods/${fileName}/metadata`);
    if (!response.ok) {
      throw new Error('Failed to get mod metadata');
    }

    const metadata = await response.json();
    res.json(metadata);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get mod icon
app.get("/api/servers/:name/mods/:fileName/icon", async (req, res) => {
  try {
    const { name, fileName } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(`${server.agent_url}/mods/${fileName}/icon`);
    if (!response.ok) {
      return res.status(404).send("Icon not found");
    }

    const buffer = await response.arrayBuffer();
    res.contentType('image/png').send(Buffer.from(buffer));
  } catch (err: any) {
    res.status(404).send("Icon not found");
  }
});

// Enable/disable mod
app.patch("/api/servers/:name/mods/:fileName/toggle", requireAdmin, async (req, res) => {
  try {
    const { name, fileName } = req.params;
    const { enabled } = req.body;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(`${server.agent_url}/mods/${fileName}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });

    if (!response.ok) {
      throw new Error('Failed to toggle mod');
    }

    const result = await response.json();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List mod config files
app.get("/api/servers/:name/mods/:modId/configs", async (req, res) => {
  try {
    const { name, modId } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(`${server.agent_url}/mods/${modId}/configs`);
    if (!response.ok) {
      throw new Error('Failed to list config files');
    }

    const configs = await response.json();
    res.json(configs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get mod config file
app.get("/api/servers/:name/mods/:modId/config/:fileName", async (req, res) => {
  try {
    const { name, modId, fileName } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(`${server.agent_url}/mods/${modId}/config/${fileName}`);
    if (!response.ok) {
      throw new Error('Failed to get config file');
    }

    const config = await response.json();
    res.json(config);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update mod config file
app.post("/api/servers/:name/mods/:modId/config/:fileName", requireAdmin, async (req, res) => {
  try {
    const { name, modId, fileName } = req.params;
    const { updates } = req.body;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(`${server.agent_url}/mods/${modId}/config/${fileName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates })
    });

    if (!response.ok) {
      throw new Error('Failed to update config file');
    }

    const result = await response.json();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// MODPACK EXPORT ENDPOINTS
// ============================================================================

import * as modpack from './services/modpack.js';

// Get modpack info (metadata + mod list for export)
app.get("/api/servers/:name/modpack", async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    // Get installed mods from agent
    const response = await fetch(`${server.agent_url}/mods/list`);
    if (!response.ok) {
      throw new Error('Failed to fetch installed mods');
    }

    const data = await response.json();
    const mods = data.mods || [];

    // Get loader type from server edition or detect from mods
    let loader: 'forge' | 'fabric' | 'neoforge' | 'quilt' = 'fabric';
    if (mods.length > 0) {
      const loaderMod = mods.find((m: any) => m.loader && m.loader !== 'unknown');
      if (loaderMod) {
        loader = loaderMod.loader;
      }
    }

    res.json({
      name: server.name,
      mcVersion: server.mc_version,
      loader,
      modsCount: mods.length,
      enabledCount: mods.filter((m: any) => m.enabled).length,
      mods: mods.map((m: any) => ({
        modId: m.modId,
        name: m.name,
        version: m.version,
        description: m.description,
        enabled: m.enabled,
        clientRequired: true, // We'll update this when we have more info
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Export modpack as .mrpack (Modrinth format)
app.get("/api/servers/:name/modpack/export/mrpack", async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    // Get installed mods
    const response = await fetch(`${server.agent_url}/mods/list`);
    if (!response.ok) {
      throw new Error('Failed to fetch installed mods');
    }

    const data = await response.json();
    const mods = data.mods || [];

    // Detect loader
    let loader: 'forge' | 'fabric' | 'neoforge' | 'quilt' = 'fabric';
    const loaderMod = mods.find((m: any) => m.loader && m.loader !== 'unknown');
    if (loaderMod) {
      loader = loaderMod.loader;
    }

    // Generate modpack
    const metadata: modpack.ModpackMetadata = {
      name: `${server.name} Modpack`,
      summary: `Modpack for ${server.name} Minecraft server`,
      versionId: '1.0.0',
      mcVersion: server.mc_version,
      loader,
    };

    const result = await modpack.generateMrpack(metadata, mods);

    // Set headers for file download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${server.name}-modpack.mrpack"`);
    res.send(result.buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Export mod list as text
app.get("/api/servers/:name/modpack/export/list", async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    // Get installed mods
    const response = await fetch(`${server.agent_url}/mods/list`);
    if (!response.ok) {
      throw new Error('Failed to fetch installed mods');
    }

    const data = await response.json();
    const mods = data.mods || [];

    // Detect loader
    let loader: 'forge' | 'fabric' | 'neoforge' | 'quilt' = 'fabric';
    const loaderMod = mods.find((m: any) => m.loader && m.loader !== 'unknown');
    if (loaderMod) {
      loader = loaderMod.loader;
    }

    const metadata: modpack.ModpackMetadata = {
      name: `${server.name} Modpack`,
      summary: `Modpack for ${server.name} Minecraft server`,
      versionId: '1.0.0',
      mcVersion: server.mc_version,
      loader,
    };

    const modList = modpack.generateModList(metadata, mods);

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${server.name}-modlist.txt"`);
    res.send(modList);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Generate public download page HTML
app.get("/api/servers/:name/modpack/page", async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    // Get installed mods
    const response = await fetch(`${server.agent_url}/mods/list`);
    if (!response.ok) {
      throw new Error('Failed to fetch installed mods');
    }

    const data = await response.json();
    const mods = data.mods || [];

    // Detect loader
    let loader: 'forge' | 'fabric' | 'neoforge' | 'quilt' = 'fabric';
    const loaderMod = mods.find((m: any) => m.loader && m.loader !== 'unknown');
    if (loaderMod) {
      loader = loaderMod.loader;
    }

    const metadata: modpack.ModpackMetadata = {
      name: `${server.name} Modpack`,
      summary: `Modpack for ${server.name} Minecraft server`,
      versionId: '1.0.0',
      mcVersion: server.mc_version,
      loader,
    };

    // Build server address
    const serverAddress = server.public_domain ||
      `${server.host_ip || 'localhost'}:${server.public_port || 25565}`;

    const html = await modpack.generateDownloadPage(
      server.name,
      serverAddress,
      metadata,
      mods
    );

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUBLIC MODPACK ENDPOINTS (No auth required)
// These are designed to be accessed by players who need to download the modpack
// ============================================================================

// Public modpack download page - serves the standalone HTML
app.get("/public/:name/modpack", async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    // Get installed mods
    const response = await fetch(`${server.agent_url}/mods/list`);
    if (!response.ok) {
      throw new Error('Failed to fetch installed mods');
    }

    const data = await response.json();
    const mods = data.mods || [];

    // Detect loader
    let loader: 'forge' | 'fabric' | 'neoforge' | 'quilt' = 'fabric';
    const loaderMod = mods.find((m: any) => m.loader && m.loader !== 'unknown');
    if (loaderMod) {
      loader = loaderMod.loader;
    }

    const metadata: modpack.ModpackMetadata = {
      name: `${server.name} Modpack`,
      summary: `Modpack for ${server.name} Minecraft server`,
      versionId: '1.0.0',
      mcVersion: server.mc_version,
      loader,
    };

    const serverAddress = server.public_domain ||
      `${server.host_ip || 'localhost'}:${server.public_port || 25565}`;

    const html = await modpack.generateDownloadPage(
      server.name,
      serverAddress,
      metadata,
      mods
    );

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err: any) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// Public modpack .mrpack download
app.get("/public/:name/modpack.mrpack", async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(`${server.agent_url}/mods/list`);
    if (!response.ok) {
      throw new Error('Failed to fetch installed mods');
    }

    const data = await response.json();
    const mods = data.mods || [];

    let loader: 'forge' | 'fabric' | 'neoforge' | 'quilt' = 'fabric';
    const loaderMod = mods.find((m: any) => m.loader && m.loader !== 'unknown');
    if (loaderMod) {
      loader = loaderMod.loader;
    }

    const metadata: modpack.ModpackMetadata = {
      name: `${server.name} Modpack`,
      summary: `Modpack for ${server.name} Minecraft server`,
      versionId: '1.0.0',
      mcVersion: server.mc_version,
      loader,
    };

    const result = await modpack.generateMrpack(metadata, mods);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${server.name}-modpack.mrpack"`);
    res.send(result.buffer);
  } catch (err: any) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// Public mod list download
app.get("/public/:name/modlist.txt", async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(`${server.agent_url}/mods/list`);
    if (!response.ok) {
      throw new Error('Failed to fetch installed mods');
    }

    const data = await response.json();
    const mods = data.mods || [];

    let loader: 'forge' | 'fabric' | 'neoforge' | 'quilt' = 'fabric';
    const loaderMod = mods.find((m: any) => m.loader && m.loader !== 'unknown');
    if (loaderMod) {
      loader = loaderMod.loader;
    }

    const metadata: modpack.ModpackMetadata = {
      name: `${server.name} Modpack`,
      summary: `Modpack for ${server.name} Minecraft server`,
      versionId: '1.0.0',
      mcVersion: server.mc_version,
      loader,
    };

    const modList = modpack.generateModList(metadata, mods);

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${server.name}-modlist.txt"`);
    res.send(modList);
  } catch (err: any) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Management backend listening on http://${HOST}:${PORT}`);
});
