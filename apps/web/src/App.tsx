import React, { useEffect, useState } from "react";

/** Server item from /api/servers */
type ServerRow = {
  name: string;
  status: string;
  public_port: number;
  memory_mb: number;
  cpu_limit: string;
  edition: string;
  mc_version: string;
};

/** Build headers with ADMIN_TOKEN from localStorage (if set). */
function authHeaders(): HeadersInit {
  const h: Record<string, string> = {};
  const t = localStorage.getItem("ADMIN_TOKEN");
  if (t) h["Authorization"] = "Bearer " + t;
  return h;
}

/** Upload helper with drag & drop and file input. */
function UploadBox({
  label,
  accept,
  onUpload
}: {
  label: string;
  accept: string;
  onUpload: (file: File) => Promise<void>;
}) {
  /** Handle drop. */
  const onDrop: React.DragEventHandler<HTMLDivElement> = async (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) await onUpload(file);
  };
  return (
    <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <small>{label}</small>
      <input
        type="file"
        accept={accept}
        onChange={async (e) => {
          const file = e.currentTarget.files?.[0];
          if (file) await onUpload(file);
        }}
      />
    </div>
  );
}

/** Top-level app component. */
export function App() {
  const [servers, setServers] = useState<ServerRow[]>([]);

  /** Refresh servers list from API. */
  async function refresh() {
    try {
      const res = await fetch("/api/servers");
      setServers(await res.json());
    } catch (err) {
      console.error("Failed to fetch servers:", err);
    }
  }

  useEffect(() => {
    refresh();
    // Auto-refresh every 10 seconds
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <h1>MC LXD Manager</h1>

      <section className="card">
        <h2>Servers</h2>
        <button onClick={refresh}>Refresh</button>

        {servers.length === 0 && (
          <p style={{ marginTop: "1rem", color: "#666" }}>
            No servers registered. Create a server using the host setup script.
          </p>
        )}

        {servers.map((s) => (
          <div key={s.name} className="card">
            <h3>
              {s.name} <small>({s.status})</small>
            </h3>
            <div>
              Edition: {s.edition} {s.mc_version} · Port: {s.public_port} · Mem: {s.memory_mb}MB
              {s.cpu_limit && ` · CPU: ${s.cpu_limit}`}
            </div>

            <div style={{ marginTop: ".5rem" }}>
              <button onClick={() => apiPOST(`/api/servers/${s.name}/start`)}>Start</button>
              <button onClick={() => apiPOST(`/api/servers/${s.name}/stop`)}>Stop</button>
              <button onClick={() => apiPOST(`/api/servers/${s.name}/restart`)}>Restart</button>
              <button onClick={() => showLogs(s.name)}>Logs</button>
              <button onClick={() => apiPOST(`/api/servers/${s.name}/backup`, true)}>
                Create Backup
              </button>
              <button onClick={() => apiPOST(`/api/servers/${s.name}/luckperms`, true)}>
                Install LuckPerms
              </button>
            </div>

            <div className="row" style={{ marginTop: ".5rem" }}>
              <div>
                <b>Plugins</b>
                <UploadBox
                  label="Drag & drop .jar or click"
                  accept=".jar"
                  onUpload={(file) => uploadFile(`/api/servers/${s.name}/plugins`, file)}
                />
              </div>
              <div>
                <b>Mods</b>
                <UploadBox
                  label="Drag & drop .jar or click"
                  accept=".jar"
                  onUpload={(file) => uploadFile(`/api/servers/${s.name}/mods`, file)}
                />
              </div>
              <div>
                <b>World (.zip)</b>
                <UploadBox
                  label="Drag & drop world.zip or click"
                  accept=".zip"
                  onUpload={(file) => uploadFile(`/api/servers/${s.name}/worlds/upload`, file)}
                />
                <div style={{ marginTop: ".25rem" }}>
                  <button onClick={() => listWorlds(s.name)}>List Worlds</button>
                  <span id={`worlds-${s.name}`}></span>
                </div>
              </div>
            </div>

            <details style={{ marginTop: ".5rem" }}>
              <summary>
                <b>server.properties</b> editor
              </summary>
              <textarea id={`sp-${s.name}`} style={{ width: "100%", height: 140 }} />
              <div style={{ marginTop: ".25rem" }}>
                <button onClick={() => loadProps(s.name)}>Load</button>
                <button onClick={() => saveProps(s.name)}>Save & Restart</button>
              </div>
            </details>

            <details style={{ marginTop: ".5rem" }}>
              <summary>
                <b>RCON</b> (send command)
              </summary>
              <input id={`rconpw-${s.name}`} type="password" placeholder="RCON password" />
              <input id={`rconcmd-${s.name}`} placeholder="say Hello world" />
              <button onClick={() => sendCmd(s.name)}>Send</button>
              <pre id={`rconout-${s.name}`} hidden></pre>
            </details>

            <details style={{ marginTop: ".5rem" }}>
              <summary>
                <b>Packwiz</b> modpack sync
              </summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  apiPOST(`/api/servers/${s.name}/packwiz`, true, { url: String(fd.get("url")) });
                }}
              >
                <input name="url" placeholder="https://.../pack.toml" style={{ width: "100%" }} />
                <button type="submit" style={{ marginTop: ".25rem" }}>
                  Sync Modpack
                </button>
              </form>
            </details>

            <pre id={`log-${s.name}`} hidden></pre>
          </div>
        ))}
      </section>
    </div>
  );
}

/** Send POST with optional form or JSON body. */
async function apiPOST(url: string, auth = false, body?: Record<string, string>) {
  const headers: HeadersInit = auth ? authHeaders() : {};
  let payload: BodyInit | undefined = undefined;

  if (body && Object.values(body).some((v) => v !== undefined)) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body as Record<string, string>);
  }
  const r = await fetch(url, { method: "POST", headers, body: payload });
  alert(await r.text());
}

async function showLogs(name: string) {
  const el = document.getElementById(`log-${name}`)!;
  el.toggleAttribute("hidden", false);
  const r = await fetch(`/api/servers/${name}/logs`);
  el.textContent = await r.text();
}

/** Upload arbitrary file to endpoint. */
async function uploadFile(url: string, file: File) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(url, { method: "POST", headers: authHeaders(), body: fd });
  alert(await r.text());
}

/** Load server.properties */
async function loadProps(name: string) {
  const r = await fetch(`/api/servers/${name}/config`);
  (document.getElementById(`sp-${name}`) as HTMLTextAreaElement).value = await r.text();
}

/** Save server.properties and restart */
async function saveProps(name: string) {
  const content = (document.getElementById(`sp-${name}`) as HTMLTextAreaElement).value;
  const body = new URLSearchParams({ content });
  const r = await fetch(`/api/servers/${name}/config`, {
    method: "POST",
    headers: authHeaders(),
    body
  });
  alert(await r.text());
}

/** List worlds and render switch buttons */
async function listWorlds(name: string) {
  const r = await fetch(`/api/servers/${name}/worlds`);
  const arr: string[] = await r.json();
  const el = document.getElementById(`worlds-${name}`)!;
  el.innerHTML = arr
    .map((w) => `<button onclick="window._switchWorld('${name}','${w}')">${w}</button>`)
    .join(" ");
}

// expose switch handler globally for simplicity
// @ts-ignore
(window as any)._switchWorld = async (name: string, w: string) => {
  await apiPOST(`/api/servers/${name}/worlds/switch`, true, { world_name: w });
};

/** Send RCON command */
async function sendCmd(name: string) {
  const pw = (document.getElementById(`rconpw-${name}`) as HTMLInputElement).value;
  const cmd = (document.getElementById(`rconcmd-${name}`) as HTMLInputElement).value;
  const out = document.getElementById(`rconout-${name}`)!;
  const r = await fetch(`/api/servers/${name}/command`, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({ rcon_password: pw, command: cmd })
  });
  out.toggleAttribute("hidden", false);
  out.textContent = await r.text();
}
