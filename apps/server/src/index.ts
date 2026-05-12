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
import { fileURLToPath } from "url";
import { timingSafeEqual } from "crypto";
import "dotenv/config";
import { PasskeyService } from "./services/passkeys.js";
import * as modpack from "./services/modpack.js";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const REGISTRY_FILE = process.env.REGISTRY_FILE || "/opt/mc-lxd-manager/servers.json";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ALLOW_CIDRS = (process.env.ALLOW_CIDRS ?? "127.0.0.0/8,192.168.0.0/24,10.70.48.0/24")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TRUST_PROXY = (process.env.TRUST_PROXY ?? "false").toLowerCase() === "true";
const TRUST_PROXY_CIDRS = (process.env.TRUST_PROXY_CIDRS ?? "loopback")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIR = process.env.WEB_DIST_DIR || path.resolve(MODULE_DIR, "../../web/dist");
const ADMIN_AUTH_METHODS = new Set(
  (process.env.ADMIN_AUTH_METHODS ?? "token,passkey")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const ADMIN_REQUIRE_CIDR = (process.env.ADMIN_REQUIRE_CIDR ?? "true").toLowerCase() !== "false";
const PASSKEYS_ENABLED = (process.env.PASSKEYS_ENABLED ?? "true").toLowerCase() !== "false";
const PASSKEY_USER_VERIFICATION = (
  ["preferred", "required", "discouraged"].includes(process.env.PASSKEY_USER_VERIFICATION || "")
    ? process.env.PASSKEY_USER_VERIFICATION
    : "preferred"
) as "preferred" | "required" | "discouraged";
const PASSKEY_STORE_FILE = process.env.PASSKEY_STORE_FILE || path.join(path.dirname(REGISTRY_FILE), "passkeys.json");
const PASSKEY_SESSION_TTL_MS = Number(process.env.PASSKEY_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const PASSKEY_CHALLENGE_TTL_MS = Number(process.env.PASSKEY_CHALLENGE_TTL_MS || 5 * 60 * 1000);
const DEFAULT_MINECRAFT_PORT = 25565;

interface ServerEntry {
  name: string;
  agent_url: string; // http://container-ip:9090
  local_ip?: string; // Container IP (e.g., 10.70.48.204)
  local_port?: number; // Minecraft port (usually 25565)
  host_ip?: string; // LXD host IP for local network connections (e.g., 192.168.0.170)
  host_proxy_port?: number; // LXD host proxy port that receives router-forwarded traffic
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
  app.set("trust proxy", TRUST_PROXY_CIDRS);
}

const passkeys = new PasskeyService({
  enabled: PASSKEYS_ENABLED && ADMIN_AUTH_METHODS.has("passkey"),
  rpName: process.env.PASSKEY_RP_NAME || "MC LXD Manager",
  rpId: process.env.PASSKEY_RP_ID || undefined,
  origin: process.env.PASSKEY_ORIGIN || undefined,
  storeFile: PASSKEY_STORE_FILE,
  challengeTtlMs: PASSKEY_CHALLENGE_TTL_MS,
  sessionTtlMs: PASSKEY_SESSION_TTL_MS,
  userVerification: PASSKEY_USER_VERIFICATION,
});

function adminAuthConfigured() {
  return (
    (ADMIN_AUTH_METHODS.has("token") && Boolean(ADMIN_TOKEN)) ||
    (ADMIN_AUTH_METHODS.has("passkey") && passkeys.hasCredentials())
  );
}

if (!adminAuthConfigured()) {
  console.warn(
    "Warning: no admin authentication credential is configured. Set ADMIN_TOKEN to bootstrap gateway admin access."
  );
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

function formatMinecraftAddress(host?: string | null, port?: number | null) {
  const cleanHost = host?.trim();
  if (!cleanHost) return null;
  const cleanPort = port || DEFAULT_MINECRAFT_PORT;
  return cleanPort === DEFAULT_MINECRAFT_PORT ? cleanHost : `${cleanHost}:${cleanPort}`;
}

// Get client IP
function clientIp(req: Request): string {
  const normalizeIp = (ip: string) => {
    if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
    if (ip === "::1") return "127.0.0.1";
    return ip;
  };

  if (TRUST_PROXY) return normalizeIp(req.ip || "");
  return normalizeIp(req.socket?.remoteAddress || "");
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

function requestAllowedByCidr(req: Request): boolean {
  if (!ADMIN_REQUIRE_CIDR) return true;
  const ip = clientIp(req);
  return ALLOW_CIDRS.some((c) => ipInCidr(ip, c));
}

function authContext(req: Request) {
  return {
    host: String(req.headers.host || ""),
    origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
  };
}

function bearerTokenMatches(candidate: string): boolean {
  if (!ADMIN_TOKEN || !candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(ADMIN_TOKEN);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionTokenFromRequest(req: Request): string {
  const auth = String(req.headers["authorization"] || "");
  if (auth.startsWith("Session ")) return auth.slice("Session ".length).trim();
  const header = req.headers["x-admin-session"];
  return typeof header === "string" ? header.trim() : "";
}

function requestHasAdminAuth(req: Request): boolean {
  const auth = String(req.headers["authorization"] || "");
  if (ADMIN_AUTH_METHODS.has("token") && auth.startsWith("Bearer ")) {
    if (bearerTokenMatches(auth.slice("Bearer ".length).trim())) return true;
  }

  if (ADMIN_AUTH_METHODS.has("passkey")) {
    return passkeys.validateSession(sessionTokenFromRequest(req));
  }

  return false;
}

// Auth middleware
function requireAdmin(req: Request, res: Response, next: () => void) {
  const ip = clientIp(req);
  if (!requestAllowedByCidr(req)) return res.status(403).json({ error: `Forbidden from ${ip}` });
  if (!adminAuthConfigured()) {
    return res.status(503).json({
      error: "Admin authentication is not configured. Set ADMIN_TOKEN before managing servers or registering passkeys.",
    });
  }
  if (!requestHasAdminAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

// Proxy helper
async function proxyToAgent(agentUrl: string, path: string, options: RequestInit = {}) {
  const url = `${agentUrl}${path}`;
  const response = await fetch(url, options);
  return response;
}

function bufferToBlob(buffer: Buffer): Blob {
  return new Blob([new Uint8Array(buffer)]);
}

async function readAgentResponse(response: globalThis.Response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return response.ok ? { message: text } : { error: text };
  }
}

function parsePort(value: unknown, fieldName: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${fieldName} must be an integer from 1 to 65535`);
  }
  return port;
}

function assertSafePathSegment(value: string, label: string) {
  if (
    !value ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".." ||
    value.includes("..")
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

// Serve static frontend
app.use(express.static(WEB_DIST_DIR));

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Authentication configuration
app.get("/api/auth/config", (req, res) => {
  res.json({
    authMethods: Array.from(ADMIN_AUTH_METHODS),
    cidrRequired: ADMIN_REQUIRE_CIDR,
    passkeys: passkeys.publicConfig(authContext(req)),
  });
});

app.post("/api/auth/passkeys/register/options", requireAdmin, (req, res) => {
  try {
    const name = typeof req.body?.name === "string" && req.body.name.trim()
      ? req.body.name.trim()
      : "Admin passkey";
    res.json({ publicKey: passkeys.registrationOptions(authContext(req), name) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/passkeys/register/verify", requireAdmin, (req, res) => {
  try {
    res.json(passkeys.verifyRegistration(authContext(req), req.body));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/passkeys/login/options", (req, res) => {
  try {
    if (!requestAllowedByCidr(req)) {
      return res.status(403).json({ error: `Forbidden from ${clientIp(req)}` });
    }
    res.json({ publicKey: passkeys.authenticationOptions(authContext(req)) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/passkeys/login/verify", (req, res) => {
  try {
    if (!requestAllowedByCidr(req)) {
      return res.status(403).json({ error: `Forbidden from ${clientIp(req)}` });
    }
    res.json(passkeys.verifyAuthentication(authContext(req), req.body));
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

app.get("/api/auth/passkeys", requireAdmin, (_req, res) => {
  res.json({ credentials: passkeys.listCredentials() });
});

app.delete("/api/auth/passkeys/:id", requireAdmin, (req, res) => {
  const deleted = passkeys.deleteCredential(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Passkey not found" });
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const token = sessionTokenFromRequest(req);
  if (token) passkeys.revokeSession(token);
  res.json({ ok: true });
});

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
        host_proxy_port: server.host_proxy_port || null,
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
        host_proxy_port: server.host_proxy_port || null,
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
  try {
    const {
      name,
      agent_url,
      local_ip,
      local_port,
      host_ip,
      host_proxy_port,
      public_port,
      public_domain,
      memory_mb,
      cpu_limit,
      edition,
      mc_version,
    } = req.body;
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
      local_ip,
      local_port: local_port === undefined ? undefined : parsePort(local_port, "local_port"),
      host_ip: host_ip || undefined,
      host_proxy_port: host_proxy_port === undefined ? undefined : parsePort(host_proxy_port, "host_proxy_port"),
      public_port: public_port === undefined ? 25565 : parsePort(public_port, "public_port"),
      public_domain: public_domain || undefined,
      memory_mb: Number(memory_mb || 2048),
      cpu_limit,
      edition: edition || "paper",
      mc_version: mc_version || "1.21.1",
    });

    saveRegistry(registry);
    res.json({ ok: true, message: `Server ${name} registered` });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
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
  try {
    const { name } = req.params;
    const { public_domain, public_port, local_port, host_ip, host_proxy_port } = req.body;

    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    // Update fields
    if (public_domain !== undefined) {
      server.public_domain = public_domain || undefined;
    }
    if (public_port !== undefined) {
      server.public_port = parsePort(public_port, "public_port");
    }
    if (local_port !== undefined) {
      server.local_port = parsePort(local_port, "local_port");
    }
    if (host_ip !== undefined) {
      server.host_ip = host_ip || undefined;
    }
    if (host_proxy_port !== undefined) {
      server.host_proxy_port = host_proxy_port === null || host_proxy_port === ""
        ? undefined
        : parsePort(host_proxy_port, "host_proxy_port");
    }

    saveRegistry(registry);
    res.json({ ok: true, message: `Server ${name} configuration updated`, server });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
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
    const publicAddress = formatMinecraftAddress(server.public_domain, server.public_port);
    const publicUrl = `https://api.mcsrvstat.us/3/${publicAddress}`;
    const response = await fetch(publicUrl, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();

    return res.json({
      accessible: data.online === true,
      address: publicAddress,
      reason: data.online === true
        ? null
        : data.debug?.error?.ping || "External status check could not reach the server",
      info: data,
    });
  } catch (err: any) {
    return res.json({
      accessible: false,
      address: formatMinecraftAddress(server.public_domain, server.public_port),
      reason: err.message,
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

// Get structured server settings
app.get("/api/servers/:name/settings", async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/settings");
    const data = await readAgentResponse(response);
    res.status(response.status).json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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
    const data = await readAgentResponse(response);
    res.status(response.status).json(data);
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
    res.status(response.status).type("text/plain").send(text);
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

// Change server version
app.post("/api/servers/:name/version/change", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server.agent_url, "/version/change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await readAgentResponse(response);

    if (response.ok && req.body?.type && req.body?.version) {
      server.edition = req.body.type;
      server.mc_version = req.body.version;
      saveRegistry(registry);
    }

    res.status(response.status).json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    const { downloadUrl, fileName, projectId, versionId, projectType } = req.body;

    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");
    if (!downloadUrl || !fileName) {
      return res.status(400).json({ error: "Missing downloadUrl or fileName" });
    }

    const target = projectType === "plugin" ? "/plugins" : "/mods";
    const modData = await modrinth.downloadMod(downloadUrl);
    const form = new FormData();
    const blob = bufferToBlob(modData);
    form.append('file', blob, fileName);
    if (projectId) form.append("projectId", projectId);
    if (versionId) form.append("versionId", versionId);
    form.append("downloadUrl", downloadUrl);

    const uploadResponse = await fetch(`${server.agent_url}${target}`, {
      method: 'POST',
      body: form as any,
    });

    if (!uploadResponse.ok) {
      throw new Error('Failed to upload mod to server');
    }

    res.json({
      success: true,
      message: `${projectType === "plugin" ? "Plugin" : "Mod"} ${fileName} installed successfully`,
      projectId,
      versionId
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const recommendedPluginSlugs: Record<string, string> = {
  luckperms: "luckperms",
  essentialsx: "essentialsx",
  vault: "vault",
  worldedit: "worldedit",
};

app.post("/api/servers/:name/plugins/recommended", requireAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const requestedPlugins = Array.isArray(req.body?.plugins) ? req.body.plugins : [];
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const loader = ["paper", "purpur", "spigot"].includes(server.edition.toLowerCase())
      ? server.edition.toLowerCase()
      : "paper";
    const installed: string[] = [];
    const failed: Array<{ plugin: string; error: string }> = [];

    for (const plugin of requestedPlugins) {
      const slug = recommendedPluginSlugs[String(plugin)];
      if (!slug) {
        failed.push({ plugin: String(plugin), error: "Unknown recommended plugin" });
        continue;
      }

      try {
        const versions = await modrinth.getModVersions(slug, server.mc_version, loader);
        const version = versions.find((candidate) => candidate.files.length > 0);
        const file = version?.files.find((candidate) => candidate.primary) || version?.files[0];

        if (!version || !file) {
          failed.push({ plugin: String(plugin), error: "No compatible Modrinth version found" });
          continue;
        }

        const pluginData = await modrinth.downloadMod(file.url);
        const form = new FormData();
        const blob = bufferToBlob(pluginData);
        form.append('file', blob, file.filename);

        const uploadResponse = await fetch(`${server.agent_url}/plugins`, {
          method: "POST",
          body: form as any,
        });

        if (!uploadResponse.ok) {
          const text = await uploadResponse.text();
          throw new Error(text || uploadResponse.statusText);
        }

        installed.push(plugin);
      } catch (err: any) {
        failed.push({ plugin: String(plugin), error: err.message });
      }
    }

    res.json({
      success: failed.length === 0,
      installed,
      failed,
      message: failed.length === 0
        ? "Recommended plugins installed"
        : "Some recommended plugins could not be installed",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/servers/:name/mods/manifest", async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const localIp = server.local_ip || server.agent_url.match(/https?:\/\/([^:]+)/)?.[1] || "";
    const response = await fetch(`${server.agent_url}/mods/list`);
    if (!response.ok) {
      throw new Error('Failed to fetch installed mods');
    }

    const mods = await response.json();
    res.json({
      server: {
        name: server.name,
        edition: server.edition,
        mc_version: server.mc_version,
        local_address: formatMinecraftAddress(
          server.host_ip || localIp,
          server.host_proxy_port || server.public_port
        ),
        public_address: formatMinecraftAddress(server.public_domain, server.public_port),
      },
      mods: mods.mods || [],
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
    assertSafePathSegment(fileName, "fileName");
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    // Delete mod via agent
    const url = new URL(`/mods/${encodeURIComponent(fileName)}`, server.agent_url);
    if (removeConfigs) url.searchParams.set("removeConfigs", "true");
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
    assertSafePathSegment(fileName, "fileName");
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(new URL(`/mods/${encodeURIComponent(fileName)}/metadata`, server.agent_url));
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
    assertSafePathSegment(fileName, "fileName");
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(new URL(`/mods/${encodeURIComponent(fileName)}/icon`, server.agent_url));
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
    assertSafePathSegment(fileName, "fileName");
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(new URL(`/mods/${encodeURIComponent(fileName)}/toggle`, server.agent_url), {
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
    assertSafePathSegment(modId, "modId");
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(new URL(`/mods/${encodeURIComponent(modId)}/configs`, server.agent_url));
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
    assertSafePathSegment(modId, "modId");
    assertSafePathSegment(fileName, "fileName");
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(new URL(`/mods/${encodeURIComponent(modId)}/config/${encodeURIComponent(fileName)}`, server.agent_url));
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
    assertSafePathSegment(modId, "modId");
    assertSafePathSegment(fileName, "fileName");
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetch(new URL(`/mods/${encodeURIComponent(modId)}/config/${encodeURIComponent(fileName)}`, server.agent_url), {
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

    const serverAddress = formatMinecraftAddress(server.public_domain, server.public_port) ||
      formatMinecraftAddress(server.host_ip || 'localhost', server.host_proxy_port || server.public_port) ||
      'localhost';

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

    const serverAddress = formatMinecraftAddress(server.public_domain, server.public_port) ||
      formatMinecraftAddress(server.host_ip || 'localhost', server.host_proxy_port || server.public_port) ||
      'localhost';

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

app.get("*", (req, res) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }

  res.sendFile(path.join(WEB_DIST_DIR, "index.html"), (err) => {
    if (err) {
      res.status(404).send("Frontend has not been built");
    }
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Management backend listening on http://${HOST}:${PORT}`);
});
