#!/usr/bin/env node
import { execFileSync, spawnSync } from "child_process";
import { randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

const DEFAULT_REGISTRY_FILE = process.env.REGISTRY_FILE || "/opt/mc-lxd-manager/servers.json";
const DEFAULT_ARCHIVES_FILE = process.env.SERVER_ARCHIVES_FILE || path.join(path.dirname(DEFAULT_REGISTRY_FILE), "server-archives.json");
const DEFAULT_MANAGER_CONTAINER = process.env.MANAGER_CONTAINER || "mc-manager";
const HARD_MAX_ACTIVE_SERVERS = 3;
const configuredMaxActive = Number(process.env.MAX_ACTIVE_SERVERS || HARD_MAX_ACTIVE_SERVERS);
const DEFAULT_MAX_ACTIVE = Math.min(Number.isInteger(configuredMaxActive) && configuredMaxActive > 0 ? configuredMaxActive : HARD_MAX_ACTIVE_SERVERS, HARD_MAX_ACTIVE_SERVERS);
const ARCHIVE_IMAGE_PREFIX = process.env.SERVER_ARCHIVE_IMAGE_PREFIX || "mc-archive-";
const DEFAULT_LOCK_FILE = process.env.SERVER_LIFECYCLE_LOCK_FILE || "/run/lock/mc-server-lifecycle.lock";
const CONTROLLER_ACTIONS = new Set(["list", "create", "archive", "restore", "delete-archive"]);
const CONTROLLER_MAX_BODY_BYTES = Number(process.env.SERVER_LIFECYCLE_CONTROLLER_MAX_BODY_BYTES || 64 * 1024);

function usage() {
  return [
    "Usage: mc-server-lifecycle.mjs <action> [options]",
    "",
    "Actions:",
    "  list",
    "  create --name NAME [--edition paper] [--mc-version 1.21.1] [--memory-mb 4096] [--cpu-limit 2] [--public-port 34567]",
    "  archive --name NAME [--label LABEL]",
    "  restore --archive-id ID [--name NAME] [--public-port PORT]",
    "  delete-archive --archive-id ID",
    "  controller",
    "  serve-controller",
    "",
    "Common options:",
    "  --json",
    "  --registry-file PATH",
    "  --archives-file PATH",
    "  --registry-mode auto|local|manager",
    "  --manager-container NAME",
    "  --max-active COUNT",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { json: false };
  let action = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const equalsIndex = arg.indexOf("=");
      const key = arg
        .slice(2, equalsIndex === -1 ? undefined : equalsIndex)
        .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      const value = equalsIndex === -1 ? argv[index + 1] : arg.slice(equalsIndex + 1);
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[key] = value;
      if (equalsIndex === -1) index += 1;
      continue;
    }
    if (!action) {
      action = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { action, options };
}

function printResult(options, value) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${value.message || JSON.stringify(value, null, 2)}\n`);
}

function fail(options, err) {
  const message = err instanceof Error ? err.message : String(err);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
}

function requireRoot(action) {
  if (action === "list") return;
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("mc-server-lifecycle must be run as root for controller, serve-controller, create, archive, restore, and delete-archive");
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLifecycleLock(options, fn) {
  const lockFile = options.lockFile || DEFAULT_LOCK_FILE;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  const startedAt = Date.now();
  const timeoutMs = parsePositiveInt(options.lockTimeoutMs, 120000, "lock-timeout-ms");
  let lockFd = -1;

  while (lockFd === -1) {
    try {
      lockFd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(lockFd, `${process.pid}\n${new Date().toISOString()}\n`);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for lifecycle lock ${lockFile}`);
      }
      sleep(250);
    }
  }

  try {
    return fn();
  } finally {
    try {
      if (lockFd !== -1) fs.closeSync(lockFd);
    } finally {
      fs.rmSync(lockFile, { force: true });
    }
  }
}

function commandOutput(command, args, allowFailure = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function findLxc() {
  const candidates = [process.env.LXC_BIN, "/snap/bin/lxc", "/usr/bin/lxc", "lxc"].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") && !fs.existsSync(candidate)) continue;
    const result = commandOutput(candidate, ["version"], true);
    if (result.ok) return candidate;
  }
  throw new Error("lxc command not found");
}

function runLxc(args, allowFailure = false) {
  return commandOutput(findLxc(), args, allowFailure);
}

function safeName(value, label) {
  const name = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/.test(name)) {
    throw new Error(`${label} must be 2-63 characters using letters, numbers, dots, underscores, or dashes`);
  }
  return name;
}

function parsePort(value, fallback, label = "port") {
  const port = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return port;
}

function parsePositiveInt(value, fallback, label) {
  const number = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function parseMaxActive(value) {
  return Math.min(parsePositiveInt(value, DEFAULT_MAX_ACTIVE, "max-active"), HARD_MAX_ACTIVE_SERVERS);
}

function registryMode(options) {
  const mode = options.registryMode || process.env.LIFECYCLE_REGISTRY_MODE || "auto";
  if (mode === "local" || mode === "manager") return mode;
  return fs.existsSync(options.registryFile || DEFAULT_REGISTRY_FILE) ? "local" : "manager";
}

function readJsonStore(file, fallback, options) {
  const mode = registryMode(options);
  if (mode === "local") {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  const manager = options.managerContainer || DEFAULT_MANAGER_CONTAINER;
  const result = runLxc(["exec", manager, "--", "cat", file], true);
  if (!result.ok || !result.stdout.trim()) return fallback;
  return JSON.parse(result.stdout);
}

function chownToManager(file) {
  const user = process.env.MC_MANAGER_USER || "mcmanager";
  try {
    const uid = Number(execFileSync("id", ["-u", user], { encoding: "utf8" }).trim());
    const gid = Number(execFileSync("id", ["-g", user], { encoding: "utf8" }).trim());
    fs.chownSync(file, uid, gid);
  } catch {
    // Keep root ownership when the management user is not present.
  }
}

function writeJsonStore(file, value, options) {
  const mode = registryMode(options);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (mode === "local") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tempFile, text, { mode: 0o600 });
    fs.renameSync(tempFile, file);
    fs.chmodSync(file, 0o600);
    chownToManager(file);
    return;
  }

  const manager = options.managerContainer || DEFAULT_MANAGER_CONTAINER;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-lifecycle-"));
  const tempFile = path.join(dir, path.basename(file));
  fs.writeFileSync(tempFile, text, { mode: 0o600 });
  try {
    runLxc(["file", "push", tempFile, `${manager}${file}`]);
    runLxc(["exec", manager, "--", "chown", "mcmanager:mcmanager", file], true);
    runLxc(["exec", manager, "--", "chmod", "600", file], true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function loadRegistry(options) {
  const registry = readJsonStore(options.registryFile || DEFAULT_REGISTRY_FILE, { servers: [] }, options);
  if (!Array.isArray(registry.servers)) registry.servers = [];
  return registry;
}

function saveRegistry(registry, options) {
  writeJsonStore(options.registryFile || DEFAULT_REGISTRY_FILE, registry, options);
}

function loadArchives(options) {
  const value = readJsonStore(options.archivesFile || DEFAULT_ARCHIVES_FILE, { archives: [] }, options);
  if (Array.isArray(value)) return value;
  return Array.isArray(value.archives) ? value.archives : [];
}

function saveArchives(archives, options) {
  writeJsonStore(options.archivesFile || DEFAULT_ARCHIVES_FILE, { archives }, options);
}

function nextServerName(registry) {
  const names = new Set(registry.servers.map((server) => server.name));
  for (let index = 1; index <= 99; index += 1) {
    const name = `mc-server-${index}`;
    if (!names.has(name)) return name;
  }
  throw new Error("No available mc-server-N name found");
}

function nextPublicPort(registry) {
  const ports = new Set(registry.servers.map((server) => Number(server.public_port)).filter(Boolean));
  for (let port = 34567; port <= 34699; port += 1) {
    if (!ports.has(port)) return port;
  }
  throw new Error("No available public port found in 34567-34699");
}

function hostIp() {
  if (process.env.LXD_HOST_IP) return process.env.LXD_HOST_IP;
  const result = commandOutput("ip", ["route", "get", "1.1.1.1"], true);
  const match = result.stdout.match(/\bsrc\s+(\S+)/);
  return match?.[1] || "";
}

function waitForIp(name) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = runLxc(["list", name, "-c4", "--format=csv"], true);
    const match = result.stdout.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    if (match) return match[0];
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error(`Timed out waiting for ${name} to receive an IP address`);
}

function serverExists(name) {
  return runLxc(["info", name], true).ok;
}

function listServerContainerNames() {
  let result;
  try {
    result = runLxc(["list", "--format=json"], true);
  } catch {
    return [];
  }
  if (!result.ok || !result.stdout.trim()) return [];
  try {
    const containers = JSON.parse(result.stdout);
    if (!Array.isArray(containers)) return [];
    return containers
      .map((container) => String(container?.name || ""))
      .filter((name) => /^mc-server-[a-zA-Z0-9_.-]*$/.test(name));
  } catch {
    return [];
  }
}

function activeServerNames(registry) {
  return new Set([
    ...registry.servers.map((server) => String(server.name || "")).filter(Boolean),
    ...listServerContainerNames(),
  ]);
}

function ensureActiveServerCapacity(registry, options) {
  const maxActive = parseMaxActive(options.maxActive);
  const activeNames = activeServerNames(registry);
  if (activeNames.size >= maxActive) {
    throw new Error(`Maximum active server limit reached (${maxActive})`);
  }
  return { maxActive, activeNames };
}

function createServer(options) {
  const registry = loadRegistry(options);
  const { activeNames } = ensureActiveServerCapacity(registry, options);

  const name = safeName(options.name || nextServerName(registry), "server name");
  if (registry.servers.some((server) => server.name === name)) throw new Error(`Server ${name} is already registered`);
  if (activeNames.has(name) || serverExists(name)) throw new Error(`LXD container ${name} already exists`);

  const edition = String(options.edition || "paper").toLowerCase();
  if (!["paper", "vanilla"].includes(edition)) {
    throw new Error("edition must be paper or vanilla");
  }

  const mcVersion = String(options.mcVersion || "1.21.1");
  const memoryMb = parsePositiveInt(options.memoryMb, 4096, "memory-mb");
  const cpuLimit = String(options.cpuLimit || "2");
  const publicPort = parsePort(options.publicPort, nextPublicPort(registry), "public-port");
  const managerContainer = options.managerContainer || DEFAULT_MANAGER_CONTAINER;
  const createScript = options.createScript || path.join(REPO_ROOT, "apps/scripts/create-mc-server.sh");
  if (!fs.existsSync(createScript)) throw new Error(`Create script not found: ${createScript}`);

  commandOutput(createScript, [
    name,
    edition,
    mcVersion,
    String(memoryMb),
    cpuLimit,
    String(publicPort),
    "25575",
    "",
    managerContainer,
  ], false);

  const refreshed = loadRegistry(options);
  const server = refreshed.servers.find((entry) => entry.name === name);
  return {
    ok: true,
    message: `Created ${name}`,
    server,
  };
}

function archiveServer(options) {
  const name = safeName(options.name, "server name");
  const registry = loadRegistry(options);
  const index = registry.servers.findIndex((server) => server.name === name);
  if (index === -1) throw new Error(`Server ${name} is not registered`);
  if (!serverExists(name)) throw new Error(`LXD container ${name} does not exist`);

  const source = registry.servers[index];
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const id = `${name}-${stamp}-${randomBytes(3).toString("hex")}`;
  const snapshot = `archive-${stamp}`;
  const imageAlias = `${ARCHIVE_IMAGE_PREFIX}${id}`;

  runLxc(["exec", name, "--", "systemctl", "stop", "minecraft"], true);
  runLxc(["exec", name, "--", "systemctl", "stop", "mc-agent"], true);
  const stopped = runLxc(["stop", name, "--timeout", "60"], true);
  if (!stopped.ok) runLxc(["stop", name, "--force"]);
  runLxc(["snapshot", name, snapshot]);
  runLxc(["publish", `${name}/${snapshot}`, `--alias=${imageAlias}`]);

  const archives = loadArchives(options);
  const archive = {
    id,
    label: String(options.label || "").trim() || undefined,
    sourceName: name,
    imageAlias,
    createdAt: new Date().toISOString(),
    server: source,
  };
  archives.unshift(archive);
  saveArchives(archives, options);

  registry.servers.splice(index, 1);
  saveRegistry(registry, options);
  runLxc(["delete", name, "--force"]);

  return {
    ok: true,
    message: `Archived ${name}`,
    archive,
  };
}

function restoreArchive(options) {
  const archiveId = safeName(options.archiveId, "archive id");
  const archives = loadArchives(options);
  const archive = archives.find((entry) => entry.id === archiveId);
  if (!archive) throw new Error(`Archive ${archiveId} not found`);

  const registry = loadRegistry(options);
  const { activeNames } = ensureActiveServerCapacity(registry, options);

  const name = safeName(options.name || archive.server.name || archive.sourceName, "server name");
  if (registry.servers.some((server) => server.name === name)) throw new Error(`Server ${name} is already registered`);
  if (activeNames.has(name) || serverExists(name)) throw new Error(`LXD container ${name} already exists`);
  const publicPort = parsePort(options.publicPort, archive.server.public_port || 34567, "public-port");

  runLxc(["launch", archive.imageAlias, name]);
  const ip = waitForIp(name);
  runLxc(["config", "device", "remove", name, "mc-proxy"], true);
  runLxc([
    "config",
    "device",
    "add",
    name,
    "mc-proxy",
    "proxy",
    `listen=tcp:0.0.0.0:${publicPort}`,
    "connect=tcp:127.0.0.1:25565",
  ]);

  const server = {
    ...archive.server,
    name,
    agent_url: `http://${ip}:9090`,
    local_ip: ip,
    public_port: publicPort,
    host_proxy_port: publicPort,
    host_ip: hostIp() || archive.server.host_ip,
  };
  registry.servers.push(server);
  saveRegistry(registry, options);

  return {
    ok: true,
    message: `Restored ${name}`,
    server,
    archive,
  };
}

function deleteArchive(options) {
  const archiveId = safeName(options.archiveId, "archive id");
  const archives = loadArchives(options);
  const archive = archives.find((entry) => entry.id === archiveId);
  if (!archive) throw new Error(`Archive ${archiveId} not found`);
  runLxc(["image", "delete", archive.imageAlias], true);
  const nextArchives = archives.filter((entry) => entry.id !== archiveId);
  saveArchives(nextArchives, options);
  return {
    ok: true,
    message: `Deleted archive ${archiveId}`,
    archives: nextArchives,
  };
}

function listState(options) {
  const registry = loadRegistry(options);
  const archives = loadArchives(options);
  const maxActive = parseMaxActive(options.maxActive);
  const activeNames = activeServerNames(registry);
  return {
    ok: true,
    maxActiveServers: maxActive,
    activeServers: activeNames.size,
    slotsAvailable: Math.max(0, maxActive - activeNames.size),
    archives,
  };
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function sanitizeControllerRequest(request, baseOptions) {
  const action = String(request?.action || "").trim();
  if (!CONTROLLER_ACTIONS.has(action)) {
    throw new Error(`Lifecycle controller action is not allowed: ${action || "(empty)"}`);
  }

  const params = request?.params && typeof request.params === "object" ? request.params : {};
  const options = {
    ...baseOptions,
    maxActive: HARD_MAX_ACTIVE_SERVERS,
  };

  if (action === "create") {
    return {
      action,
      options: {
        ...options,
        name: params.name,
        edition: params.edition,
        mcVersion: params.mcVersion,
        memoryMb: params.memoryMb,
        cpuLimit: params.cpuLimit,
        publicPort: params.publicPort,
      },
    };
  }

  if (action === "archive") {
    return {
      action,
      options: {
        ...options,
        name: params.name,
        label: params.label,
      },
    };
  }

  if (action === "restore") {
    return {
      action,
      options: {
        ...options,
        archiveId: params.archiveId,
        name: params.name,
        publicPort: params.publicPort,
      },
    };
  }

  if (action === "delete-archive") {
    return {
      action,
      options: {
        ...options,
        archiveId: params.archiveId,
      },
    };
  }

  return { action, options };
}

function dispatchLifecycleAction(action, options) {
  switch (action) {
    case "list":
      return listState(options);
    case "create":
      return createServer(options);
    case "archive":
      return archiveServer(options);
    case "restore":
      return restoreArchive(options);
    case "delete-archive":
      return deleteArchive(options);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function runController(options) {
  let request = {};
  const body = readStdin().trim();
  if (body) request = JSON.parse(body);
  const sanitized = sanitizeControllerRequest(request, options);
  return withLifecycleLock(sanitized.options, () => dispatchLifecycleAction(sanitized.action, sanitized.options));
}

function controllerToken() {
  const token = process.env.SERVER_LIFECYCLE_CONTROLLER_TOKEN || "";
  if (token.length < 32) {
    throw new Error("SERVER_LIFECYCLE_CONTROLLER_TOKEN must be set to at least 32 characters");
  }
  return token;
}

function bearerToken(header) {
  const value = String(header || "");
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : "";
}

function tokenMatches(candidate, expected) {
  const left = Buffer.from(String(candidate || ""));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > CONTROLLER_MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function serveController(options) {
  const host = process.env.SERVER_LIFECYCLE_CONTROLLER_HOST || options.host || "127.0.0.1";
  const port = parsePort(options.port || process.env.SERVER_LIFECYCLE_CONTROLLER_PORT, 9107, "controller-port");
  const expectedToken = controllerToken();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method !== "POST" || req.url !== "/lifecycle") {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      if (!tokenMatches(bearerToken(req.headers.authorization), expectedToken)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const rawBody = await readRequestBody(req);
      const request = rawBody.trim() ? JSON.parse(rawBody) : {};
      const sanitized = sanitizeControllerRequest(request, options);
      const result = withLifecycleLock(sanitized.options, () => dispatchLifecycleAction(sanitized.action, sanitized.options));
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, host, () => {
    process.stdout.write(`mc-server lifecycle controller listening on ${host}:${port}\n`);
  });
}

function main() {
  const { action, options } = parseArgs(process.argv.slice(2));
  if (options.help || !action) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  options.registryFile = options.registryFile || DEFAULT_REGISTRY_FILE;
  options.archivesFile = options.archivesFile || DEFAULT_ARCHIVES_FILE;
  requireRoot(action);

  switch (action) {
    case "controller":
      printResult(options, runController(options));
      return;
    case "serve-controller":
      serveController(options);
      return;
    case "list":
      printResult(options, listState(options));
      return;
    case "create":
      printResult(options, createServer(options));
      return;
    case "archive":
      printResult(options, archiveServer(options));
      return;
    case "restore":
      printResult(options, restoreArchive(options));
      return;
    case "delete-archive":
      printResult(options, deleteArchive(options));
      return;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

try {
  main();
} catch (err) {
  const parsed = parseArgs(process.argv.slice(2));
  fail(parsed.options, err);
}
