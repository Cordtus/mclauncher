/**
 * @file Management Backend - API Gateway
 * @description
 * Runs in the management container
 * Provides HTTP API for the web UI and proxies requests to server control agents
 * Maintains registry of Minecraft servers and their control agent endpoints
 */

import express, { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import "dotenv/config";
import { PasskeyService, type PasskeyRegistrationAuthorization, type PasskeyRegistrationCodeInput } from "./services/passkeys.js";
import * as modpack from "./services/modpack.js";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const REGISTRY_FILE = process.env.REGISTRY_FILE || "/opt/mc-lxd-manager/servers.json";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ALLOW_CIDRS = (process.env.ALLOW_CIDRS ?? "127.0.0.0/8,192.168.0.0/24,10.70.48.0/24,10.172.19.0/24")
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
const ADMIN_REQUIRE_CIDR = (process.env.ADMIN_REQUIRE_CIDR ?? "false").toLowerCase() !== "false";
const PASSKEYS_ENABLED = (process.env.PASSKEYS_ENABLED ?? "true").toLowerCase() !== "false";
const PASSKEY_USER_VERIFICATION = (
  ["preferred", "required", "discouraged"].includes(process.env.PASSKEY_USER_VERIFICATION || "")
    ? process.env.PASSKEY_USER_VERIFICATION
    : "required"
) as "preferred" | "required" | "discouraged";
const PASSKEY_STORE_FILE = process.env.PASSKEY_STORE_FILE || path.join(path.dirname(REGISTRY_FILE), "passkeys.json");
const PASSKEY_SESSION_TTL_MS = Number(process.env.PASSKEY_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const PASSKEY_CHALLENGE_TTL_MS = Number(process.env.PASSKEY_CHALLENGE_TTL_MS || 5 * 60 * 1000);
const PASSKEY_REGISTRATION_CODES = parsePasskeyRegistrationCodes(process.env.PASSKEY_REGISTRATION_CODES || "");
const ADMIN_COOKIE_NAME = process.env.ADMIN_COOKIE_NAME || "mclx_admin";
const ADMIN_COOKIE_TTL_MS = Number(process.env.ADMIN_COOKIE_TTL_MS || PASSKEY_SESSION_TTL_MS);
const DEFAULT_MINECRAFT_PORT = 25565;
const PUBLIC_MODPACK_CACHE_TTL_MS = Number(process.env.PUBLIC_MODPACK_CACHE_TTL_MS || 60 * 1000);
const PUBLIC_RATE_LIMIT_WINDOW_MS = Number(process.env.PUBLIC_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const PUBLIC_RATE_LIMIT_MAX = Number(process.env.PUBLIC_RATE_LIMIT_MAX || 60);
const AUTH_RATE_LIMIT_WINDOW_MS = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX || 20);
const AGENT_ALLOWED_CIDRS = (process.env.AGENT_ALLOWED_CIDRS ?? "10.70.48.0/24")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AGENT_ALLOWED_PORTS = new Set(
  (process.env.AGENT_ALLOWED_PORTS ?? "9090")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

interface ServerEntry {
  name: string;
  agent_url: string; // http://container-ip:9090
  local_ip?: string; // Container IP (e.g., 10.70.48.204)
  local_port?: number; // Minecraft port (usually 25565)
  host_ip?: string; // LXD host IP for local network connections (e.g., 192.168.0.170)
  host_proxy_port?: number; // LXD host proxy port that receives router-forwarded traffic
  public_port: number; // LXD proxy port on host
  public_domain?: string; // Optional public domain (e.g., mc.yourdomain.com)
  agent_token?: string; // Shared token for manager-to-agent requests
  memory_mb: number;
  cpu_limit?: string;
  edition: string;
  mc_version: string;
  loader_version?: string;
}

interface ServerRegistry {
  servers: ServerEntry[];
}

type ModpackLoader = modpack.ModpackMetadata["loader"];
type PublicModpackCacheEntry = {
  expiresAt: number;
  value?: {
    metadata: modpack.ModpackMetadata;
    mods: any[];
    html: string;
    modList: string;
  };
  promise?: Promise<NonNullable<PublicModpackCacheEntry["value"]>>;
};
type PublicMrpackCacheEntry = {
  expiresAt: number;
  value?: Buffer;
  promise?: Promise<Buffer>;
};

const MODPACK_LOADERS = new Set<ModpackLoader>(["fabric", "forge", "neoforge", "quilt"]);
const publicModpackCache = new Map<string, PublicModpackCacheEntry>();
const publicMrpackCache = new Map<string, PublicMrpackCacheEntry>();

function parsePasskeyRegistrationCodes(value: string): PasskeyRegistrationCodeInput[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator <= 0) return { code: entry };
      return {
        label: entry.slice(0, separator).trim() || undefined,
        code: entry.slice(separator + 1).trim(),
      };
    })
    .filter((entry) => entry.code.length > 0);
}

function asModpackLoader(value: unknown): ModpackLoader | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase() as ModpackLoader;
  return MODPACK_LOADERS.has(normalized) ? normalized : null;
}

function agentRequestOptions(server: ServerEntry, options: RequestInit = {}): RequestInit {
  const headers = new Headers(options.headers);
  if (server.agent_token) {
    headers.set("X-Agent-Token", server.agent_token);
  }
  return { ...options, headers };
}

async function fetchFromAgent(server: ServerEntry, pathName: string | URL, options: RequestInit = {}) {
  validateAgentUrl(server.agent_url);
  const target = pathName instanceof URL ? pathName.toString() : `${server.agent_url}${pathName}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AGENT_FETCH_TIMEOUT_MS || 30_000));
  try {
    return await fetch(target, agentRequestOptions(server, {
      ...options,
      redirect: "manual",
      signal: controller.signal,
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAgentJson<T>(server: ServerEntry, pathName: string): Promise<T | null> {
  try {
    const response = await fetchFromAgent(server, pathName);
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

function detectModpackLoader(server: ServerEntry, mods: any[]): ModpackLoader {
  const editionLoader = asModpackLoader(server.edition);
  if (editionLoader) return editionLoader;

  const loaderMod = mods.find((mod: any) => asModpackLoader(mod.loader));
  return asModpackLoader(loaderMod?.loader) || "fabric";
}

async function resolveLoaderVersion(server: ServerEntry, loader: ModpackLoader): Promise<string | undefined> {
  if (server.loader_version && server.loader_version !== "latest") {
    return server.loader_version;
  }

  const current = await fetchAgentJson<{ type?: string; build?: string | number | null }>(server, "/version/current");
  if (asModpackLoader(current?.type) === loader && current?.build && current.build !== "latest") {
    return String(current.build);
  }

  if (loader === "fabric") {
    const versions = await fetchAgentJson<{ latestLoader?: string | null }>(server, "/versions/fabric");
    return versions?.latestLoader || undefined;
  }

  return undefined;
}

async function buildModpackMetadata(server: ServerEntry, mods: any[]): Promise<modpack.ModpackMetadata> {
  const loader = detectModpackLoader(server, mods);
  const hasEnabledMods = mods.some((mod: any) => mod.enabled);
  const loaderVersion = hasEnabledMods ? await resolveLoaderVersion(server, loader) : undefined;

  return {
    name: `${server.name} Modpack`,
    summary: `Modpack for ${server.name} Minecraft server`,
    versionId: "1.0.0",
    mcVersion: server.mc_version,
    loader,
    loaderVersion,
  };
}

async function fetchInstalledMods(server: ServerEntry): Promise<any[]> {
  const response = await fetchFromAgent(server, "/mods/list");
  if (!response.ok) {
    throw new Error("Failed to fetch installed mods");
  }

  const data = await response.json();
  return data.mods || [];
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self)");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "));
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (req.secure || proto === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

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
  registrationCodes: PASSKEY_REGISTRATION_CODES,
});

function adminAuthConfigured() {
  return (
    (ADMIN_AUTH_METHODS.has("token") && Boolean(ADMIN_TOKEN)) ||
    (ADMIN_AUTH_METHODS.has("passkey") && passkeys.hasCredentials())
  );
}

function adminBootstrapConfigured() {
  return adminAuthConfigured() || (ADMIN_AUTH_METHODS.has("passkey") && passkeys.hasRegistrationCodes());
}

if (!adminBootstrapConfigured()) {
  console.warn(
    "Warning: no admin authentication credential is configured. Set PASSKEY_REGISTRATION_CODES or ADMIN_TOKEN to bootstrap gateway admin access."
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
  const tempFile = path.join(dir, `.${path.basename(REGISTRY_FILE)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempFile, JSON.stringify(registry, null, 2), { mode: 0o600 });
  fs.chmodSync(tempFile, 0o600);
  fs.renameSync(tempFile, REGISTRY_FILE);
  fs.chmodSync(REGISTRY_FILE, 0o600);
}

function publicServerEntry(server: ServerEntry) {
  const { agent_token: _agentToken, ...publicServer } = server;
  return publicServer;
}

function formatMinecraftAddress(host?: string | null, port?: number | null) {
  const cleanHost = host?.trim();
  if (!cleanHost) return null;
  const cleanPort = port || DEFAULT_MINECRAFT_PORT;
  return cleanPort === DEFAULT_MINECRAFT_PORT ? cleanHost : `${cleanHost}:${cleanPort}`;
}

function publicMinecraftAddress(server: ServerEntry) {
  const address = formatMinecraftAddress(server.public_domain, server.public_port);
  if (!address) throw new Error("Public Minecraft address is not configured");
  return address;
}

function hasPublicMinecraftAddress(server: ServerEntry) {
  return Boolean(formatMinecraftAddress(server.public_domain, server.public_port));
}

function publicModpackCacheKey(server: ServerEntry) {
  return `${server.name}:${server.mc_version}:${server.edition}:${server.loader_version || ""}:${server.public_domain || ""}:${server.public_port}`;
}

async function getPublicModpack(server: ServerEntry) {
  const cacheKey = publicModpackCacheKey(server);
  const cached = publicModpackCache.get(cacheKey);
  const now = Date.now();
  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const serverAddress = publicMinecraftAddress(server);
    const mods = await fetchInstalledMods(server);
    const metadata = await buildModpackMetadata(server, mods);
    const [modList, html] = await Promise.all([
      Promise.resolve(modpack.generateModList(metadata, mods)),
      modpack.generateDownloadPage(server.name, serverAddress, metadata, mods),
    ]);
    return { metadata, mods, html, modList };
  })();

  publicModpackCache.set(cacheKey, { expiresAt: now + PUBLIC_MODPACK_CACHE_TTL_MS, promise });
  try {
    const value = await promise;
    publicModpackCache.set(cacheKey, { expiresAt: Date.now() + PUBLIC_MODPACK_CACHE_TTL_MS, value });
    return value;
  } catch (err) {
    publicModpackCache.delete(cacheKey);
    throw err;
  }
}

async function getPublicMrpack(server: ServerEntry) {
  const cacheKey = publicModpackCacheKey(server);
  const cached = publicMrpackCache.get(cacheKey);
  const now = Date.now();
  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const { metadata, mods } = await getPublicModpack(server);
    const { buffer } = await modpack.generateMrpack(metadata, mods);
    return buffer;
  })();

  publicMrpackCache.set(cacheKey, { expiresAt: now + PUBLIC_MODPACK_CACHE_TTL_MS, promise });
  try {
    const value = await promise;
    publicMrpackCache.set(cacheKey, { expiresAt: Date.now() + PUBLIC_MODPACK_CACHE_TTL_MS, value });
    return value;
  } catch (err) {
    publicMrpackCache.delete(cacheKey);
    throw err;
  }
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

function validateAgentUrl(value: unknown) {
  if (typeof value !== "string") throw new Error("agent_url must be a URL");
  const parsed = new URL(value);
  if (parsed.protocol !== "http:") throw new Error("agent_url must use http");
  if (parsed.username || parsed.password) throw new Error("agent_url must not include credentials");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("agent_url must not include a path, query, or fragment");
  }
  const port = parsed.port || "80";
  if (!AGENT_ALLOWED_PORTS.has(port)) {
    throw new Error(`agent_url port must be one of: ${Array.from(AGENT_ALLOWED_PORTS).join(", ")}`);
  }
  if (!AGENT_ALLOWED_CIDRS.some((cidr) => ipInCidr(parsed.hostname, cidr))) {
    throw new Error("agent_url host is outside allowed agent CIDRs");
  }
  return parsed.toString().replace(/\/$/, "");
}

function requestAllowedByCidr(req: Request): boolean {
  if (!ADMIN_REQUIRE_CIDR) return true;
  const ip = clientIp(req);
  return ALLOW_CIDRS.some((c) => ipInCidr(ip, c));
}

function requestOrigin(req: Request) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || req.protocol;
  const host = String(req.headers.host || "");
  return host ? `${proto}://${host}` : "";
}

function originAllowed(req: Request) {
  let candidate = "";
  try {
    candidate = typeof req.headers.origin === "string"
      ? req.headers.origin
      : typeof req.headers.referer === "string"
        ? new URL(req.headers.referer).origin
        : "";
  } catch {
    return false;
  }
  if (!candidate) return false;
  return candidate === requestOrigin(req);
}

function requireSameOriginUnsafeApi(req: Request, res: Response, next: () => void) {
  if (!req.path.startsWith("/api/") || !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return next();
  }
  if (req.path === "/api/auth/token/login") return next();
  const isAdminMutatingPath = (
    req.path.startsWith("/api/servers/") ||
    req.path === "/api/auth/logout" ||
    req.path === "/api/auth/passkeys/register/options" ||
    req.path === "/api/auth/passkeys/register/verify" ||
    req.path.startsWith("/api/auth/passkeys/registration-codes") ||
    (req.method === "DELETE" && req.path.startsWith("/api/auth/passkeys/"))
  );
  const auth = String(req.headers.authorization || "");
  if (!adminCookie(req) && auth.startsWith("Bearer ")) return next();
  if (!adminCookie(req) && !isAdminMutatingPath) return next();
  if (!originAllowed(req)) {
    return res.status(403).json({ error: "Cross-origin admin request blocked" });
  }
  return next();
}

type RateLimitEntry = { count: number; resetAt: number };

function createRateLimit(windowMs: number, max: number) {
  const buckets = new Map<string, RateLimitEntry>();
  return (req: Request, res: Response, next: () => void) => {
    const now = Date.now();
    const key = clientIp(req);
    const existing = buckets.get(key);
    const bucket = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);

    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: "Too many requests" });
    }

    if (buckets.size > 1000) {
      for (const [bucketKey, entry] of buckets.entries()) {
        if (entry.resetAt <= now) buckets.delete(bucketKey);
      }
    }
    return next();
  };
}

const publicRateLimit = createRateLimit(PUBLIC_RATE_LIMIT_WINDOW_MS, PUBLIC_RATE_LIMIT_MAX);
const authRateLimit = createRateLimit(AUTH_RATE_LIMIT_WINDOW_MS, AUTH_RATE_LIMIT_MAX);
const modrinthRateLimit = createRateLimit(
  Number(process.env.MODRINTH_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  Number(process.env.MODRINTH_RATE_LIMIT_MAX || 120)
);

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

function base64url(value: Buffer | string) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function parseCookies(req: Request) {
  const cookies = new Map<string, string>();
  const header = String(req.headers.cookie || "");
  for (const cookie of header.split(";")) {
    const index = cookie.indexOf("=");
    if (index === -1) continue;
    const name = cookie.slice(0, index).trim();
    const value = cookie.slice(index + 1).trim();
    if (name) cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}

function adminCookie(req: Request) {
  return parseCookies(req).get(ADMIN_COOKIE_NAME) || "";
}

function secureCookieForRequest(req: Request) {
  const forced = process.env.ADMIN_COOKIE_SECURE?.toLowerCase();
  if (forced === "true") return true;
  if (forced === "false") return false;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return req.secure || proto === "https";
}

function cookieHeader(req: Request, value: string, maxAgeMs: number) {
  const parts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (secureCookieForRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function setAdminCookie(req: Request, res: Response, value: string, expiresAt: number) {
  res.setHeader("Set-Cookie", cookieHeader(req, value, expiresAt - Date.now()));
}

function clearAdminCookie(req: Request, res: Response) {
  res.setHeader("Set-Cookie", cookieHeader(req, "", 0));
}

function signedTokenSession() {
  const expiresAt = Date.now() + ADMIN_COOKIE_TTL_MS;
  const payload = base64url(JSON.stringify({
    type: "token",
    nonce: base64url(randomBytes(16)),
    expiresAt,
  }));
  const signature = base64url(createHmac("sha256", ADMIN_TOKEN).update(payload).digest());
  return { cookieValue: `token.${payload}.${signature}`, expiresAt };
}

function signedTokenCookieMatches(cookieValue: string) {
  if (!ADMIN_TOKEN || !cookieValue.startsWith("token.")) return false;
  const [, payload, signature] = cookieValue.split(".");
  if (!payload || !signature) return false;
  const expected = base64url(createHmac("sha256", ADMIN_TOKEN).update(payload).digest());
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;

  try {
    const data = JSON.parse(fromBase64url(payload).toString("utf8"));
    return data?.type === "token" && Number(data.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

function sessionTokenFromRequest(req: Request): string {
  const cookie = adminCookie(req);
  if (cookie.startsWith("passkey.")) return cookie.slice("passkey.".length);
  return "";
}

function requestHasAdminAuth(req: Request): boolean {
  const auth = String(req.headers["authorization"] || "");
  if (ADMIN_AUTH_METHODS.has("token") && auth.startsWith("Bearer ")) {
    if (bearerTokenMatches(auth.slice("Bearer ".length).trim())) return true;
  }
  if (ADMIN_AUTH_METHODS.has("token") && signedTokenCookieMatches(adminCookie(req))) return true;

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

function passkeyRegistrationAuthorization(req: Request, res: Response): PasskeyRegistrationAuthorization | null {
  const ip = clientIp(req);
  if (!requestAllowedByCidr(req)) {
    res.status(403).json({ error: `Forbidden from ${ip}` });
    return null;
  }
  if (requestHasAdminAuth(req)) return { type: "admin-session" };

  const setupCode =
    typeof req.body?.setupCode === "string"
      ? req.body.setupCode
      : typeof req.body?.code === "string"
        ? req.body.code
        : "";
  if (setupCode.trim()) return { type: "registration-code", code: setupCode };

  res.status(401).json({ error: "Admin session or one-time passkey setup code required" });
  return null;
}

app.use(requireSameOriginUnsafeApi);

// Proxy helper
async function proxyToAgent(server: ServerEntry, path: string, options: RequestInit = {}) {
  return fetchFromAgent(server, path, options);
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

app.get("/api/auth/session", (req, res) => {
  if (!requestAllowedByCidr(req)) {
    return res.status(403).json({ authenticated: false, error: `Forbidden from ${clientIp(req)}` });
  }
  if (!adminAuthConfigured()) {
    return res.status(503).json({ authenticated: false });
  }
  if (!requestHasAdminAuth(req)) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true });
});

app.post("/api/auth/token/login", authRateLimit, (req, res) => {
  try {
    if (!requestAllowedByCidr(req)) {
      return res.status(403).json({ error: `Forbidden from ${clientIp(req)}` });
    }
    if (!ADMIN_AUTH_METHODS.has("token") || !ADMIN_TOKEN) {
      return res.status(503).json({ error: "Token authentication is not configured" });
    }
    if (!bearerTokenMatches(String(req.body?.token || ""))) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const session = signedTokenSession();
    setAdminCookie(req, res, session.cookieValue, session.expiresAt);
    res.json({ ok: true, expiresAt: new Date(session.expiresAt).toISOString() });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/passkeys/register/options", authRateLimit, (req, res) => {
  try {
    const authorization = passkeyRegistrationAuthorization(req, res);
    if (!authorization) return;
    const name = typeof req.body?.name === "string" && req.body.name.trim()
      ? req.body.name.trim()
      : "Admin passkey";
    res.json({ publicKey: passkeys.registrationOptions(authContext(req), name, authorization) });
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/api/auth/passkeys/register/verify", authRateLimit, (req, res) => {
  try {
    if (!requestAllowedByCidr(req)) {
      return res.status(403).json({ error: `Forbidden from ${clientIp(req)}` });
    }
    const result = passkeys.verifyRegistration(authContext(req), req.body);
    setAdminCookie(req, res, `passkey.${result.sessionToken}`, new Date(result.expiresAt).getTime());
    const { sessionToken: _sessionToken, ...safeResult } = result;
    res.json(safeResult);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/passkeys/login/options", authRateLimit, (req, res) => {
  try {
    if (!requestAllowedByCidr(req)) {
      return res.status(403).json({ error: `Forbidden from ${clientIp(req)}` });
    }
    res.json({ publicKey: passkeys.authenticationOptions(authContext(req)) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/passkeys/login/verify", authRateLimit, (req, res) => {
  try {
    if (!requestAllowedByCidr(req)) {
      return res.status(403).json({ error: `Forbidden from ${clientIp(req)}` });
    }
    const result = passkeys.verifyAuthentication(authContext(req), req.body);
    setAdminCookie(req, res, `passkey.${result.sessionToken}`, new Date(result.expiresAt).getTime());
    const { sessionToken: _sessionToken, ...safeResult } = result;
    res.json(safeResult);
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

app.get("/api/auth/passkeys", requireAdmin, (_req, res) => {
  res.json({ credentials: passkeys.listCredentials() });
});

app.get("/api/auth/passkeys/registration-codes", requireAdmin, (_req, res) => {
  res.json({ codes: passkeys.listRegistrationCodes() });
});

app.post("/api/auth/passkeys/registration-codes", requireAdmin, (req, res) => {
  try {
    const label = typeof req.body?.label === "string" ? req.body.label : undefined;
    res.status(201).json({ code: passkeys.createRegistrationCode(label) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/auth/passkeys/registration-codes/:id", requireAdmin, (req, res) => {
  const deleted = passkeys.deleteRegistrationCode(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Passkey setup code not found" });
  res.json({ ok: true });
});

app.delete("/api/auth/passkeys/:id", requireAdmin, (req, res) => {
  const deleted = passkeys.deleteCredential(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Passkey not found" });
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const token = sessionTokenFromRequest(req);
  if (token) passkeys.revokeSession(token);
  clearAdminCookie(req, res);
  res.json({ ok: true });
});

// List servers
app.get("/api/servers", requireAdmin, async (_req, res) => {
  const registry = loadRegistry();
  const results = [];

  for (const server of registry.servers) {
    // Extract local IP from agent URL
    const localIp = server.local_ip || server.agent_url.match(/https?:\/\/([^:]+)/)?.[1] || "";
    const localPort = server.local_port || 25565;

    try {
      const statusRes = await proxyToAgent(server, "/status");
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
        loader_version: server.loader_version || null,
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
        loader_version: server.loader_version || null,
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
      agent_token,
      memory_mb,
      cpu_limit,
      edition,
      mc_version,
      loader_version,
    } = req.body;
    if (!name || !agent_url) {
      return res.status(400).json({ error: "Missing name or agent_url" });
    }

    const registry = loadRegistry();
    const existing = registry.servers.find((s) => s.name === name);
    if (existing) {
      return res.status(400).json({ error: "Server already registered" });
    }
    const normalizedAgentUrl = validateAgentUrl(agent_url);

    registry.servers.push({
      name,
      agent_url: normalizedAgentUrl,
      local_ip,
      local_port: local_port === undefined ? undefined : parsePort(local_port, "local_port"),
      host_ip: host_ip || undefined,
      host_proxy_port: host_proxy_port === undefined ? undefined : parsePort(host_proxy_port, "host_proxy_port"),
      public_port: public_port === undefined ? 25565 : parsePort(public_port, "public_port"),
      public_domain: public_domain || undefined,
      agent_token: agent_token || undefined,
      memory_mb: Number(memory_mb || 2048),
      cpu_limit,
      edition: edition || "paper",
      mc_version: mc_version || "1.21.1",
      loader_version: loader_version || undefined,
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
    res.json({ ok: true, message: `Server ${name} configuration updated`, server: publicServerEntry(server) });
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
    const response = await proxyToAgent(server, "/start", { method: "POST" });
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
    const response = await proxyToAgent(server, "/stop", { method: "POST" });
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
    const response = await proxyToAgent(server, "/restart", { method: "POST" });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get logs
app.get("/api/servers/:name/logs", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server, "/logs");
    const text = await response.text();
    res.type("text/plain").send(text);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// Get TPS
app.get("/api/servers/:name/tps", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server, "/tps");
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get JVM settings
app.get("/api/servers/:name/jvm/settings", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server, "/jvm/settings");
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
    const response = await proxyToAgent(server, "/jvm/settings", {
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
app.get("/api/servers/:name/check-public", requireAdmin, async (req, res) => {
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
app.get("/api/servers/:name/config", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server, "/config");
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
    const response = await proxyToAgent(server, "/config", {
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
app.get("/api/servers/:name/settings", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server, "/settings");
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
    const response = await proxyToAgent(server, "/settings", {
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
app.get("/api/servers/:name/settings/whitelist", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server, "/settings/whitelist");
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
    const response = await proxyToAgent(server, "/settings/whitelist/add", {
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
    const response = await proxyToAgent(server, "/settings/whitelist/remove", {
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
app.get("/api/servers/:name/settings/operators", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server, "/settings/operators");
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
    const response = await proxyToAgent(server, "/settings/operators/add", {
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
    const response = await proxyToAgent(server, "/settings/operators/remove", {
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
app.get("/api/servers/:name/settings/bans", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server, "/settings/bans");
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
    const response = await proxyToAgent(server, "/settings/bans/player/add", {
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
    const response = await proxyToAgent(server, "/settings/bans/player/remove", {
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
    const response = await proxyToAgent(server, "/settings/bans/ip/add", {
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
    const response = await proxyToAgent(server, "/settings/bans/ip/remove", {
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

    const response = await proxyToAgent(server, endpoint, {
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
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 512 * 1024 * 1024);
const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
});

function handleUploadError(err: any, res: Response, next: () => void) {
  if (!err) return next();
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `Upload exceeds ${MAX_UPLOAD_BYTES} byte limit` });
  }
  return res.status(400).json({ error: err.message || "Upload failed" });
}

function uploadSingleFile(req: Request, res: Response, next: () => void) {
  upload.single("file")(req, res, (err) => handleUploadError(err, res, next));
}

app.post("/api/servers/:name/plugins", requireAdmin, uploadSingleFile, (req, res) =>
  proxyFileUpload(req, res, "/plugins")
);

app.post("/api/servers/:name/mods", requireAdmin, uploadSingleFile, (req, res) =>
  proxyFileUpload(req, res, "/mods")
);

app.post("/api/servers/:name/worlds/upload", requireAdmin, uploadSingleFile, (req, res) =>
  proxyFileUpload(req, res, "/worlds/upload")
);

// Packwiz
app.post("/api/servers/:name/packwiz", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).send("Server not found");

  try {
    const response = await proxyToAgent(server, "/packwiz", {
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
    const response = await proxyToAgent(server, "/luckperms", { method: "POST" });
    const text = await response.text();
    res.type("text/plain").send(text);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// List worlds
app.get("/api/servers/:name/worlds", requireAdmin, async (req, res) => {
  const { name } = req.params;
  const registry = loadRegistry();
  const server = registry.servers.find((s) => s.name === name);
  if (!server) return res.status(404).json({ error: "Server not found" });

  try {
    const response = await proxyToAgent(server, "/worlds");
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
    const response = await proxyToAgent(server, "/worlds/switch", {
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
    const response = await proxyToAgent(server, "/command", {
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
    const response = await proxyToAgent(server, "/backup", { method: "POST" });
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
    const response = await proxyToAgent(server, "/version/change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await readAgentResponse(response);

    if (response.ok && req.body?.type && req.body?.version) {
      server.edition = req.body.type;
      server.mc_version = req.body.version;
      server.loader_version = data?.build || req.body?.build || undefined;
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
app.get("/api/mods/search", modrinthRateLimit, async (req, res) => {
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
app.get("/api/mods/:projectId", modrinthRateLimit, async (req, res) => {
  try {
    const { projectId } = req.params;
    const mod = await modrinth.getModDetails(projectId);
    res.json(mod);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get mod versions
app.get("/api/mods/:projectId/versions", modrinthRateLimit, async (req, res) => {
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
app.post("/api/mods/check-compatibility", modrinthRateLimit, async (req, res) => {
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
app.post("/api/mods/check-dependencies", modrinthRateLimit, async (req, res) => {
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
    const { fileName, projectId, versionId, projectType } = req.body;

    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");
    if (!versionId) {
      return res.status(400).json({ error: "Missing versionId" });
    }

    const target = projectType === "plugin" ? "/plugins" : "/mods";
    const version = await modrinth.getVersion(versionId);
    if (projectId && version.project_id !== projectId) {
      return res.status(400).json({ error: "versionId does not belong to projectId" });
    }

    const selectedFile = modrinth.selectVersionFile(version, fileName);
    const modData = await modrinth.downloadModFile(selectedFile);
    const form = new FormData();
    const blob = bufferToBlob(modData);
    form.append('file', blob, selectedFile.filename);
    form.append("projectId", version.project_id);
    form.append("versionId", version.id);
    form.append("downloadUrl", selectedFile.url);

    const uploadResponse = await fetchFromAgent(server, target, {
      method: 'POST',
      body: form as any,
    });

    if (!uploadResponse.ok) {
      throw new Error('Failed to upload mod to server');
    }

    res.json({
      success: true,
      message: `${projectType === "plugin" ? "Plugin" : "Mod"} ${selectedFile.filename} installed successfully`,
      projectId: version.project_id,
      versionId: version.id
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

        const pluginData = await modrinth.downloadModFile(file);
        const form = new FormData();
        const blob = bufferToBlob(pluginData);
        form.append('file', blob, file.filename);

        const uploadResponse = await fetchFromAgent(server, "/plugins", {
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

app.get("/api/servers/:name/mods/manifest", requireAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const localIp = server.local_ip || server.agent_url.match(/https?:\/\/([^:]+)/)?.[1] || "";
    const response = await fetchFromAgent(server, "/mods/list");
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
app.get("/api/servers/:name/mods/installed", requireAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    // Get list of installed mods from agent
    const response = await fetchFromAgent(server, "/mods/list");
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
    const response = await fetchFromAgent(server, url, {
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
app.get("/api/servers/:name/mods/:fileName/metadata", requireAdmin, async (req, res) => {
  try {
    const { name, fileName } = req.params;
    assertSafePathSegment(fileName, "fileName");
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetchFromAgent(server, new URL(`/mods/${encodeURIComponent(fileName)}/metadata`, server.agent_url));
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
app.get("/api/servers/:name/mods/:fileName/icon", requireAdmin, async (req, res) => {
  try {
    const { name, fileName } = req.params;
    assertSafePathSegment(fileName, "fileName");
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetchFromAgent(server, new URL(`/mods/${encodeURIComponent(fileName)}/icon`, server.agent_url));
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

    const response = await fetchFromAgent(server, new URL(`/mods/${encodeURIComponent(fileName)}/toggle`, server.agent_url), {
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
app.get("/api/servers/:name/mods/:modId/configs", requireAdmin, async (req, res) => {
  try {
    const { name, modId } = req.params;
    assertSafePathSegment(modId, "modId");
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetchFromAgent(server, new URL(`/mods/${encodeURIComponent(modId)}/configs`, server.agent_url));
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
app.get("/api/servers/:name/mods/:modId/config/:fileName", requireAdmin, async (req, res) => {
  try {
    const { name, modId, fileName } = req.params;
    assertSafePathSegment(modId, "modId");
    assertSafePathSegment(fileName, "fileName");
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const response = await fetchFromAgent(server, new URL(`/mods/${encodeURIComponent(modId)}/config/${encodeURIComponent(fileName)}`, server.agent_url));
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

    const response = await fetchFromAgent(server, new URL(`/mods/${encodeURIComponent(modId)}/config/${encodeURIComponent(fileName)}`, server.agent_url), {
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
app.get("/api/servers/:name/modpack", requireAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const mods = await fetchInstalledMods(server);
    const metadata = await buildModpackMetadata(server, mods);

    res.json({
      name: server.name,
      mcVersion: server.mc_version,
      loader: metadata.loader,
      loaderVersion: metadata.loaderVersion || null,
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
app.get("/api/servers/:name/modpack/export/mrpack", requireAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const mods = await fetchInstalledMods(server);
    const metadata = await buildModpackMetadata(server, mods);
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
app.get("/api/servers/:name/modpack/export/list", requireAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server) return res.status(404).send("Server not found");

    const mods = await fetchInstalledMods(server);
    const metadata = await buildModpackMetadata(server, mods);
    const modList = modpack.generateModList(metadata, mods);

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${server.name}-modlist.txt"`);
    res.send(modList);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Generate public download page HTML
app.get("/api/servers/:name/modpack/page", requireAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server || !hasPublicMinecraftAddress(server)) return res.status(404).send("Not found");

    const { html } = await getPublicModpack(server);

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
app.get("/public/:name/modpack", publicRateLimit, async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server || !hasPublicMinecraftAddress(server)) return res.status(404).send("Not found");

    const { html } = await getPublicModpack(server);

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err: any) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// Public modpack .mrpack download
app.get("/public/:name/modpack.mrpack", publicRateLimit, async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server || !hasPublicMinecraftAddress(server)) return res.status(404).send("Not found");

    const mrpack = await getPublicMrpack(server);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${server.name}-modpack.mrpack"`);
    res.send(mrpack);
  } catch (err: any) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// Public mod list download
app.get("/public/:name/modlist.txt", publicRateLimit, async (req, res) => {
  try {
    const { name } = req.params;
    const registry = loadRegistry();
    const server = registry.servers.find((s) => s.name === name);
    if (!server || !hasPublicMinecraftAddress(server)) return res.status(404).send("Not found");

    const { modList } = await getPublicModpack(server);

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, HOST, () => {
    console.log(`Management backend listening on http://${HOST}:${PORT}`);
  });
}

export { app };
