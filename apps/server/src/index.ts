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
  const { public_domain, local_port } = req.body;

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

app.listen(PORT, HOST, () => {
  console.log(`Management backend listening on http://${HOST}:${PORT}`);
});
