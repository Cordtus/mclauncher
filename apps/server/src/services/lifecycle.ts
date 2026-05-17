import { constants, existsSync, readFileSync, accessSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARD_MAX_ACTIVE_SERVERS = 3;
const LIFECYCLE_ACTIONS = new Set(["list", "create", "archive", "restore", "delete-archive"]);

export interface ServerArchiveRecord {
  id: string;
  label?: string;
  sourceName: string;
  imageAlias: string;
  createdAt: string;
  server: {
    name: string;
    public_port: number;
    memory_mb: number;
    cpu_limit?: string;
    edition: string;
    mc_version: string;
    public_domain?: string;
    host_ip?: string;
    host_proxy_port?: number;
  };
}

export interface LifecycleState {
  configured: boolean;
  unavailableReason?: string;
  maxActiveServers: number;
  activeServers: number;
  slotsAvailable: number;
  archives: ServerArchiveRecord[];
}

export interface LifecycleActionResult {
  ok?: boolean;
  message?: string;
  archive?: ServerArchiveRecord;
  archives?: ServerArchiveRecord[];
  server?: unknown;
  rawOutput?: string;
}

export interface LifecycleOptions {
  registryFile: string;
  archivesFile: string;
  maxActiveServers: number;
}

function defaultLifecycleCommand() {
  return path.resolve(MODULE_DIR, "../../../scripts/mc-server-lifecycle.mjs");
}

function lifecycleCommand() {
  return process.env.SERVER_LIFECYCLE_COMMAND || defaultLifecycleCommand();
}

function lifecycleUsesSudo() {
  return (process.env.SERVER_LIFECYCLE_USE_SUDO || "false").toLowerCase() === "true";
}

function lifecycleControllerUrl() {
  return process.env.SERVER_LIFECYCLE_CONTROLLER_URL || "";
}

function lifecycleControllerToken() {
  return process.env.SERVER_LIFECYCLE_CONTROLLER_TOKEN || "";
}

function commandLooksExecutable(command: string) {
  if (!command.includes("/")) return true;
  try {
    accessSync(command, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lifecycleUnavailableReason(command: string) {
  const controllerUrl = lifecycleControllerUrl();
  if (controllerUrl) {
    if (!lifecycleControllerToken()) return "Lifecycle controller URL is configured but SERVER_LIFECYCLE_CONTROLLER_TOKEN is missing";
    return undefined;
  }

  if (!commandLooksExecutable(command)) {
    return `Lifecycle controller is not executable: ${command}`;
  }
  if (!process.env.SERVER_LIFECYCLE_COMMAND && typeof process.getuid === "function" && process.getuid() !== 0 && !lifecycleUsesSudo()) {
    return "Lifecycle controller requires root. Set SERVER_LIFECYCLE_USE_SUDO=true after granting mcmanager sudo access to the controller entry point.";
  }
  return undefined;
}

function readArchivesFile(file: string): ServerArchiveRecord[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.archives)) return parsed.archives;
  } catch {
    return [];
  }
  return [];
}

export function getLifecycleState(options: LifecycleOptions, activeServers: number): LifecycleState {
  const command = lifecycleCommand();
  const unavailableReason = lifecycleUnavailableReason(command);
  const archives = readArchivesFile(options.archivesFile);
  return {
    configured: !unavailableReason,
    unavailableReason,
    maxActiveServers: Math.min(options.maxActiveServers, HARD_MAX_ACTIVE_SERVERS),
    activeServers,
    slotsAvailable: Math.max(0, Math.min(options.maxActiveServers, HARD_MAX_ACTIVE_SERVERS) - activeServers),
    archives,
  };
}

function runController(command: string, args: string[], request: unknown, options: LifecycleOptions): Promise<LifecycleActionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        REGISTRY_FILE: options.registryFile,
        SERVER_ARCHIVES_FILE: options.archivesFile,
        MAX_ACTIVE_SERVERS: String(Math.min(options.maxActiveServers, HARD_MAX_ACTIVE_SERVERS)),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Lifecycle controller timed out"));
    }, Number(process.env.SERVER_LIFECYCLE_TIMEOUT_MS || 10 * 60 * 1000));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024 * 4) {
        child.kill("SIGTERM");
        reject(new Error("Lifecycle controller output exceeded 4MB"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        try {
          const parsed = JSON.parse(stdout.trim());
          reject(new Error(parsed.error || stderr.trim() || `Lifecycle controller failed with exit code ${code}`));
        } catch {
          reject(new Error(stderr.trim() || stdout.trim() || `Lifecycle controller failed with exit code ${code}`));
        }
        return;
      }

      const output = stdout.trim();
      if (!output) {
        resolve({ ok: true });
        return;
      }
      try {
        resolve(JSON.parse(output) as LifecycleActionResult);
      } catch {
        resolve({ ok: true, rawOutput: output });
      }
    });

    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

async function postControllerRequest(request: unknown): Promise<LifecycleActionResult> {
  const controllerUrl = lifecycleControllerUrl();
  const token = lifecycleControllerToken();
  if (!controllerUrl || !token) throw new Error("Lifecycle controller URL/token is not configured");

  const response = await fetch(new URL("/lifecycle", controllerUrl), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const body = await response.json().catch(() => ({})) as LifecycleActionResult & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || `Lifecycle controller failed with HTTP ${response.status}`);
  }
  return body;
}

export async function runLifecycleAction(
  action: string,
  values: Record<string, unknown>,
  options: LifecycleOptions
): Promise<LifecycleActionResult> {
  if (!LIFECYCLE_ACTIONS.has(action)) {
    throw new Error(`Lifecycle action is not allowed: ${action}`);
  }

  const request = {
    action,
    params: values,
  };

  if (lifecycleControllerUrl()) {
    return postControllerRequest(request);
  }

  const helper = lifecycleCommand();
  const unavailableReason = lifecycleUnavailableReason(helper);
  if (unavailableReason) {
    throw new Error(unavailableReason);
  }

  const controllerArgs = [
    "controller",
    "--json",
  ];

  const command = lifecycleUsesSudo() ? "sudo" : helper;
  const args = lifecycleUsesSudo() ? ["-n", helper, ...controllerArgs] : controllerArgs;
  return runController(command, args, request, options);
}
