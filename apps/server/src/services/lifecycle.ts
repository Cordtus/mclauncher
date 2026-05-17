import { constants, existsSync, readFileSync, accessSync } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

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
  if (!commandLooksExecutable(command)) {
    return `Lifecycle helper is not executable: ${command}`;
  }
  if (!process.env.SERVER_LIFECYCLE_COMMAND && typeof process.getuid === "function" && process.getuid() !== 0 && !lifecycleUsesSudo()) {
    return "Lifecycle helper requires root. Set SERVER_LIFECYCLE_USE_SUDO=true after granting mcmanager sudo access to the helper.";
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
    maxActiveServers: options.maxActiveServers,
    activeServers,
    slotsAvailable: Math.max(0, options.maxActiveServers - activeServers),
    archives,
  };
}

function optionArgs(values: Record<string, unknown>) {
  const args: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    args.push(`--${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`, String(value));
  }
  return args;
}

export async function runLifecycleAction(
  action: string,
  values: Record<string, unknown>,
  options: LifecycleOptions
): Promise<LifecycleActionResult> {
  const helper = lifecycleCommand();
  const unavailableReason = lifecycleUnavailableReason(helper);
  if (unavailableReason) {
    throw new Error(unavailableReason);
  }

  const helperArgs = [
    action,
    "--json",
    "--registry-file",
    options.registryFile,
    "--archives-file",
    options.archivesFile,
    "--max-active",
    String(options.maxActiveServers),
    ...optionArgs(values),
  ];

  const command = lifecycleUsesSudo() ? "sudo" : helper;
  const args = lifecycleUsesSudo() ? ["-n", helper, ...helperArgs] : helperArgs;
  const { stdout } = await execFileAsync(command, args, {
    env: {
      ...process.env,
      REGISTRY_FILE: options.registryFile,
      SERVER_ARCHIVES_FILE: options.archivesFile,
      MAX_ACTIVE_SERVERS: String(options.maxActiveServers),
    },
    maxBuffer: 1024 * 1024 * 4,
    timeout: Number(process.env.SERVER_LIFECYCLE_TIMEOUT_MS || 10 * 60 * 1000),
  });

  const output = stdout.trim();
  if (!output) return { ok: true };
  try {
    return JSON.parse(output) as LifecycleActionResult;
  } catch {
    return { ok: true, rawOutput: output };
  }
}
