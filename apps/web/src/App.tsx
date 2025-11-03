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

  async function refresh() {
    setIsRefreshing(true);
    try {
      const res = await fetch("/api/servers");
      setServers(await res.json());
    } catch (err) {
      setMessage("Failed to fetch servers");
    } finally {
      setIsRefreshing(false);
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
            <h1 className="text-3xl font-bold tracking-tight">MC LXD Manager</h1>
            <p className="text-muted-foreground mt-1">
              Manage your Minecraft servers
            </p>
          </div>
          <div className="flex gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="rounded-sm">
                  <HelpCircle className="mr-2 h-4 w-4" />
                  Getting Started
                </Button>
              </DialogTrigger>
              <DialogContent className="rounded-sm max-w-2xl max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Getting Started with MC LXD Manager</DialogTitle>
                  <DialogDescription>
                    How to use your Minecraft server
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
                    <h3 className="font-semibold mb-2">3. Upload Plugins</h3>
                    <p className="text-muted-foreground mb-2">For Paper/Spigot servers only:</p>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                      <li>Download .jar files from SpigotMC, Bukkit, or Modrinth</li>
                      <li>Click "Upload Plugin" and select the .jar file</li>
                      <li>Restart the server to load the plugin</li>
                    </ul>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-2">4. Upload Mods</h3>
                    <p className="text-muted-foreground mb-2">For modded servers (Forge/Fabric):</p>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                      <li>Download .jar files from CurseForge or Modrinth</li>
                      <li>Click "Upload Mod" and select the .jar file</li>
                      <li>Players must have the same mods installed</li>
                    </ul>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-2">5. Upload Worlds</h3>
                    <p className="text-muted-foreground mb-2">Import existing Minecraft worlds:</p>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                      <li>Compress your world folder into a .zip file</li>
                      <li>The .zip should contain level.dat, region/, data/ folders</li>
                      <li>Click "Upload World" and select the .zip</li>
                      <li>Server will stop, extract world, and restart</li>
                    </ul>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-2">6. Create a New World</h3>
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
                      <div className="mt-3 space-y-1">
                        <div className="flex items-center gap-2 text-sm">
                          <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-muted-foreground">Local:</span>
                          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                            {server.local_ip}:{server.local_port}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5"
                            onClick={() => copyToClipboard(`${server.local_ip}:${server.local_port}`)}
                            title="Copy to clipboard"
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                        {server.public_domain && (
                          <div className="flex items-center gap-2 text-sm">
                            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-muted-foreground">Public:</span>
                            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                              {server.public_domain}:{server.public_port}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5"
                              onClick={() => copyToClipboard(`${server.public_domain}:${server.public_port}`)}
                              title="Copy to clipboard"
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
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
                          className="rounded-sm w-full"
                          onClick={() => setSelectedServer(server.name)}
                        >
                          <Settings className="mr-2 h-4 w-4" />
                          Change Version
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

                    {/* Upload Plugin */}
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
                              className="rounded-sm w-full"
                              asChild
                            >
                              <span>
                                <Package className="mr-2 h-4 w-4" />
                                Upload Plugin
                              </span>
                            </Button>
                          </TooltipTrigger>
                        </label>
                      </div>
                      <TooltipContent className="max-w-xs">
                        <p className="font-semibold mb-1">Upload Plugin (.jar)</p>
                        <p className="text-xs">For Paper/Spigot only. Download from SpigotMC, Bukkit, or Modrinth. Restart server after upload.</p>
                      </TooltipContent>
                    </Tooltip>

                    {/* Upload Mod */}
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
                              className="rounded-sm w-full"
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
                        <p className="text-xs">For Forge/Fabric servers. Download from CurseForge or Modrinth. Players must have matching mods.</p>
                      </TooltipContent>
                    </Tooltip>

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
                              className="rounded-sm w-full"
                              asChild
                            >
                              <span>
                                <Globe className="mr-2 h-4 w-4" />
                                Upload World
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

                    {/* Install LuckPerms */}
                    <Button
                      variant="outline"
                      className="rounded-sm"
                      onClick={() => handleServerAction(server.name, "luckperms")}
                    >
                      <Package className="mr-2 h-4 w-4" />
                      Install LuckPerms
                    </Button>

                    {/* Create Backup */}
                    <Button
                      variant="outline"
                      className="rounded-sm"
                      onClick={() => handleServerAction(server.name, "backup")}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      Create Backup
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
