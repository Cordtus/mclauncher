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
} from "lucide-react";
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
  navigator.clipboard.writeText(text);
}

export function App() {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
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

  // Connection status tracking
  const [connectionStatus, setConnectionStatus] = useState({
    local: { status: 'checking' as 'online' | 'offline' | 'checking', lastChecked: null as Date | null },
    public: { status: 'checking' as 'online' | 'offline' | 'checking', lastChecked: null as Date | null }
  });

  // Save settings to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('mc-server-settings', JSON.stringify(serverSettings));
  }, [serverSettings]);

  async function refresh() {
    setIsRefreshing(true);
    try {
      const res = await fetch("/api/servers");
      const serverData = await res.json();
      setServers(serverData);

      // Check connection status for first server
      if (serverData.length > 0) {
        checkConnectionStatus(serverData[0]);
      }
    } catch (err) {
      setMessage("Failed to fetch servers");
    } finally {
      setIsRefreshing(false);
    }
  }

  // Check if local and public connections are accessible
  async function checkConnectionStatus(server: ServerRow) {
    // Check local connection
    try {
      const localCheck = await fetch(`http://${server.local_ip}:${server.local_port}`, {
        method: 'HEAD',
        mode: 'no-cors', // Minecraft server won't respond to HTTP properly
        signal: AbortSignal.timeout(3000)
      });
      setConnectionStatus(prev => ({
        ...prev,
        local: { status: 'online', lastChecked: new Date() }
      }));
    } catch (err) {
      // For Minecraft servers, no-cors will always "fail" but if server is online, it responds
      // We rely on the minecraft status from the agent instead
      if (server.minecraft?.online) {
        setConnectionStatus(prev => ({
          ...prev,
          local: { status: 'online', lastChecked: new Date() }
        }));
      } else {
        setConnectionStatus(prev => ({
          ...prev,
          local: { status: 'offline', lastChecked: new Date() }
        }));
      }
    }

    // Check public connection (if public domain is set)
    if (server.public_domain) {
      try {
        // Use a public ping service or our own backend endpoint
        const publicCheck = await fetch(`/api/servers/${server.name}/check-public`, {
          signal: AbortSignal.timeout(5000)
        });
        const result = await publicCheck.json();
        setConnectionStatus(prev => ({
          ...prev,
          public: {
            status: result.accessible ? 'online' : 'offline',
            lastChecked: new Date()
          }
        }));
      } catch (err) {
        setConnectionStatus(prev => ({
          ...prev,
          public: { status: 'offline', lastChecked: new Date() }
        }));
      }
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, []);

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
          <div>
            <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-green-400 to-emerald-600 bg-clip-text text-transparent">
              🎮 Minecraft Server Control
            </h1>
            <p className="text-muted-foreground mt-1">
              Build, play, and manage your worlds! ⚔️
            </p>
          </div>
          <div className="flex gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="rounded-sm hover:bg-green-500/10 hover:border-green-500 transition-all">
                  <HelpCircle className="mr-2 h-4 w-4" />
                  🎓 Getting Started
                </Button>
              </DialogTrigger>
              <DialogContent className="rounded-sm max-w-2xl max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>🎯 Let's Get Started!</DialogTitle>
                  <DialogDescription>
                    Everything you need to know to run your awesome server 🚀
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 text-sm">
                  <div>
                    <h3 className="font-semibold mb-2">1. Start the Minecraft Server</h3>
                    <p className="text-muted-foreground">Click the Play button to start the Minecraft server process. The server will take 30-60 seconds to fully start.</p>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-2">2. Connect to Your Server</h3>
                    <p className="text-muted-foreground mb-2">In Minecraft, go to Multiplayer → Add Server and use:</p>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                      <li><strong>From LAN:</strong> Use the Local IP shown (e.g., 10.70.48.204:25565)</li>
                      <li><strong>From Internet:</strong> Configure a public domain first</li>
                    </ul>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-2">3. Add Plugins or Mods</h3>
                    <p className="text-muted-foreground mb-2">The upload button shown depends on your server type:</p>
                    <div className="ml-2 space-y-3">
                      <div>
                        <p className="font-medium text-sm">🔌 Plugins (Paper/Purpur/Spigot):</p>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground text-sm ml-2">
                          <li>Download .jar files from SpigotMC, Bukkit, or Modrinth</li>
                          <li>Click "Upload Plugin" and select the .jar file</li>
                          <li>Restart the server to load the plugin</li>
                        </ul>
                      </div>
                      <div>
                        <p className="font-medium text-sm">📦 Mods (Forge/NeoForge/Fabric):</p>
                        <ul className="list-disc list-inside space-y-1 text-muted-foreground text-sm ml-2">
                          <li>Download .jar files from CurseForge or Modrinth</li>
                          <li>Click "Upload Mod" and select the .jar file</li>
                          <li>Players must have the same mods installed</li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-2">4. Upload Worlds</h3>
                    <p className="text-muted-foreground mb-2">Import existing Minecraft worlds:</p>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                      <li>Compress your world folder into a .zip file</li>
                      <li>The .zip should contain level.dat, region/, data/ folders</li>
                      <li>Click "Upload World" and select the .zip</li>
                      <li>Server will stop, extract world, and restart</li>
                    </ul>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-2">5. Create a New World</h3>
                    <p className="text-muted-foreground">A default world is created on first start. To customize, edit server.properties and restart.</p>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-2">File Format Examples</h3>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                      <li><strong>Plugins:</strong> EssentialsX.jar, WorldEdit.jar</li>
                      <li><strong>Mods:</strong> sodium-fabric-0.5.8.jar</li>
                      <li><strong>Worlds:</strong> my-world.zip (contains level.dat inside)</li>
                    </ul>
                  </div>
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
                      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                        {/* Local Connection */}
                        <div className="border rounded-lg p-3 bg-card">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <Globe className="h-4 w-4 text-muted-foreground" />
                              <span className="text-sm font-semibold">🏠 Local Network</span>
                            </div>
                            {connectionStatus.local.status === 'online' && (
                              <Badge className="bg-green-500 hover:bg-green-600">✓ ONLINE</Badge>
                            )}
                            {connectionStatus.local.status === 'offline' && (
                              <Badge variant="destructive">✗ OFFLINE</Badge>
                            )}
                            {connectionStatus.local.status === 'checking' && (
                              <Badge variant="outline">⟳ CHECKING</Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <code className="bg-muted px-2 py-1 rounded text-xs flex-1">
                              {server.local_ip}:{server.local_port}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => copyToClipboard(`${server.local_ip}:${server.local_port}`)}
                              title="Copy to clipboard"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">For players on the same WiFi</p>
                        </div>

                        {/* Public Connection */}
                        <div className="border rounded-lg p-3 bg-card">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <Globe className="h-4 w-4 text-muted-foreground" />
                              <span className="text-sm font-semibold">🌍 Public Internet</span>
                            </div>
                            {server.public_domain ? (
                              <>
                                {connectionStatus.public.status === 'online' && (
                                  <Badge className="bg-green-500 hover:bg-green-600">✓ ONLINE</Badge>
                                )}
                                {connectionStatus.public.status === 'offline' && (
                                  <Badge variant="destructive">✗ OFFLINE</Badge>
                                )}
                                {connectionStatus.public.status === 'checking' && (
                                  <Badge variant="outline">⟳ CHECKING</Badge>
                                )}
                              </>
                            ) : (
                              <Badge variant="outline">Not configured</Badge>
                            )}
                          </div>
                          {server.public_domain ? (
                            <>
                              <div className="flex items-center gap-2">
                                <code className="bg-muted px-2 py-1 rounded text-xs flex-1">
                                  {server.public_domain}:{server.public_port}
                                </code>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => copyToClipboard(`${server.public_domain}:${server.public_port}`)}
                                  title="Copy to clipboard"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1">For friends anywhere</p>
                            </>
                          ) : (
                            <p className="text-xs text-muted-foreground">Set up in Server Settings</p>
                          )}
                        </div>
                      </div>

                      {/* Player Info */}
                      {server.minecraft?.online && server.minecraft.players && (
                        <div className="mt-2 flex items-center gap-2 text-sm">
                          <Users className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-muted-foreground">Players:</span>
                          <Badge variant="secondary" className="rounded-sm text-xs">
                            {server.minecraft.players.online}/{server.minecraft.players.max}
                          </Badge>
                          {server.minecraft.description && (
                            <span className="text-xs text-muted-foreground ml-2">
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
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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

                    {/* Upload Mod - Only for Forge/NeoForge/Fabric */}
                    {['forge', 'neoforge', 'fabric'].includes(server.edition.toLowerCase()) && (
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
                                  📦 Upload Mod
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
                          <TabsList className="grid w-full grid-cols-5">
                            <TabsTrigger value="properties">Properties</TabsTrigger>
                            <TabsTrigger value="gameplay">Gameplay</TabsTrigger>
                            <TabsTrigger value="security">Security</TabsTrigger>
                            <TabsTrigger value="plugins">Plugins</TabsTrigger>
                            <TabsTrigger value="admins">Admins</TabsTrigger>
                          </TabsList>

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
