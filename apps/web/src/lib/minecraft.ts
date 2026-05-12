export const DEFAULT_MINECRAFT_PORT = 25565;

type ServerConnection = {
  name: string;
  local_ip?: string | null;
  local_port?: number | string | null;
  host_ip?: string | null;
  host_proxy_port?: number | string | null;
  public_port?: number | string | null;
  public_domain?: string | null;
  edition: string;
  mc_version: string;
};

export function isDefaultMinecraftPort(port?: number | string | null) {
  const parsed = Number(port || DEFAULT_MINECRAFT_PORT);
  return parsed === DEFAULT_MINECRAFT_PORT;
}

export function formatMinecraftAddress(host?: string | null, port?: number | string | null) {
  const cleanHost = host?.trim();
  if (!cleanHost) return "";

  const parsedPort = Number(port || DEFAULT_MINECRAFT_PORT);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return cleanHost;
  }

  return parsedPort === DEFAULT_MINECRAFT_PORT ? cleanHost : `${cleanHost}:${parsedPort}`;
}

export function getPublicJoinAddress(server: ServerConnection) {
  return formatMinecraftAddress(server.public_domain, server.public_port);
}

export function getLocalJoinAddress(server: ServerConnection) {
  return formatMinecraftAddress(
    server.host_ip || server.local_ip,
    server.host_proxy_port || server.public_port || server.local_port || DEFAULT_MINECRAFT_PORT
  );
}

export function getHostProxyPort(server: ServerConnection) {
  return Number(server.host_proxy_port || server.public_port || DEFAULT_MINECRAFT_PORT);
}

export function requiresClientMods(edition: string) {
  return ["fabric", "forge", "neoforge"].includes(edition.toLowerCase());
}

export function buildPlayerInviteText(server: ServerConnection) {
  const publicAddress = getPublicJoinAddress(server);
  const localAddress = getLocalJoinAddress(server);
  const address = publicAddress || "Ask the admin for the server address";
  const modLine = requiresClientMods(server.edition)
    ? `Mods: install ${server.edition} for Minecraft ${server.mc_version}, then install the exact mod list from the admin before joining.`
    : "Mods: no client mods are required unless the admin sends a mod list.";

  return [
    `${server.name} Minecraft server`,
    `Join address: ${address}`,
    `Minecraft version: ${server.mc_version}`,
    `Server type: ${server.edition}`,
    "",
    "How to join:",
    "1. Open Minecraft: Java Edition.",
    "2. Choose Multiplayer, then Add Server.",
    `3. Enter ${address} in Server Address.`,
    "4. Select Done, then Join Server.",
    "",
    modLine,
    localAddress ? `LAN fallback: ${localAddress}` : "",
  ].filter(Boolean).join("\n");
}
