import type {
  AuthConfig,
  BansResponse,
  CreateServerInput,
  InstalledPlugin,
  JvmSettings,
  LifecycleState,
  PublicServerRow,
  PublicAccessState,
  ServerRow,
  ServerSettingsResponse,
  WorldGenerateInput,
  WorldInfo,
} from "@/types";
import { authHeaders, jsonAuthHeaders } from "@/lib/auth";

export type ServerStateEvent = {
  generatedAt: string;
  servers: ServerRow[];
  lifecycle: LifecycleState;
};

export type PublicServerStateEvent = {
  generatedAt: string;
  servers: PublicServerRow[];
};

export type ServerLogsEvent = {
  generatedAt: string;
  name: string;
  logs: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readResponseBody(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => ({}));
  }
  return response.text();
}

function errorMessage(body: unknown, fallback: string) {
  if (body && typeof body === "object" && "error" in body) {
    const value = (body as { error?: unknown }).error;
    if (typeof value === "string" && value.trim()) return value;
  }
  if (typeof body === "string" && body.trim()) return body;
  return fallback;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  responseType: "json" | "text" = "json"
): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: options.headers,
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new ApiError(errorMessage(body, response.statusText), response.status, body);
  }

  return (responseType === "text" ? String(body) : body) as T;
}

export function encodePath(value: string) {
  return encodeURIComponent(value);
}

export const api = {
  getAuthConfig: () => apiFetch<AuthConfig>("/api/auth/config"),
  getServers: () => apiFetch<ServerRow[]>("/api/servers", { headers: authHeaders() }),
  subscribeServerEvents: (
    onState: (state: ServerStateEvent) => void,
    onError?: (event: Event) => void
  ) => {
    const source = new EventSource("/api/servers/events", { withCredentials: true });
    source.addEventListener("server-state", (event) => {
      onState(JSON.parse((event as MessageEvent).data) as ServerStateEvent);
    });
    source.addEventListener("server-state-error", (event) => {
      onError?.(event);
    });
    source.onerror = (event) => onError?.(event);
    return source;
  },
  getPublicServers: () => apiFetch<PublicServerRow[]>("/api/public/servers"),
  subscribePublicServerEvents: (
    onState: (state: PublicServerStateEvent) => void,
    onError?: (event: Event) => void
  ) => {
    const source = new EventSource("/api/public/servers/events", { withCredentials: true });
    source.addEventListener("public-server-state", (event) => {
      onState(JSON.parse((event as MessageEvent).data) as PublicServerStateEvent);
    });
    source.addEventListener("public-server-state-error", (event) => {
      onError?.(event);
    });
    source.onerror = (event) => onError?.(event);
    return source;
  },
  subscribeServerLogs: (
    name: string,
    onLogs: (state: ServerLogsEvent) => void,
    onError?: (event: Event) => void
  ) => {
    const source = new EventSource(`/api/servers/${encodePath(name)}/logs/events`, { withCredentials: true });
    source.addEventListener("server-logs", (event) => {
      onLogs(JSON.parse((event as MessageEvent).data) as ServerLogsEvent);
    });
    source.addEventListener("server-logs-error", (event) => {
      onError?.(event);
    });
    source.onerror = (event) => onError?.(event);
    return source;
  },
  getLifecycle: () => apiFetch<LifecycleState>("/api/server-lifecycle", { headers: authHeaders() }),
  createServer: (input: CreateServerInput) =>
    apiFetch<{ ok?: boolean; message?: string }>("/api/server-lifecycle/create", {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify(input),
    }),
  archiveServer: (name: string, label?: string) =>
    apiFetch<{ ok?: boolean; message?: string }>(`/api/servers/${encodePath(name)}/archive`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ label: label?.trim() || undefined }),
    }),
  restoreArchive: (id: string, input: { name?: string; public_port: number }) =>
    apiFetch<{ ok?: boolean; message?: string }>(`/api/server-lifecycle/archives/${encodePath(id)}/restore`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify(input),
    }),
  deleteArchive: (id: string) =>
    apiFetch<{ ok?: boolean; message?: string }>(`/api/server-lifecycle/archives/${encodePath(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }),
  serverAction: (name: string, action: "start" | "stop" | "restart" | "backup") =>
    apiFetch<{ ok?: boolean; message?: string } | string>(
      `/api/servers/${encodePath(name)}/${action}`,
      { method: "POST", headers: authHeaders() },
      action === "backup" ? "text" : "json"
    ),
  getLogs: (name: string) =>
    apiFetch<string>(`/api/servers/${encodePath(name)}/logs`, { headers: authHeaders() }, "text"),
  getTps: (name: string) =>
    apiFetch<{ raw?: string; tps?: unknown }>(`/api/servers/${encodePath(name)}/tps`, { headers: authHeaders() }),
  checkPublicAccess: (name: string) =>
    apiFetch<PublicAccessState>(`/api/servers/${encodePath(name)}/check-public`, { headers: authHeaders() }),
  patchServerConfig: (name: string, input: Record<string, string | number | null>) =>
    apiFetch<{ ok?: boolean; message?: string; server?: ServerRow }>(`/api/servers/${encodePath(name)}/config`, {
      method: "PATCH",
      headers: jsonAuthHeaders(),
      body: JSON.stringify(input),
    }),
  getSettings: (name: string) =>
    apiFetch<ServerSettingsResponse>(`/api/servers/${encodePath(name)}/settings`, { headers: authHeaders() }),
  applySettings: (name: string, input: unknown) =>
    apiFetch<{ success?: boolean; message?: string }>(`/api/servers/${encodePath(name)}/settings`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify(input),
    }),
  getBans: (name: string) =>
    apiFetch<BansResponse>(`/api/servers/${encodePath(name)}/settings/bans`, { headers: authHeaders() }),
  banPlayer: (name: string, username: string, reason?: string) =>
    apiFetch<{ success?: boolean; message?: string }>(`/api/servers/${encodePath(name)}/settings/bans/player/add`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ username, reason }),
    }),
  pardonPlayer: (name: string, username: string) =>
    apiFetch<{ success?: boolean; message?: string }>(`/api/servers/${encodePath(name)}/settings/bans/player/remove`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ username }),
    }),
  banIp: (name: string, ip: string, reason?: string) =>
    apiFetch<{ success?: boolean; message?: string }>(`/api/servers/${encodePath(name)}/settings/bans/ip/add`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ ip, reason }),
    }),
  pardonIp: (name: string, ip: string) =>
    apiFetch<{ success?: boolean; message?: string }>(`/api/servers/${encodePath(name)}/settings/bans/ip/remove`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ ip }),
    }),
  getJvmSettings: (name: string) =>
    apiFetch<JvmSettings>(`/api/servers/${encodePath(name)}/jvm/settings`, { headers: authHeaders() }),
  applyJvmSettings: (name: string, input: JvmSettings) =>
    apiFetch<{ success?: boolean; message?: string }>(`/api/servers/${encodePath(name)}/jvm/settings`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify(input),
    }),
  runCommand: (name: string, command: string) =>
    apiFetch<string>(`/api/servers/${encodePath(name)}/command`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ command }),
    }, "text"),
  changeVersion: (name: string, input: { type: string; version: string }) =>
    apiFetch<{ message?: string; error?: string }>(`/api/servers/${encodePath(name)}/version/change`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify(input),
    }),
  getWorlds: (name: string) =>
    apiFetch<string[]>(`/api/servers/${encodePath(name)}/worlds`, { headers: authHeaders() }),
  getWorldDetails: (name: string) =>
    apiFetch<WorldInfo[]>(`/api/servers/${encodePath(name)}/worlds/details`, { headers: authHeaders() }),
  generateWorld: (name: string, input: WorldGenerateInput) =>
    apiFetch<{ ok?: boolean; message?: string; world?: WorldInfo }>(`/api/servers/${encodePath(name)}/worlds/generate`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify(input),
    }),
  switchWorld: (name: string, worldName: string) =>
    apiFetch<string>(`/api/servers/${encodePath(name)}/worlds/switch`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ world_name: worldName }),
    }, "text"),
  deleteWorld: (name: string, worldName: string) =>
    apiFetch<{ ok?: boolean; message?: string }>(`/api/servers/${encodePath(name)}/worlds/${encodePath(worldName)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }),
  backupWorld: (name: string, worldName: string) =>
    apiFetch<{ ok?: boolean; backupPath?: string; message?: string }>(
      `/api/servers/${encodePath(name)}/worlds/${encodePath(worldName)}/backup`,
      { method: "POST", headers: authHeaders() }
    ),
  worldDownloadUrl: (name: string, worldName: string) =>
    `/api/servers/${encodePath(name)}/worlds/${encodePath(worldName)}/download`,
  uploadFile: (name: string, endpoint: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return apiFetch<string>(`/api/servers/${encodePath(name)}/${endpoint}`, {
      method: "POST",
      headers: authHeaders(),
      body: formData,
    }, "text");
  },
  installRecommendedPlugins: (name: string, plugins: string[]) =>
    apiFetch<{ success?: boolean; installed: string[]; failed?: Array<{ plugin: string; error: string }>; message?: string }>(
      `/api/servers/${encodePath(name)}/plugins/recommended`,
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ plugins }),
      }
    ),
  getPlugins: (name: string) =>
    apiFetch<{ plugins: InstalledPlugin[] }>(`/api/servers/${encodePath(name)}/plugins/installed`, {
      headers: authHeaders(),
    }),
  togglePlugin: (name: string, fileName: string, enabled: boolean) =>
    apiFetch<{ ok?: boolean; message?: string; newFileName?: string }>(
      `/api/servers/${encodePath(name)}/plugins/${encodePath(fileName)}/toggle`,
      {
        method: "PATCH",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ enabled }),
      }
    ),
  deletePlugin: (name: string, fileName: string) =>
    apiFetch<{ ok?: boolean; message?: string }>(
      `/api/servers/${encodePath(name)}/plugins/${encodePath(fileName)}`,
      { method: "DELETE", headers: authHeaders() }
    ),
};
