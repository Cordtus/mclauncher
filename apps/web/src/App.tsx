import { useEffect, useState } from "react";
import {
  Play,
  Square,
  RotateCw,
  Upload,
  Settings,
  Globe,
  RefreshCw,
  Package,
  Copy,
  Users,
  HelpCircle,
  Info,
  ChevronDown,
  ChevronUp,
  Terminal,
  Package2,
} from "lucide-react";
import { ModBrowser } from "@/components/ModBrowser";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type ServerRow = {
  name: string;
  status: string;
  local_ip: string;
  local_port: number;
  host_ip?: string; // LXD host IP for local network connections
  public_port: number;
  public_domain: string | null;
  memory_mb: number;
  cpu_limit: string;
  edition: string;
  mc_version: string;
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

function authHeaders(): HeadersInit {
  const h: Record<string, string> = {};
  const t = localStorage.getItem("ADMIN_TOKEN");
  if (t) h["Authorization"] = "Bearer " + t;
  return h;
}

function copyToClipboard(text: string) {
  // Use Clipboard API if available (HTTPS), otherwise use fallback (HTTP)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(err => console.error('Clipboard API failed:', err));
  } else {
    // Fallback for HTTP or older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.error('Copy fallback failed:', err);
    }
    document.body.removeChild(textarea);
  }
}

export function App() {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [logs, setLogs] = useState<string>("");
  const [showLogs, setShowLogs] = useState(true);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");

  // Version management state
  const [versionType, setVersionType] = useState<"paper" | "vanilla">("paper");
  const [newVersion, setNewVersion] = useState("");
  const [isChangingVersion, setIsChangingVersion] = useState(false);

  // Server configuration state (persisted in localStorage)
  const [serverSettings, setServerSettings] = useState(() => {
    const saved = localStorage.getItem('mc-server-settings');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error('Failed to parse saved settings', e);
      }
    }
    return {
      // Network
      hostIp: "",
      publicDomain: "",

      // Server Properties
      motd: "A Minecraft Server",
      maxPlayers: 20,
      gamemode: "survival",
      difficulty: "normal",
      pvp: true,
      spawnProtection: 16,
      viewDistance: 10,
      onlineMode: true,
      allowFlight: false,

      // Security
      serverPassword: "",
      enforceWhitelist: false,
      whitelist: [] as string[],
      newWhitelistPlayer: "",

      // Plugins to install
      plugins: {
        luckperms: false,
        essentialsx: false,
        vault: false,
        worldedit: false,
      },

      // Operators
      operators: [] as string[],
      newOperator: "",
    };
  });


  // Save settings to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('mc-server-settings', JSON.stringify(serverSettings));
  }, [serverSettings]);

  // Load network settings from server registry when servers are loaded
  useEffect(() => {
    if (servers.length > 0) {
      setServerSettings(prev => ({
        ...prev,
        hostIp: servers[0].host_ip || "",
        publicDomain: servers[0].public_domain || ""
      }));
    }
  }, [servers]);

  // Save network settings to backend when they change
  async function saveNetworkConfig(serverName: string, field: string, value: string) {
    try {
      const response = await fetch(`/api/servers/${serverName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value || null })
      });
      if (response.ok) {
        await refresh(); // Refresh to get updated server data
      }
    } catch (err) {
      console.error(`Failed to save ${field}:`, err);
    }
  }

  async function refresh() {
    setIsRefreshing(true);
    try {
      const res = await fetch("/api/servers");
      const serverData = await res.json();
      setServers(serverData);
    } catch (err) {
      setMessage("Failed to fetch servers");
    } finally {
      setIsRefreshing(false);
    }
  }

  // Fetch logs for the first server
  async function fetchLogs() {
    if (servers.length === 0) return;

    setIsLoadingLogs(true);
    try {
      const response = await fetch(`/api/servers/${servers[0].name}/logs`);
      const logText = await response.text();

      // Get last 10 lines
      const lines = logText.trim().split('\n');
      const lastLines = lines.slice(-10).join('\n');
      setLogs(lastLines);
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    } finally {
      setIsLoadingLogs(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, []);

  // Auto-refresh logs every 5 seconds
  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [servers]);

  const handleServerAction = async (serverName: string, action: string) => {
    try {
      const res = await fetch(`/api/servers/${serverName}/${action}`, {
        method: "POST",
        headers: authHeaders(),
      });
      const msg = await res.text();
      setMessage(msg);
      setTimeout(() => refresh(), 2000);
    } catch (err) {
      setMessage(`Failed to ${action} server`);
    }
  };

  const handleFileUpload = async (
    serverName: string,
    type: string,
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await fetch(`/api/servers/${serverName}/${type}`, {
        method: "POST",
        headers: authHeaders(),
        body: fd,
      });
      const msg = await res.text();
      setMessage(msg);
    } catch (err) {
      setMessage(`Failed to upload ${file.name}`);
    }
  };

  const handleVersionChange = async (serverName: string) => {
    if (!newVersion) {
      setMessage("Please enter a version");
      return;
    }

    setIsChangingVersion(true);
    try {
      const res = await fetch(`/api/servers/${serverName}/version/change`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          type: versionType,
          version: newVersion,
        }),
      });
      const data = await res.json();
      setMessage(data.message || "Version changed successfully");
      setNewVersion("");
      setTimeout(() => refresh(), 3000);
    } catch (err) {
      setMessage("Failed to change version");
    } finally {
      setIsChangingVersion(false);
    }
  };

  const getStatusColor = (status: string) => {
    const statusLower = status.toLowerCase();
    if (statusLower.includes("running")) return "default";
    if (statusLower.includes("stopped")) return "secondary";
    return "destructive";
  };

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <img src="/mc-logo.svg" alt="Minecraft Server" className="h-10" />
            <div>
              <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-green-400 to-emerald-600 bg-clip-text text-transparent">
                Minecraft Server Control
              </h1>
              <p className="text-muted-foreground mt-1">
                Build, play, and manage your worlds
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="rounded-sm hover:bg-green-500/10 hover:border-green-500 transition-all">
                  <HelpCircle className="mr-2 h-4 w-4" />
                  Getting Started
                </Button>
              </DialogTrigger>
              <DialogContent className="rounded-sm max-w-3xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>User Documentation</DialogTitle>
                  <DialogDescription>
                    Complete guide to managing your Minecraft server
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-6 text-sm">

                  <section>
                    <h2 className="text-lg font-bold mb-3 border-b pb-2">Quick Start</h2>
                    <div className="space-y-3">
                      <div>
                        <h3 className="font-semibold mb-1">Starting Your Server</h3>
                        <p className="text-muted-foreground">Click the Play button (▶) to start the server. Initial startup takes 30-60 seconds. The status badge will change to "Running" and show green "ONLINE" when ready.</p>
                      </div>
                      <div>
                        <h3 className="font-semibold mb-1">Connecting to Your Server</h3>
                        <p className="text-muted-foreground mb-2">In Minecraft, select Multiplayer → Add Server:</p>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li><strong>Local Network:</strong> Use the IP:PORT shown in the "Local Network" card (players on same WiFi)</li>
                          <li><strong>Public Internet:</strong> Use the public domain:PORT once configured in Network settings</li>
                          <li><strong>Important:</strong> The server uses a non-standard port (not 25565) for security</li>
                          <li>Use the copy button to quickly copy the full address including port</li>
                        </ul>
                      </div>
                    </div>
                  </section>

                  <section>
                    <h2 className="text-lg font-bold mb-3 border-b pb-2">Server Controls</h2>
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div><strong>Play (▶):</strong> Start the server</div>
                        <div><strong>Stop (■):</strong> Gracefully stop the server</div>
                        <div><strong>Restart (↻):</strong> Stop and start the server</div>
                        <div><strong>Refresh (⟳):</strong> Update server status</div>
                      </div>
                    </div>
                  </section>

                  <section>
                    <h2 className="text-lg font-bold mb-3 border-b pb-2">Server Settings</h2>
                    <p className="text-muted-foreground mb-3">Click "Server Settings" to configure your server before launch. Settings are saved automatically.</p>

                    <div className="space-y-3">
                      <div>
                        <h3 className="font-semibold mb-1">Network Tab</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li><strong>Host IP:</strong> Set to your LXD host's local IP (e.g., 192.168.0.170) for local network access</li>
                          <li><strong>Public Domain:</strong> Set your public domain name for internet access (optional)</li>
                        </ul>
                      </div>

                      <div>
                        <h3 className="font-semibold mb-1">Properties Tab</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li><strong>MOTD:</strong> Message shown in server list</li>
                          <li><strong>Max Players:</strong> Maximum concurrent players allowed</li>
                          <li><strong>View Distance:</strong> How far players can see (lower = better performance)</li>
                          <li><strong>Online Mode:</strong> Requires Minecraft account authentication (recommended)</li>
                        </ul>
                      </div>

                      <div>
                        <h3 className="font-semibold mb-1">Gameplay Tab</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li><strong>Game Mode:</strong> Survival, Creative, Adventure, or Spectator</li>
                          <li><strong>Difficulty:</strong> Peaceful, Easy, Normal, or Hard</li>
                          <li><strong>PVP:</strong> Enable/disable player vs player combat</li>
                          <li><strong>Allow Flight:</strong> Allow flying in survival mode</li>
                          <li><strong>Spawn Protection:</strong> Blocks around spawn that only ops can modify</li>
                        </ul>
                      </div>

                      <div>
                        <h3 className="font-semibold mb-1">Security Tab</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li><strong>Server Password:</strong> Optional password players must enter to join</li>
                          <li><strong>Whitelist:</strong> Only allow approved players (recommended for private servers)</li>
                          <li>Add players by username, remove them with the X button</li>
                        </ul>
                      </div>

                      <div>
                        <h3 className="font-semibold mb-1">Plugins Tab</h3>
                        <p className="text-muted-foreground text-xs">Select popular plugins to install. Server must be restarted after installation.</p>
                      </div>

                      <div>
                        <h3 className="font-semibold mb-1">Admins Tab</h3>
                        <p className="text-muted-foreground text-xs">Add server operators (admins) who can use all commands. Only give OP to trusted players.</p>
                      </div>
                    </div>
                  </section>

                  <section>
                    <h2 className="text-lg font-bold mb-3 border-b pb-2">Upload Content</h2>

                    <div className="space-y-3">
                      <div>
                        <h3 className="font-semibold mb-1">Plugins (Paper/Purpur/Spigot only)</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li>Download .jar files from SpigotMC, Bukkit, or Modrinth</li>
                          <li>Click "Upload Plugin" and select the .jar file</li>
                          <li>Restart server to load the plugin</li>
                          <li>Popular plugins: EssentialsX, WorldEdit, LuckPerms, Vault</li>
                        </ul>
                      </div>

                      <div>
                        <h3 className="font-semibold mb-1">Mods (Forge/NeoForge/Fabric only)</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li>Download .jar files from CurseForge or Modrinth</li>
                          <li>Click "Upload Mod" and select the .jar file</li>
                          <li>Players MUST have the same mods installed to join</li>
                          <li>Restart server after adding mods</li>
                        </ul>
                      </div>

                      <div>
                        <h3 className="font-semibold mb-1">Worlds</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li>Compress your world folder into a .zip file</li>
                          <li>The .zip must contain level.dat, region/, data/ folders</li>
                          <li>Click "Upload World" and select the .zip file</li>
                          <li>Server will stop, replace the world, and restart automatically</li>
                        </ul>
                      </div>
                    </div>
                  </section>

                  <section>
                    <h2 className="text-lg font-bold mb-3 border-b pb-2">Console Panel</h2>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                      <li>Shows the last 10 lines of server logs in real-time</li>
                      <li>Auto-refreshes every 5 seconds</li>
                      <li>Click the chevron to collapse/expand</li>
                      <li>Use for debugging connection issues or plugin errors</li>
                      <li>Click "Refresh Now" for immediate update</li>
                    </ul>
                  </section>

                  <section>
                    <h2 className="text-lg font-bold mb-3 border-b pb-2">Connection Status</h2>
                    <div className="space-y-2">
                      <div>
                        <h3 className="font-semibold mb-1">Status Badges</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li><strong className="text-green-500">✓ ONLINE:</strong> Server is accessible</li>
                          <li><strong className="text-red-500">✗ OFFLINE:</strong> Server is not reachable</li>
                          <li><strong>⟳ CHECKING:</strong> Verifying connection status</li>
                        </ul>
                      </div>
                      <div>
                        <h3 className="font-semibold mb-1">Local Network</h3>
                        <p className="text-muted-foreground text-xs">Shows status for players on the same WiFi network. Set Host IP in Network settings first.</p>
                      </div>
                      <div>
                        <h3 className="font-semibold mb-1">Public Internet</h3>
                        <p className="text-muted-foreground text-xs">Shows status for players connecting from the internet. Requires public domain and port forwarding.</p>
                      </div>
                    </div>
                  </section>

                  <section>
                    <h2 className="text-lg font-bold mb-3 border-b pb-2">Troubleshooting</h2>
                    <div className="space-y-2">
                      <div>
                        <h3 className="font-semibold mb-1">Server won't start</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li>Check the Console panel for error messages</li>
                          <li>Click "View Logs" for full server logs</li>
                          <li>Ensure enough memory is allocated (8GB recommended)</li>
                        </ul>
                      </div>
                      <div>
                        <h3 className="font-semibold mb-1">Can't connect locally</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li>Set Host IP in Server Settings → Network tab</li>
                          <li>Verify server status shows "Running"</li>
                          <li>Check Local Network shows "ONLINE"</li>
                          <li>Make sure you're on the same WiFi network</li>
                        </ul>
                      </div>
                      <div>
                        <h3 className="font-semibold mb-1">Can't connect from internet</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li>Configure port forwarding on your router (port 25565)</li>
                          <li>Set up DNS A record pointing to your public IP</li>
                          <li>Add public domain in Server Settings → Network tab</li>
                          <li>Wait for DNS propagation (can take up to 24 hours)</li>
                        </ul>
                      </div>
                      <div>
                        <h3 className="font-semibold mb-1">Plugin/Mod not working</h3>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2 text-xs">
                          <li>Ensure plugin is compatible with your server version</li>
                          <li>Restart server after uploading</li>
                          <li>Check Console panel for plugin errors</li>
                          <li>For mods: players must have the exact same mods installed</li>
                        </ul>
                      </div>
                    </div>
                  </section>

                  <section className="bg-muted/50 p-3 rounded-lg">
                    <h2 className="text-sm font-bold mb-2">Important Notes</h2>
                    <ul className="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                      <li>Always back up your world before major changes</li>
                      <li>Settings are saved automatically when you change them</li>
                      <li>Keep Online Mode ON to prevent unauthorized access</li>
                      <li>Only give operator status to people you completely trust</li>
                      <li>Monitor the Console panel for errors and warnings</li>
                    </ul>
                  </section>

                </div>
              </DialogContent>
            </Dialog>
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm"
              onClick={refresh}
              disabled={isRefreshing}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>
        </div>

        <Separator />

        {/* Message Banner */}
        {message && (
          <Card className="rounded-sm border-l-4 border-l-primary">
            <CardContent className="py-3">
              <p className="text-sm">{message}</p>
            </CardContent>
          </Card>
        )}

        {/* Console Log Panel */}
        {servers.length > 0 && (
          <Card className="rounded-sm border-amber-500/20">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-amber-500" />
                  <CardTitle className="text-base">Server Console</CardTitle>
                  {isLoadingLogs && (
                    <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowLogs(!showLogs)}
                  className="h-6 w-6 p-0"
                >
                  {showLogs ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </CardHeader>
            {showLogs && (
              <CardContent className="pt-0">
                <div className="bg-black/90 rounded p-3 font-mono text-xs text-green-400 h-32 overflow-y-auto border border-green-500/20">
                  {logs ? (
                    <pre className="whitespace-pre-wrap">{logs}</pre>
                  ) : (
                    <span className="text-muted-foreground italic">No logs available...</span>
                  )}
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                  <span>Auto-refreshes every 5 seconds • Last 10 lines</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => fetchLogs()}
                    className="h-6 text-xs"
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Refresh Now
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>
        )}

        {/* Server List */}
        {servers.length === 0 ? (
          <Card className="rounded-sm">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">
                No servers registered. Run the setup script on your host to create servers.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-6">
            {servers.map((server) => (
              <Card key={server.name} className="rounded-sm">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        {server.name}
                        <Badge
                          variant={getStatusColor(server.status)}
                          className="rounded-sm"
                        >
                          {server.status}
                        </Badge>
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {server.edition} {server.mc_version} · {server.memory_mb}MB RAM · {server.cpu_limit} CPU
                      </CardDescription>

                      {/* Connection Info */}
                      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Local Connection */}
                        <div className="border-2 rounded-lg p-4 bg-card">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <Globe className="h-5 w-5 text-muted-foreground" />
                              <span className="text-base font-bold">Local Network</span>
                            </div>
                            {server.minecraft?.online ? (
                              <Badge className="bg-green-500 hover:bg-green-600 text-sm font-bold px-3 py-1">✓ RUNNING</Badge>
                            ) : (
                              <Badge variant="destructive" className="text-sm font-bold px-3 py-1">✗ STOPPED</Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mb-2">
                            <code className="bg-black/80 text-green-400 px-4 py-3 rounded text-lg font-bold flex-1 text-center border-2 border-green-500/30">
                              {server.host_ip || server.local_ip}:{server.public_port}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-10 w-10"
                              onClick={() => copyToClipboard(`${server.host_ip || server.local_ip}:${server.public_port}`)}
                              title="Copy to clipboard"
                            >
                              <Copy className="h-5 w-5" />
                            </Button>
                          </div>
                          <p className="text-sm font-semibold text-center">
                            {server.host_ip
                              ? "For players on the same WiFi"
                              : "⚠️ Set Host IP in Network settings"}
                          </p>
                        </div>

                        {/* Public Connection */}
                        <div className="border-2 rounded-lg p-4 bg-card">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <Globe className="h-5 w-5 text-muted-foreground" />
                              <span className="text-base font-bold">Public Internet</span>
                            </div>
                            {server.public_domain ? (
                              server.minecraft?.online ? (
                                <Badge className="bg-green-500 hover:bg-green-600 text-sm font-bold px-3 py-1">✓ RUNNING</Badge>
                              ) : (
                                <Badge variant="destructive" className="text-sm font-bold px-3 py-1">✗ STOPPED</Badge>
                              )
                            ) : (
                              <Badge variant="outline" className="text-sm font-bold px-3 py-1">Not configured</Badge>
                            )}
                          </div>
                          {server.public_domain ? (
                            <>
                              <div className="flex items-center gap-2 mb-2">
                                <code className="bg-black/80 text-cyan-400 px-4 py-3 rounded text-lg font-bold flex-1 text-center border-2 border-cyan-500/30">
                                  {server.public_domain}:{server.public_port}
                                </code>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-10 w-10"
                                  onClick={() => copyToClipboard(`${server.public_domain}:${server.public_port}`)}
                                  title="Copy to clipboard"
                                >
                                  <Copy className="h-5 w-5" />
                                </Button>
                              </div>
                              <p className="text-sm font-semibold text-center">For friends anywhere (requires port forwarding)</p>
                            </>
                          ) : (
                            <>
                              <div className="flex items-center gap-2 mb-2">
                                <code className="bg-muted px-4 py-3 rounded text-base font-semibold flex-1 text-center opacity-50">
                                  Not configured
                                </code>
                              </div>
                              <p className="text-sm font-semibold text-center">Configure in Network settings</p>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Player Info */}
                      {server.minecraft?.online && server.minecraft.players && (
                        <div className="mt-3 flex items-center gap-3 text-base">
                          <Users className="h-5 w-5 text-muted-foreground" />
                          <span className="font-semibold text-muted-foreground">Players:</span>
                          <Badge variant="secondary" className="rounded-sm text-sm font-bold px-3 py-1">
                            {server.minecraft.players.online}/{server.minecraft.players.max}
                          </Badge>
                          {server.minecraft.description && (
                            <span className="text-sm text-muted-foreground ml-2 font-medium">
                              · {server.minecraft.description}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-sm h-9 w-9"
                        onClick={() => handleServerAction(server.name, "start")}
                        title="Start"
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-sm h-9 w-9"
                        onClick={() => handleServerAction(server.name, "stop")}
                        title="Stop"
                      >
                        <Square className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-sm h-9 w-9"
                        onClick={() => handleServerAction(server.name, "restart")}
                        title="Restart"
                      >
                        <RotateCw className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {/* Version Management */}
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          variant="outline"
                          className="rounded-sm w-full hover:bg-blue-500/10 hover:border-blue-500 transition-all"
                          onClick={() => setSelectedServer(server.name)}
                        >
                          <Settings className="mr-2 h-4 w-4" />
                          ⚙️ Change Version
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="rounded-sm">
                        <DialogHeader>
                          <DialogTitle>Change Server Version</DialogTitle>
                          <DialogDescription>
                            Update {server.name} to a different Minecraft version
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4">
                          <div className="flex gap-2">
                            <Button
                              variant={versionType === "paper" ? "default" : "outline"}
                              className="rounded-sm flex-1"
                              onClick={() => setVersionType("paper")}
                            >
                              Paper
                            </Button>
                            <Button
                              variant={versionType === "vanilla" ? "default" : "outline"}
                              className="rounded-sm flex-1"
                              onClick={() => setVersionType("vanilla")}
                            >
                              Vanilla
                            </Button>
                          </div>
                          <Input
                            placeholder="e.g., 1.21.3"
                            value={newVersion}
                            onChange={(e) => setNewVersion(e.target.value)}
                            className="rounded-sm"
                          />
                        </div>
                        <DialogFooter>
                          <Button
                            className="rounded-sm"
                            onClick={() => handleVersionChange(server.name)}
                            disabled={isChangingVersion}
                          >
                            {isChangingVersion ? "Changing..." : "Change Version"}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>

                    {/* Upload Plugin - Only for Paper/Purpur/Spigot */}
                    {['paper', 'purpur', 'spigot'].includes(server.edition.toLowerCase()) && (
                      <Tooltip>
                        <div>
                          <input
                            type="file"
                            accept=".jar"
                            id={`plugin-${server.name}`}
                            className="hidden"
                            onChange={(e) =>
                              handleFileUpload(server.name, "plugins", e)
                            }
                          />
                          <label htmlFor={`plugin-${server.name}`}>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                className="rounded-sm w-full hover:bg-purple-500/10 hover:border-purple-500 transition-all"
                                asChild
                              >
                                <span>
                                  <Package className="mr-2 h-4 w-4" />
                                  🔌 Upload Plugin
                                </span>
                              </Button>
                            </TooltipTrigger>
                          </label>
                        </div>
                        <TooltipContent className="max-w-xs">
                          <p className="font-semibold mb-1">Upload Plugin (.jar)</p>
                          <p className="text-xs">Download from SpigotMC, Bukkit, or Modrinth. Restart server after upload.</p>
                        </TooltipContent>
                      </Tooltip>
                    )}

                    {/* Mod Management - Only for Forge/NeoForge/Fabric */}
                    {['forge', 'neoforge', 'fabric'].includes(server.edition.toLowerCase()) && (
                      <>
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              variant="outline"
                              className="rounded-sm hover:bg-purple-500/10 hover:border-purple-500 transition-all"
                            >
                              <Package2 className="mr-2 h-4 w-4" />
                              Browse Mods
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="rounded-sm max-w-5xl max-h-[90vh]">
                            <DialogHeader>
                              <DialogTitle>Mod Browser</DialogTitle>
                              <DialogDescription>
                                Search and install mods from Modrinth
                              </DialogDescription>
                            </DialogHeader>
                            <ModBrowser
                              serverName={server.name}
                              mcVersion={server.mc_version}
                              loader={server.edition.toLowerCase() as 'forge' | 'fabric' | 'neoforge'}
                              serverMemoryMB={server.memory_mb}
                              onInstall={() => {
                                setMessage(`Mod installed. Restart ${server.name} to load the mod.`);
                                refresh();
                              }}
                            />
                          </DialogContent>
                        </Dialog>

                        <Tooltip>
                          <div>
                            <input
                              type="file"
                              accept=".jar"
                              id={`mod-${server.name}`}
                              className="hidden"
                              onChange={(e) => handleFileUpload(server.name, "mods", e)}
                            />
                            <label htmlFor={`mod-${server.name}`}>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  className="rounded-sm w-full hover:bg-orange-500/10 hover:border-orange-500 transition-all"
                                  asChild
                                >
                                  <span>
                                    <Upload className="mr-2 h-4 w-4" />
                                    Upload Mod
                                  </span>
                                </Button>
                              </TooltipTrigger>
                            </label>
                          </div>
                          <TooltipContent className="max-w-xs">
                            <p className="font-semibold mb-1">Upload Mod (.jar)</p>
                            <p className="text-xs">Download from CurseForge or Modrinth. Players must have matching mods.</p>
                          </TooltipContent>
                        </Tooltip>
                      </>
                    )}

                    {/* Upload World */}
                    <Tooltip>
                      <div>
                        <input
                          type="file"
                          accept=".zip"
                          id={`world-${server.name}`}
                          className="hidden"
                          onChange={(e) =>
                            handleFileUpload(server.name, "worlds/upload", e)
                          }
                        />
                        <label htmlFor={`world-${server.name}`}>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              className="rounded-sm w-full hover:bg-cyan-500/10 hover:border-cyan-500 transition-all"
                              asChild
                            >
                              <span>
                                <Globe className="mr-2 h-4 w-4" />
                                🌍 Upload World
                              </span>
                            </Button>
                          </TooltipTrigger>
                        </label>
                      </div>
                      <TooltipContent className="max-w-xs">
                        <p className="font-semibold mb-1">Upload World (.zip)</p>
                        <p className="text-xs">Compress your world folder. Must contain level.dat, region/, and data/ folders. Server will restart.</p>
                      </TooltipContent>
                    </Tooltip>

                    {/* Server Settings */}
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          variant="outline"
                          className="rounded-sm hover:bg-blue-500/10 hover:border-blue-500 transition-all"
                        >
                          <Settings className="mr-2 h-4 w-4" />
                          ⚙️ Server Settings
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="rounded-sm max-w-3xl max-h-[85vh] overflow-y-auto">
                        <DialogHeader>
                          <DialogTitle>⚙️ Server Configuration</DialogTitle>
                          <DialogDescription>
                            Configure server properties, plugins, and admins
                          </DialogDescription>
                        </DialogHeader>

                        <Tabs defaultValue="properties" className="w-full">
                          <TabsList className="grid w-full grid-cols-6">
                            <TabsTrigger value="network">Network</TabsTrigger>
                            <TabsTrigger value="properties">Properties</TabsTrigger>
                            <TabsTrigger value="gameplay">Gameplay</TabsTrigger>
                            <TabsTrigger value="security">Security</TabsTrigger>
                            <TabsTrigger value="plugins">Plugins</TabsTrigger>
                            <TabsTrigger value="admins">Admins</TabsTrigger>
                          </TabsList>

                          {/* Network Tab */}
                          <TabsContent value="network" className="space-y-4">
                            <div className="space-y-4">
                              <div>
                                <Label htmlFor="hostIp">Host IP Address (Local Network)</Label>
                                <Input
                                  id="hostIp"
                                  type="text"
                                  value={serverSettings.hostIp}
                                  onChange={(e) => setServerSettings({...serverSettings, hostIp: e.target.value})}
                                  onBlur={(e) => saveNetworkConfig(server.name, 'host_ip', e.target.value)}
                                  placeholder="192.168.0.170"
                                  className="rounded-sm"
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                  The IP address of the LXD host machine on your local network
                                </p>
                              </div>

                              <div>
                                <Label htmlFor="publicDomain">Public Domain (Optional)</Label>
                                <Input
                                  id="publicDomain"
                                  type="text"
                                  value={serverSettings.publicDomain}
                                  onChange={(e) => setServerSettings({...serverSettings, publicDomain: e.target.value})}
                                  onBlur={(e) => saveNetworkConfig(server.name, 'public_domain', e.target.value)}
                                  placeholder="mc.yourdomain.com"
                                  className="rounded-sm"
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                  Set your public domain name to enable public connection monitoring and display the correct connection info
                                </p>
                              </div>

                              <Separator />

                              <div className="bg-muted/50 p-3 rounded-lg">
                                <p className="text-sm font-semibold mb-1">How to set up public access:</p>
                                <ol className="text-xs text-muted-foreground space-y-1 list-decimal ml-4">
                                  <li>Configure port forwarding on your router: External port {server.public_port} → {server.host_ip || 'your LXD host'}:{server.public_port}</li>
                                  <li>Set up DNS A record pointing to your public IP address</li>
                                  <li>Enter your domain name above</li>
                                  <li>Public connection status will update automatically</li>
                                </ol>
                              </div>
                            </div>
                          </TabsContent>

                          {/* Server Properties Tab */}
                          <TabsContent value="properties" className="space-y-4">
                            <div className="space-y-3">
                              <div>
                                <Label htmlFor="motd">Server Description (MOTD)</Label>
                                <Textarea
                                  id="motd"
                                  value={serverSettings.motd}
                                  onChange={(e) => setServerSettings({...serverSettings, motd: e.target.value})}
                                  placeholder="A Minecraft Server"
                                  className="rounded-sm"
                                />
                                <p className="text-xs text-muted-foreground mt-1">Shown in the server list</p>
                              </div>

                              <div>
                                <Label htmlFor="maxPlayers">Max Players</Label>
                                <Input
                                  id="maxPlayers"
                                  type="number"
                                  value={serverSettings.maxPlayers}
                                  onChange={(e) => setServerSettings({...serverSettings, maxPlayers: parseInt(e.target.value)})}
                                  className="rounded-sm"
                                />
                              </div>

                              <div>
                                <Label htmlFor="viewDistance">View Distance (chunks)</Label>
                                <Input
                                  id="viewDistance"
                                  type="number"
                                  min="3"
                                  max="32"
                                  value={serverSettings.viewDistance}
                                  onChange={(e) => setServerSettings({...serverSettings, viewDistance: parseInt(e.target.value)})}
                                  className="rounded-sm"
                                />
                                <p className="text-xs text-muted-foreground mt-1">Lower = better performance</p>
                              </div>

                              <div className="flex items-center space-x-2">
                                <Checkbox
                                  id="onlineMode"
                                  checked={serverSettings.onlineMode}
                                  onCheckedChange={(checked) => setServerSettings({...serverSettings, onlineMode: !!checked})}
                                />
                                <Label htmlFor="onlineMode" className="cursor-pointer">
                                  Online Mode (Minecraft account required)
                                </Label>
                              </div>
                            </div>
                          </TabsContent>

                          {/* Gameplay Tab */}
                          <TabsContent value="gameplay" className="space-y-4">
                            <div className="space-y-3">
                              <div>
                                <Label htmlFor="gamemode">Default Game Mode</Label>
                                <Select
                                  value={serverSettings.gamemode}
                                  onValueChange={(value) => setServerSettings({...serverSettings, gamemode: value})}
                                >
                                  <SelectTrigger className="rounded-sm">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="survival">Survival</SelectItem>
                                    <SelectItem value="creative">Creative</SelectItem>
                                    <SelectItem value="adventure">Adventure</SelectItem>
                                    <SelectItem value="spectator">Spectator</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              <div>
                                <Label htmlFor="difficulty">Difficulty</Label>
                                <Select
                                  value={serverSettings.difficulty}
                                  onValueChange={(value) => setServerSettings({...serverSettings, difficulty: value})}
                                >
                                  <SelectTrigger className="rounded-sm">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="peaceful">Peaceful</SelectItem>
                                    <SelectItem value="easy">Easy</SelectItem>
                                    <SelectItem value="normal">Normal</SelectItem>
                                    <SelectItem value="hard">Hard</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="flex items-center space-x-2">
                                <Checkbox
                                  id="pvp"
                                  checked={serverSettings.pvp}
                                  onCheckedChange={(checked) => setServerSettings({...serverSettings, pvp: !!checked})}
                                />
                                <Label htmlFor="pvp" className="cursor-pointer">
                                  Enable PvP (Player vs Player)
                                </Label>
                              </div>

                              <div className="flex items-center space-x-2">
                                <Checkbox
                                  id="allowFlight"
                                  checked={serverSettings.allowFlight}
                                  onCheckedChange={(checked) => setServerSettings({...serverSettings, allowFlight: !!checked})}
                                />
                                <Label htmlFor="allowFlight" className="cursor-pointer">
                                  Allow Flight
                                </Label>
                              </div>

                              <div>
                                <Label htmlFor="spawnProtection">Spawn Protection (blocks)</Label>
                                <Input
                                  id="spawnProtection"
                                  type="number"
                                  min="0"
                                  value={serverSettings.spawnProtection}
                                  onChange={(e) => setServerSettings({...serverSettings, spawnProtection: parseInt(e.target.value)})}
                                  className="rounded-sm"
                                />
                                <p className="text-xs text-muted-foreground mt-1">Radius around spawn where non-ops can't build</p>
                              </div>
                            </div>
                          </TabsContent>

                          {/* Security Tab */}
                          <TabsContent value="security" className="space-y-4">
                            <div className="space-y-4">
                              <div>
                                <Label htmlFor="serverPassword">Server Password (Optional)</Label>
                                <Input
                                  id="serverPassword"
                                  type="password"
                                  value={serverSettings.serverPassword}
                                  onChange={(e) => setServerSettings({...serverSettings, serverPassword: e.target.value})}
                                  placeholder="Leave blank for no password"
                                  className="rounded-sm"
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                  Players must enter this password to join
                                </p>
                              </div>

                              <Separator />

                              <div>
                                <div className="flex items-center space-x-2 mb-3">
                                  <Checkbox
                                    id="enforceWhitelist"
                                    checked={serverSettings.enforceWhitelist}
                                    onCheckedChange={(checked) => setServerSettings({
                                      ...serverSettings,
                                      enforceWhitelist: !!checked
                                    })}
                                  />
                                  <Label htmlFor="enforceWhitelist" className="cursor-pointer">
                                    Enable Whitelist (Only approved players can join)
                                  </Label>
                                </div>

                                {serverSettings.enforceWhitelist && (
                                  <div className="space-y-3 pl-6">
                                    <div>
                                      <Label>Whitelisted Players</Label>
                                      <p className="text-xs text-muted-foreground mb-2">
                                        Only these players can join when whitelist is enabled
                                      </p>
                                      <div className="flex gap-2">
                                        <Input
                                          placeholder="Enter Minecraft username"
                                          value={serverSettings.newWhitelistPlayer}
                                          onChange={(e) => setServerSettings({
                                            ...serverSettings,
                                            newWhitelistPlayer: e.target.value
                                          })}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter' && serverSettings.newWhitelistPlayer.trim()) {
                                              setServerSettings({
                                                ...serverSettings,
                                                whitelist: [...serverSettings.whitelist, serverSettings.newWhitelistPlayer.trim()],
                                                newWhitelistPlayer: ""
                                              });
                                            }
                                          }}
                                          className="rounded-sm"
                                        />
                                        <Button
                                          type="button"
                                          variant="outline"
                                          className="rounded-sm"
                                          onClick={() => {
                                            if (serverSettings.newWhitelistPlayer.trim()) {
                                              setServerSettings({
                                                ...serverSettings,
                                                whitelist: [...serverSettings.whitelist, serverSettings.newWhitelistPlayer.trim()],
                                                newWhitelistPlayer: ""
                                              });
                                            }
                                          }}
                                        >
                                          Add
                                        </Button>
                                      </div>
                                    </div>

                                    {serverSettings.whitelist.length > 0 && (
                                      <div className="space-y-2">
                                        <Label>Whitelisted:</Label>
                                        <div className="space-y-1">
                                          {serverSettings.whitelist.map((player, idx) => (
                                            <div key={idx} className="flex items-center justify-between p-2 bg-muted rounded-sm">
                                              <span className="flex items-center gap-2">
                                                <Users className="h-4 w-4" />
                                                {player}
                                              </span>
                                              <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-6 px-2"
                                                onClick={() => {
                                                  setServerSettings({
                                                    ...serverSettings,
                                                    whitelist: serverSettings.whitelist.filter((_, i) => i !== idx)
                                                  });
                                                }}
                                              >
                                                Remove
                                              </Button>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>

                              <Separator />

                              <div className="bg-muted/50 p-3 rounded-lg">
                                <p className="text-sm font-semibold mb-1">💡 Security Tips</p>
                                <ul className="text-xs text-muted-foreground space-y-1">
                                  <li>• Use whitelist for private servers with friends</li>
                                  <li>• Keep Online Mode ON to prevent fake accounts</li>
                                  <li>• Only give OP to people you trust completely</li>
                                  <li>• Server password is extra protection (optional)</li>
                                </ul>
                              </div>
                            </div>
                          </TabsContent>

                          {/* Plugins Tab */}
                          <TabsContent value="plugins" className="space-y-4">
                            <p className="text-sm text-muted-foreground">
                              Select plugins to install automatically (Paper/Spigot only)
                            </p>
                            <div className="space-y-3">
                              <div className="flex items-center space-x-2">
                                <Checkbox
                                  id="plugin-luckperms"
                                  checked={serverSettings.plugins.luckperms}
                                  onCheckedChange={(checked) => setServerSettings({
                                    ...serverSettings,
                                    plugins: {...serverSettings.plugins, luckperms: !!checked}
                                  })}
                                />
                                <Label htmlFor="plugin-luckperms" className="cursor-pointer">
                                  <span className="font-semibold">LuckPerms</span>
                                  <span className="text-xs text-muted-foreground ml-2">- Advanced permissions plugin</span>
                                </Label>
                              </div>

                              <div className="flex items-center space-x-2">
                                <Checkbox
                                  id="plugin-essentialsx"
                                  checked={serverSettings.plugins.essentialsx}
                                  onCheckedChange={(checked) => setServerSettings({
                                    ...serverSettings,
                                    plugins: {...serverSettings.plugins, essentialsx: !!checked}
                                  })}
                                />
                                <Label htmlFor="plugin-essentialsx" className="cursor-pointer">
                                  <span className="font-semibold">EssentialsX</span>
                                  <span className="text-xs text-muted-foreground ml-2">- Essential commands & features</span>
                                </Label>
                              </div>

                              <div className="flex items-center space-x-2">
                                <Checkbox
                                  id="plugin-vault"
                                  checked={serverSettings.plugins.vault}
                                  onCheckedChange={(checked) => setServerSettings({
                                    ...serverSettings,
                                    plugins: {...serverSettings.plugins, vault: !!checked}
                                  })}
                                />
                                <Label htmlFor="plugin-vault" className="cursor-pointer">
                                  <span className="font-semibold">Vault</span>
                                  <span className="text-xs text-muted-foreground ml-2">- Economy & permissions API</span>
                                </Label>
                              </div>

                              <div className="flex items-center space-x-2">
                                <Checkbox
                                  id="plugin-worldedit"
                                  checked={serverSettings.plugins.worldedit}
                                  onCheckedChange={(checked) => setServerSettings({
                                    ...serverSettings,
                                    plugins: {...serverSettings.plugins, worldedit: !!checked}
                                  })}
                                />
                                <Label htmlFor="plugin-worldedit" className="cursor-pointer">
                                  <span className="font-semibold">WorldEdit</span>
                                  <span className="text-xs text-muted-foreground ml-2">- In-game world editor</span>
                                </Label>
                              </div>
                            </div>
                          </TabsContent>

                          {/* Admins Tab */}
                          <TabsContent value="admins" className="space-y-4">
                            <div className="space-y-3">
                              <div>
                                <Label>Server Operators (Admins)</Label>
                                <p className="text-xs text-muted-foreground mb-2">
                                  Operators have full permissions and can use all commands
                                </p>
                                <div className="flex gap-2">
                                  <Input
                                    placeholder="Enter Minecraft username"
                                    value={serverSettings.newOperator}
                                    onChange={(e) => setServerSettings({...serverSettings, newOperator: e.target.value})}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && serverSettings.newOperator.trim()) {
                                        setServerSettings({
                                          ...serverSettings,
                                          operators: [...serverSettings.operators, serverSettings.newOperator.trim()],
                                          newOperator: ""
                                        });
                                      }
                                    }}
                                    className="rounded-sm"
                                  />
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="rounded-sm"
                                    onClick={() => {
                                      if (serverSettings.newOperator.trim()) {
                                        setServerSettings({
                                          ...serverSettings,
                                          operators: [...serverSettings.operators, serverSettings.newOperator.trim()],
                                          newOperator: ""
                                        });
                                      }
                                    }}
                                  >
                                    Add
                                  </Button>
                                </div>
                              </div>

                              {serverSettings.operators.length > 0 && (
                                <div className="space-y-2">
                                  <Label>Current Operators:</Label>
                                  <div className="space-y-1">
                                    {serverSettings.operators.map((op, idx) => (
                                      <div key={idx} className="flex items-center justify-between p-2 bg-muted rounded-sm">
                                        <span className="flex items-center gap-2">
                                          <Users className="h-4 w-4" />
                                          {op}
                                        </span>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-6 px-2"
                                          onClick={() => {
                                            setServerSettings({
                                              ...serverSettings,
                                              operators: serverSettings.operators.filter((_, i) => i !== idx)
                                            });
                                          }}
                                        >
                                          Remove
                                        </Button>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </TabsContent>
                        </Tabs>

                        <DialogFooter>
                          <Button
                            variant="outline"
                            className="rounded-sm"
                            onClick={() => {/* TODO: Save settings */}}
                          >
                            Cancel
                          </Button>
                          <Button
                            className="rounded-sm"
                            onClick={() => {
                              // TODO: Apply settings to server
                              console.log("Applying settings:", serverSettings);
                            }}
                          >
                            💾 Save & Apply
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>

                    {/* Create Backup */}
                    <Button
                      variant="outline"
                      className="rounded-sm hover:bg-amber-500/10 hover:border-amber-500 transition-all"
                      onClick={() => handleServerAction(server.name, "backup")}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      💾 Create Backup
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        </div>
      </div>
    </TooltipProvider>
  );
}
