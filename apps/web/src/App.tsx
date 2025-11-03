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

type ServerRow = {
  name: string;
  status: string;
  public_port: number;
  memory_mb: number;
  cpu_limit: string;
  edition: string;
  mc_version: string;
};

function authHeaders(): HeadersInit {
  const h: Record<string, string> = {};
  const t = localStorage.getItem("ADMIN_TOKEN");
  if (t) h["Authorization"] = "Bearer " + t;
  return h;
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
                        {server.edition} {server.mc_version} · Port {server.public_port} ·{" "}
                        {server.memory_mb}MB RAM · {server.cpu_limit} CPU
                      </CardDescription>
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
                      </label>
                    </div>

                    {/* Upload Mod */}
                    <div>
                      <input
                        type="file"
                        accept=".jar"
                        id={`mod-${server.name}`}
                        className="hidden"
                        onChange={(e) => handleFileUpload(server.name, "mods", e)}
                      />
                      <label htmlFor={`mod-${server.name}`}>
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
                      </label>
                    </div>

                    {/* Upload World */}
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
                      </label>
                    </div>

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
  );
}
