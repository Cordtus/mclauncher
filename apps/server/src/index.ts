/**
 * @file Express backend (TypeScript) for LXD-native Minecraft manager.
 * @description
 * - Creates & manages LXD containers for Minecraft servers
 * - Uses LXD proxy device for WAN exposure via host bridge (no LAN IP in container)
 * - Mods/plugins uploads, Packwiz sync, LuckPerms helper
 * - server.properties editor, world upload/switch
 * - Backups via LXD snapshot+export
 * - LAN-only by CIDR + optional bearer token
 */

import "dotenv/config";
import express, { Request, Response } from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

// -------- Constants

const APP_TITLE = "MC LXD Manager";
const DEFAULT_IMAGE = "images:ubuntu/22.04";
const DEFAULT_JAVA_PKG = "openjdk-21-jre-headless";
const DEFAULT_LISTEN_PORT = 25565;
const DEFAULT_RCON_PORT = 25575;
const WORLD_DIR = "/opt/minecraft/world";
const WORLDS_HOME = "/opt/minecraft/worlds";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8080);
const TRUST_PROXY = (process.env.TRUST_PROXY ?? "true").toLowerCase() === "true";
const ALLOW_CIDRS = (process.env.ALLOW_CIDRS ?? "192.168.0.0/16,10.0.0.0/8")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const BACKUP_DIR = process.env.BACKUP_DIR || "/var/backups/mc-lxd-manager";
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// -------- Types

/**
 * Creation request body
 */
export interface CreateServerBody {
  /** Container name (alnum + dash) */
  name: string;
  /** paper | vanilla */
  edition: "paper" | "vanilla";
  /** e.g., "1.21.1" */
  mc_version: string;
  /** Memory limit in MB */
  memory_mb: number;
  /** Optional CPU limit e.g. "2" or "50%" */
  cpu_limit?: string;
  /** Must accept EULA to start */
  eula: boolean;
  /** Host public port to listen on */
  public_port: number;
  /** Enable RCON? */
  rcon_enable: boolean;
  /** RCON port (in-container, proxied if exposed) */
  rcon_port: number;
  /** RCON password */
  rcon_password?: string;
  /** LXD storage pool name */
  storage_pool?: string;
}

// -------- Express setup

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Stage uploads in OS temp area
const upload = multer({ dest: os.tmpdir() });

// -------- Small utils (JSDoc-friendly)

/**
 * Execute a command synchronously and return stdout, throw on nonzero exit.
 * @param cmd binary e.g. "lxc"
 * @param args args
 */
function sh(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`Failed: ${cmd} ${args.join(" ")}\n${res.stderr}`);
  return res.stdout;
}

/**
 * Execute a command and return stdout/stderr/exitCode without throwing.
 */
function shSafe(cmd: string, args: string[]) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  return { stdout: res.stdout, stderr: res.stderr, code: res.status ?? -1 };
}

/**
 * Extract client IP; trust X-Forwarded-For if behind a proxy.
 */
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

/** Simple IPv4-in-CIDR check (kept tiny; IPv6 omitted for brevity) */
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
  // eslint-disable-next-line no-bitwise
  return (ipNum & mask) === (netNum & mask);
}

/**
 * Middleware for admin routes: LAN-only (CIDR) + optional bearer token.
 */
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

// -------- LXD helpers

function containerExists(name: string): boolean {
  return shSafe("lxc", ["info", name]).code === 0;
}
function ensureVolume(name: string, pool = "default") {
  const vol = `minecraft-${name}`;
  if (shSafe("lxc", ["storage", "volume", "show", pool, vol]).code !== 0) {
    sh("lxc", ["storage", "volume", "create", pool, vol]);
  }
  return vol;
}
function attachVolume(container: string, vol: string, pool = "default") {
  const dev = "mcdisk";
  shSafe("lxc", ["config", "device", "remove", container, dev]);
  sh("lxc", [
    "config",
    "device",
    "add",
    container,
    dev,
    "disk",
    `pool=${pool}`,
    `source=${vol}`,
    "path=/opt/minecraft"
  ]);
}
function addProxy(container: string, publicPort: number, connectPort: number) {
  const dev = `mc${publicPort}`;
  shSafe("lxc", ["config", "device", "remove", container, dev]);
  sh("lxc", [
    "config",
    "device",
    "add",
    container,
    dev,
    "proxy",
    `listen=tcp:0.0.0.0:${publicPort}`,
    `connect=tcp:127.0.0.1:${connectPort}`,
    "nat=true"
  ]);
}
function setLimits(container: string, memoryMb: number, cpuLimit?: string) {
  sh("lxc", ["config", "set", container, "limits.memory", `${memoryMb}MB`]);
  if (cpuLimit) sh("lxc", ["config", "set", container, "limits.cpu", cpuLimit]);
}
function tagContainer(container: string, kv: Record<string, string | number | boolean>) {
  for (const [k, v] of Object.entries(kv)) {
    sh("lxc", ["config", "set", container, `user.mc_${k}`, String(v)]);
  }
}
function containerExec(container: string, cmd: string) {
  return shSafe("lxc", ["exec", container, "--", "bash", "-lc", cmd]);
}

/** Render systemd unit for minecraft */
function renderService(javaBin = "/usr/bin/java") {
  return `
[Unit]
Description=Minecraft Server
After=network.target

[Service]
User=mc
WorkingDirectory=/opt/minecraft
Environment=JVM_OPTS=-Xms512M -Xmx$(/usr/bin/jq -r .maxRamMb /opt/minecraft/.mc_config.json)M
ExecStart=${javaBin} $JVM_OPTS -jar server.jar nogui
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`.trim();
}

/** Provisioning script inside the container */
function renderSetupScript(cfg: CreateServerBody) {
  const paperCmd =
    `curl -sL https://api.papermc.io/v2/projects/paper/versions/${cfg.mc_version} | jq -r '.builds[-1]' | ` +
    `xargs -I{b} curl -sL -o server.jar https://api.papermc.io/v2/projects/paper/versions/${cfg.mc_version}/builds/{b}/downloads/paper-${cfg.mc_version}-{b}.jar`;
  const vanillaCmd =
    `curl -s https://piston-meta.mojang.com/mc/game/version_manifest_v2.json | jq -r '.versions[] | select(.id=="${cfg.mc_version}").url' | ` +
    `xargs -I{u} curl -sL {u} | jq -r .downloads.server.url | xargs -I{s} curl -sL -o server.jar {s}`;
  const editionCmd = cfg.edition === "vanilla" ? vanillaCmd : paperCmd;

  const rconCfg = cfg.rcon_enable
    ? `\n    echo 'enable-rcon=true' >> server.properties && echo 'rcon.port=${cfg.rcon_port}' >> server.properties && echo 'rcon.password=${cfg.rcon_password || "changeme"}' >> server.properties`
    : "";

  return `
set -euxo pipefail
apt-get update
apt-get install -y ${DEFAULT_JAVA_PKG} jq curl tmux unzip mcrcon || true
id -u mc >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin mc
install -d -o mc -g mc /opt/minecraft
cd /opt/minecraft
cat > .mc_config.json <<EOF
{"maxRamMb": ${cfg.memory_mb}}
EOF
${editionCmd}
cat > eula.txt <<EOF
# Generated by ${APP_TITLE}
eula=${cfg.eula ? "true" : "false"}
EOF
cat > server.properties <<EOF
server-port=25565
motd=Managed by ${APP_TITLE}\\nVersion ${cfg.mc_version}
max-players=20
difficulty=normal
online-mode=true
spawn-protection=0
EOF
${rconCfg}
# packwiz optional
if ! command -v packwiz >/dev/null 2>&1; then
  curl -sL https://github.com/packwiz/packwiz/releases/latest/download/packwiz-linux-amd64 -o /usr/local/bin/packwiz
  chmod +x /usr/local/bin/packwiz || true
fi
install -d -o mc -g mc /opt/minecraft/plugins /opt/minecraft/mods
cat > /etc/systemd/system/minecraft.service <<SVC
${renderService()}
SVC
systemctl daemon-reload
chown -R mc:mc /opt/minecraft
systemctl enable --now minecraft.service
`.trim();
}

// -------- UI: serve built frontend (Vite output goes to apps/web/dist)
app.use(express.static(path.resolve(process.cwd(), "apps/web/dist")));

// -------- API: list servers
app.get("/api/servers", (req, res) => {
  const out = sh("lxc", ["list", "--format", "json"]);
  const arr = JSON.parse(out) as Array<any>;
  const result = arr
    .filter((c) => c?.config?.["user.mc_name"])
    .map((c) => ({
      name: c.name,
      status: c.status,
      public_port: Number(c.config["user.mc_public_port"] ?? DEFAULT_LISTEN_PORT),
      memory_mb: Number(c.config["user.mc_memory_mb"] ?? 2048),
      cpu_limit: c.config["user.mc_cpu_limit"] || ""
    }));
  res.json(result);
});

// -------- API: create
app.post("/api/servers", requireAdmin, (req: Request, res: Response) => {
  const cfg = req.body as CreateServerBody;
  if (!/^[a-zA-Z0-9-]+$/.test(cfg.name)) return res.status(400).send("Name must be alphanumeric/dash");
  if (containerExists(cfg.name)) return res.status(400).send("Container already exists");

  sh("lxc", ["launch", DEFAULT_IMAGE, cfg.name]);

  const pool = cfg.storage_pool || "default";
  const vol = ensureVolume(cfg.name, pool);
  attachVolume(cfg.name, vol, pool);

  setLimits(cfg.name, Number(cfg.memory_mb || 2048), cfg.cpu_limit);
  tagContainer(cfg.name, {
    name: cfg.name,
    public_port: cfg.public_port,
    memory_mb: cfg.memory_mb,
    cpu_limit: cfg.cpu_limit || "",
    edition: cfg.edition,
    mc_version: cfg.mc_version,
    manager: true
  });

  addProxy(cfg.name, Number(cfg.public_port || DEFAULT_LISTEN_PORT), DEFAULT_LISTEN_PORT);

  // push and run setup script
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mclxd-"));
  const scriptPath = path.join(tmpDir, "setup.sh");
  fs.writeFileSync(scriptPath, renderSetupScript(cfg));
  try {
    sh("lxc", ["file", "push", scriptPath, `${cfg.name}/root/setup.sh`]);
    const ex = containerExec(
      cfg.name,
      "chmod +x /root/setup.sh && /root/setup.sh || (journalctl -u minecraft.service --no-pager -n 200; exit 1)"
    );
    const log = (ex.stdout + "\n" + ex.stderr).slice(-8000);
    res.json({ ok: true, log });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// -------- API: lifecycle
app.post("/api/servers/:name/start", requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  shSafe("lxc", ["start", name]);
  containerExec(name, "systemctl start minecraft.service");
  res.json({ ok: true });
});

app.post("/api/servers/:name/stop", requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  containerExec(name, "systemctl stop minecraft.service || true");
  shSafe("lxc", ["stop", name]);
  res.json({ ok: true });
});

app.post("/api/servers/:name/restart", requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  containerExec(name, "systemctl restart minecraft.service");
  res.json({ ok: true });
});

app.get("/api/servers/:name/logs", (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  const ex = containerExec(
    name,
    "journalctl -u minecraft.service --no-pager -n 200 || cat /opt/minecraft/logs/latest.log | tail -n 200"
  );
  res.type("text/plain").send(ex.stdout || ex.stderr);
});

app.delete("/api/servers/:name", requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  containerExec(name, "systemctl stop minecraft.service || true");
  shSafe("lxc", ["stop", name]);
  sh("lxc", ["delete", name]);
  res.json({ ok: true });
});

// -------- API: uploads (plugins/mods)
app.post("/api/servers/:name/plugins", requireAdmin, upload.single("file"), (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  const f = req.file;
  if (!f) return res.status(400).send("Missing file");
  if (!f.originalname.endsWith(".jar")) return res.status(400).send("Expect .jar");
  try {
    sh("lxc", ["file", "push", f.path, `${name}/opt/minecraft/plugins/${f.originalname}`]);
    containerExec(name, "chown mc:mc /opt/minecraft/plugins/* || true");
    res.type("text/plain").send("Plugin uploaded. Restart server to apply.");
  } finally {
    fs.rmSync(f.path, { force: true });
  }
});

app.post("/api/servers/:name/mods", requireAdmin, upload.single("file"), (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  const f = req.file;
  if (!f) return res.status(400).send("Missing file");
  if (!f.originalname.endsWith(".jar")) return res.status(400).send("Expect .jar");
  try {
    sh("lxc", ["file", "push", f.path, `${name}/opt/minecraft/mods/${f.originalname}`]);
    containerExec(name, "chown mc:mc /opt/minecraft/mods/* || true");
    res.type("text/plain").send("Mod uploaded. Ensure correct loader.");
  } finally {
    fs.rmSync(f.path, { force: true });
  }
});

// -------- API: Packwiz
app.post("/api/servers/:name/packwiz", requireAdmin, (req, res) => {
  const { name } = req.params;
  const { url } = req.body || {};
  if (!url) return res.status(400).send("Missing url");
  if (!containerExists(name)) return res.sendStatus(404);
  const ex = containerExec(
    name,
    `cd /opt/minecraft && curl -sL ${JSON.stringify(
      url
    )} -o pack.toml && packwiz refresh || packwiz modrinth install || true && chown -R mc:mc /opt/minecraft`
  );
  res.type("text/plain").send((ex.stdout + "\n" + ex.stderr).slice(-4000));
});

// -------- API: LuckPerms
app.post("/api/servers/:name/luckperms", requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  containerExec(
    name,
    "cd /opt/minecraft/plugins && curl -sL https://download.luckperms.net/latest/bukkit.jar -o LuckPerms.jar && chown mc:mc LuckPerms.jar"
  );
  res.type("text/plain").send("LuckPerms installed. Restart recommended.");
});

// -------- API: proxies & backups
app.post("/api/servers/:name/proxies", requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  const public_port = Number(req.body?.public_port);
  const connect_port = Number(req.body?.connect_port);
  if (!public_port || !connect_port) return res.status(400).send("Missing ports");
  addProxy(name, public_port, connect_port);
  res.type("text/plain").send(`Proxy added ${public_port} → ${connect_port}.`);
});

app.post("/api/servers/:name/backup", requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  const pool = "default";
  const vol = `minecraft-${name}`;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  sh("lxc", ["storage", "volume", "snapshot", pool, vol, `snap${stamp}`]);
  const outPath = path.join(BACKUP_DIR, `${vol}-snap${stamp}.tar.gz`);
  sh("lxc", ["storage", "volume", "export", pool, `${vol}@snap${stamp}`, outPath]);
  res.type("text/plain").send(`Snapshot created and exported to ${outPath}`);
});

// -------- API: config + worlds + RCON
app.get("/api/servers/:name/config", (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  const ex = containerExec(name, "cat /opt/minecraft/server.properties || true");
  res.type("text/plain").send(ex.stdout);
});

app.post("/api/servers/:name/config", requireAdmin, (req, res) => {
  const { name } = req.params;
  const { content } = req.body || {};
  if (typeof content !== "string") return res.status(400).send("Missing content");
  if (!containerExists(name)) return res.sendStatus(404);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mclxd-"));
  const p = path.join(tmpDir, "server.properties");
  fs.writeFileSync(p, content);
  try {
    sh("lxc", ["file", "push", p, `${name}/opt/minecraft/server.properties`]);
    containerExec(name, "chown mc:mc /opt/minecraft/server.properties");
    containerExec(name, "systemctl restart minecraft.service");
    res.type("text/plain").send("server.properties saved and server restarted.");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

app.get("/api/servers/:name/worlds", (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  // ensure layout
  containerExec(
    name,
    `bash -lc 'set -e; mkdir -p ${WORLDS_HOME}; if [ -d ${WORLD_DIR} ] && [ ! -L ${WORLD_DIR} ]; then name=default; [ -d ${WORLDS_HOME}/$name ] || mkdir -p ${WORLDS_HOME}/$name; rsync -a --delete ${WORLD_DIR}/ ${WORLDS_HOME}/$name/; rm -rf ${WORLD_DIR}; ln -s ${WORLDS_HOME}/$name ${WORLD_DIR}; fi'`
  );
  const ex = containerExec(
    name,
    `bash -lc 'shopt -s nullglob; for d in ${WORLDS_HOME}/*; do [ -f "$d/level.dat" ] && basename "$d"; done'`
  );
  const arr = ex.stdout.split("\n").filter(Boolean);
  res.json(arr);
});

app.post("/api/servers/:name/worlds/upload", requireAdmin, upload.single("file"), (req, res) => {
  const { name } = req.params;
  if (!containerExists(name)) return res.sendStatus(404);
  const f = req.file;
  if (!f) return res.status(400).send("Missing file");
  if (!f.originalname.endsWith(".zip")) return res.status(400).send("Expect .zip world");
  const base = path.parse(f.originalname).name;
  try {
    containerExec(
      name,
      `bash -lc 'set -e; mkdir -p ${WORLDS_HOME}; if [ -d ${WORLD_DIR} ] && [ ! -L ${WORLD_DIR} ]; then name=default; [ -d ${WORLDS_HOME}/$name ] || mkdir -p ${WORLDS_HOME}/$name; rsync -a --delete ${WORLD_DIR}/ ${WORLDS_HOME}/$name/; rm -rf ${WORLD_DIR}; ln -s ${WORLDS_HOME}/$name ${WORLD_DIR}; fi'`
    );
    containerExec(name, "systemctl stop minecraft.service || true");
    sh("lxc", ["file", "push", f.path, `${name}/root/world.zip`]);
    containerExec(
      name,
      `bash -lc 'set -e; mkdir -p ${WORLDS_HOME}/${base}; rm -rf ${WORLDS_HOME}/${base}/*; unzip -oq /root/world.zip -d ${WORLDS_HOME}/${base}; rm -f ${WORLD_DIR}; ln -s ${WORLDS_HOME}/${base} ${WORLD_DIR}; chown -R mc:mc ${WORLDS_HOME}/${base}'`
    );
    containerExec(name, "systemctl start minecraft.service");
    res.type("text/plain").send(`World '${base}' uploaded and activated.`);
  } finally {
    fs.rmSync(f.path, { force: true });
  }
});

app.post("/api/servers/:name/worlds/switch", requireAdmin, (req, res) => {
  const { name } = req.params;
  const world_name = req.body?.world_name as string;
  if (!world_name) return res.status(400).send("Missing world_name");
  if (!containerExists(name)) return res.sendStatus(404);
  const ex = containerExec(name, `bash -lc 'test -d ${WORLDS_HOME}/${world_name} && echo ok || echo no'`);
  if (!ex.stdout.includes("ok")) return res.status(400).send(`World '${world_name}' not found`);
  containerExec(
    name,
    `bash -lc 'systemctl stop minecraft.service || true; rm -f ${WORLD_DIR}; ln -s ${WORLDS_HOME}/${world_name} ${WORLD_DIR}; systemctl start minecraft.service'`
  );
  res.type("text/plain").send(`Switched to world '${world_name}'.`);
});

app.post("/api/servers/:name/command", requireAdmin, (req, res) => {
  const { name } = req.params;
  const { rcon_password, command } = req.body || {};
  if (!containerExists(name)) return res.sendStatus(404);
  if (!rcon_password || !command) return res.status(400).send("Missing rcon_password or command");
  const ex = containerExec(
    name,
    `mcrcon -P ${DEFAULT_RCON_PORT} -p ${JSON.stringify(rcon_password)} ${JSON.stringify(command)} || true`
  );
  res.type("text/plain").send((ex.stdout + "\n" + ex.stderr).slice(-4000));
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, HOST, () => {
  console.log(`${APP_TITLE} listening on http://${HOST}:${PORT}`);
});
