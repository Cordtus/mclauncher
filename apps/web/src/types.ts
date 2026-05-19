export type ServerRow = {
  name: string;
  status: string;
  local_ip: string;
  local_port: number;
  host_ip?: string | null;
  host_proxy_port?: number | null;
  public_port: number;
  public_domain: string | null;
  memory_mb: number;
  cpu_limit: string;
  edition: string;
  mc_version: string;
  loader_version?: string | null;
  minecraft: {
    online: boolean;
    players?: {
      online: number;
      max: number;
      sample?: Array<{ name: string; id: string }>;
    };
    description?: string;
    version?: string;
    latency?: number;
  } | null;
};

export type PublicServerRow = {
  name: string;
  status: "Running";
  edition: string;
  mc_version: string;
  public_address: string;
  players: {
    online: number;
    max: number;
  };
  description: string | null;
  version: string | null;
  latency: number | null;
  requires_client_mods: boolean;
  modpack_url: string | null;
  mrpack_url: string | null;
  modlist_url: string | null;
};

export type PublicAccessState = {
  accessible: boolean | null;
  checking: boolean;
  address?: string;
  reason?: string | null;
  checkedAt?: string;
};

export type ServerArchive = {
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
  };
};

export type LifecycleState = {
  configured: boolean;
  unavailableReason?: string;
  maxActiveServers: number;
  activeServers: number;
  slotsAvailable: number;
  activeServerNames?: string[];
  archives: ServerArchive[];
};

export type AuthConfig = {
  authMethods: string[];
  cidrRequired?: boolean;
  devLogin?: {
    enabled?: boolean;
  };
  passkeys?: {
    enabled?: boolean;
    hasPasskeys?: boolean;
    registrationCodesAvailable?: boolean;
    rpId?: string;
    origin?: string;
    userVerification?: string;
  };
};

export type ServerSettingsResponse = {
  properties?: Record<string, unknown>;
  whitelist?: Array<{ uuid: string; name: string }>;
  operators?: Array<{ uuid: string; name: string; level?: number }>;
};

export type BansResponse = {
  players: Array<{ uuid: string; name: string; reason?: string; created: string }>;
  ips: Array<{ ip: string; reason?: string; created: string }>;
};

export type WorldInfo = {
  name: string;
  size: number;
  lastPlayed: string;
  isActive: boolean;
};

export type WorldGenerateInput = {
  name: string;
  seed?: string;
  levelType?: string;
};

export type InstalledPlugin = {
  fileName: string;
  pluginId: string;
  name: string;
  version: string;
  description?: string;
  authors?: string[];
  main?: string;
  apiVersion?: string;
  dependencies?: string[];
  softDependencies?: string[];
  enabled: boolean;
};

export type JvmSettings = {
  xms: number;
  xmsUnit: string;
  xmx: number;
  xmxUnit: string;
  gc: string;
  customFlags: string;
};

export type ServerSettingsDraft = {
  hostIp: string;
  publicDomain: string;
  publicPort: number;
  hostProxyPort: number;
  motd: string;
  maxPlayers: number;
  gamemode: string;
  difficulty: string;
  pvp: boolean;
  spawnProtection: number;
  viewDistance: number;
  onlineMode: boolean;
  allowFlight: boolean;
  enforceWhitelist: boolean;
  whitelist: string[];
  operators: string[];
  bannedPlayers: BansResponse["players"];
  bannedIps: BansResponse["ips"];
  jvmXms: number;
  jvmXmsUnit: string;
  jvmXmx: number;
  jvmXmxUnit: string;
  jvmGc: string;
  jvmCustomFlags: string;
};

export type CreateServerInput = {
  name?: string;
  edition: string;
  mc_version: string;
  memory_mb: number;
  cpu_limit: string;
  public_port: number;
};
