import { useState, useEffect } from "react";
import { Copy, Package2, RefreshCw, Search, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InstalledModCard } from "./InstalledModCard";
import { ModConfigEditor } from "./ModConfigEditor";
import { ModBrowser } from "./ModBrowser";
import { ModpackExport } from "./ModpackExport";
import { authHeaders, jsonAuthHeaders } from "@/lib/auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface InstalledMod {
  fileName: string;
  modId: string;
  name: string;
  version: string;
  description?: string;
  authors?: string[];
  loader: string;
  enabled: boolean;
}

interface ModsManagementPanelProps {
  serverName: string;
  mcVersion: string;
  loader: 'forge' | 'fabric' | 'neoforge';
  serverMemoryMB: number;
  publicAddress?: string;
}

export function ModsManagementPanel({
  serverName,
  mcVersion,
  loader,
  serverMemoryMB,
  publicAddress,
}: ModsManagementPanelProps) {
  const [mods, setMods] = useState<InstalledMod[]>([]);
  const [filteredMods, setFilteredMods] = useState<InstalledMod[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [message, setMessage] = useState("");
  const [selectedModForConfig, setSelectedModForConfig] = useState<string | null>(null);
  const [configFileName, setConfigFileName] = useState<string>("");
  const [friendManifest, setFriendManifest] = useState("");

  useEffect(() => {
    loadMods();
  }, [serverName]);

  useEffect(() => {
    filterMods();
  }, [mods, searchQuery, filterStatus]);

  async function copyTextToClipboard(text: string) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to the textarea copy path.
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();

    try {
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  }

  async function loadMods() {
    setIsLoading(true);
    setMessage("");
    try {
      const response = await fetch(`/api/servers/${serverName}/mods/installed`);
      if (!response.ok) {
        throw new Error("Failed to load mods");
      }

      const data = await response.json();
      setMods(data.mods || []);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function filterMods() {
    let filtered = [...mods];

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (mod) =>
          mod.name.toLowerCase().includes(query) ||
          mod.description?.toLowerCase().includes(query) ||
          mod.modId.toLowerCase().includes(query)
      );
    }

    // Filter by status
    if (filterStatus === "enabled") {
      filtered = filtered.filter((mod) => mod.enabled);
    } else if (filterStatus === "disabled") {
      filtered = filtered.filter((mod) => !mod.enabled);
    }

    setFilteredMods(filtered);
  }

  async function handleToggle(fileName: string, enabled: boolean) {
    const encodedFileName = encodeURIComponent(fileName);
    try {
      const response = await fetch(`/api/servers/${serverName}/mods/${encodedFileName}/toggle`, {
        method: 'PATCH',
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ enabled }),
      });

      if (!response.ok) {
        throw new Error("Failed to toggle mod");
      }

      const result = await response.json();

      // Update local state
      setMods((prev) =>
        prev.map((mod) => {
          if (mod.fileName === fileName) {
            return { ...mod, fileName: result.newFileName || mod.fileName, enabled };
          }
          return mod;
        })
      );

      setMessage(`Mod ${enabled ? 'enabled' : 'disabled'}. Restart server to apply.`);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    }
  }

  async function handleRemove(fileName: string, removeConfigs: boolean) {
    const encodedFileName = encodeURIComponent(fileName);
    try {
      const url = `/api/servers/${serverName}/mods/${encodedFileName}${
        removeConfigs ? '?removeConfigs=true' : ''
      }`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: authHeaders(),
      });

      if (!response.ok) {
        throw new Error("Failed to remove mod");
      }

      // Remove from local state
      setMods((prev) => prev.filter((mod) => mod.fileName !== fileName));
      setMessage("Mod removed successfully. Restart server to apply.");
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    }
  }

  async function handleConfigure(modId: string, fileName: string) {
    const encodedModId = encodeURIComponent(modId);
    try {
      // First, check if there are config files for this mod
      const response = await fetch(`/api/servers/${serverName}/mods/${encodedModId}/configs`);
      if (!response.ok) {
        throw new Error("Failed to check for config files");
      }

      const data = await response.json();
      const configs = data.configs || [];

      if (configs.length === 0) {
        setMessage("This mod has no configuration files");
        return;
      }

      // For now, just use the first config file
      // In a more advanced version, we could show a list
      const configPath = configs[0];
      const fileName = configPath.split('/').pop() || '';

      setSelectedModForConfig(modId);
      setConfigFileName(fileName);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    }
  }

  async function handleManualUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch(`/api/servers/${serverName}/mods`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(text || "Failed to upload mod");
      }
      setMessage(text);
      await loadMods();
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    }
  }

  async function copyFriendManifest() {
    try {
      const response = await fetch(`/api/servers/${serverName}/mods/manifest`);
      if (!response.ok) {
        throw new Error("Failed to build mod setup guide");
      }

      const data = await response.json();
      const publicAddress = data.server.public_address || "Ask the admin for the server address";
      const lines = [
        `Server: ${data.server.name}`,
        `Minecraft: ${data.server.edition} ${data.server.mc_version}`,
        data.server.public_address
          ? `WAN address: ${data.server.public_address}`
          : "WAN address: not configured yet",
        data.server.local_address ? `LAN address: ${data.server.local_address}` : "",
        "",
        "How to join:",
        "1. Open Minecraft: Java Edition.",
        `2. Install ${data.server.edition} for Minecraft ${data.server.mc_version}.`,
        "3. Install every enabled mod listed below.",
        `4. Add ${publicAddress} in Multiplayer > Add Server.`,
        "",
        "Required server mods:",
        ...(data.mods || [])
          .filter((mod: InstalledMod) => mod.enabled)
          .map((mod: InstalledMod) => `- ${mod.name} ${mod.version} (${mod.fileName})`),
        "",
        "The mod list must match the server before joining.",
      ].filter(Boolean);

      const manifestText = lines.join("\n");
      setFriendManifest(manifestText);
      const copied = await copyTextToClipboard(manifestText);
      setMessage(copied
        ? "Friend setup guide copied to clipboard."
        : "Friend setup guide generated. Select and copy it from the panel below."
      );
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    }
  }

  return (
    <div className="space-y-4">
      {message && (
        <div className={`p-3 rounded-lg text-sm ${
          message.includes('Error')
            ? 'bg-destructive/10 border border-destructive/20 text-destructive'
            : 'bg-primary/10 border border-primary/20'
        }`}>
          {message}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold">Installed Mods</h2>
          <p className="text-sm text-muted-foreground">
            {mods.length} {mods.length === 1 ? 'mod' : 'mods'} installed
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <ModpackExport
            serverName={serverName}
            mcVersion={mcVersion}
            loader={loader}
            modsCount={mods.length}
            publicAddress={publicAddress}
          />
          <input
            type="file"
            accept=".jar"
            id={`mod-upload-${serverName}`}
            className="hidden"
            onChange={handleManualUpload}
          />
          <label htmlFor={`mod-upload-${serverName}`}>
            <Button variant="outline" className="rounded-sm" asChild>
              <span>
                <Upload className="h-4 w-4 mr-2" />
                Upload JAR
              </span>
            </Button>
          </label>
          <Button variant="outline" className="rounded-sm" onClick={copyFriendManifest}>
            <Copy className="h-4 w-4 mr-2" />
            Friend Setup
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button className="rounded-sm">
                <Package2 className="h-4 w-4 mr-2" />
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
                serverName={serverName}
                mcVersion={mcVersion}
                loader={loader}
                serverMemoryMB={serverMemoryMB}
                onInstall={() => {
                  setMessage("Mod installed. Restart server to load the mod.");
                  loadMods();
                }}
              />
            </DialogContent>
          </Dialog>
          <Button
            variant="outline"
            size="icon"
            onClick={loadMods}
            disabled={isLoading}
            className="rounded-sm"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search mods..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 rounded-sm"
          />
        </div>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-40 rounded-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Mods</SelectItem>
            <SelectItem value="enabled">Enabled Only</SelectItem>
            <SelectItem value="disabled">Disabled Only</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground">
          Loading mods...
        </div>
      ) : filteredMods.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          {mods.length === 0
            ? "No mods installed. Browse mods to get started."
            : "No mods match your search."}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredMods.map((mod) => (
            <InstalledModCard
              key={mod.fileName}
              mod={mod}
              serverName={serverName}
              onToggle={handleToggle}
              onRemove={handleRemove}
              onConfigure={handleConfigure}
            />
          ))}
        </div>
      )}

      {friendManifest && (
        <div className="rounded-sm border bg-muted/40 p-3">
          <p className="text-sm font-medium mb-2">Friend setup guide</p>
          <pre className="text-xs whitespace-pre-wrap break-words">{friendManifest}</pre>
        </div>
      )}

      <Dialog
        open={!!selectedModForConfig}
        onOpenChange={(open) => !open && setSelectedModForConfig(null)}
      >
        <DialogContent className="rounded-sm max-w-4xl max-h-[85vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Configure Mod</DialogTitle>
            <DialogDescription>
              Modify configuration values for this mod
            </DialogDescription>
          </DialogHeader>
          {selectedModForConfig && (
            <ModConfigEditor
              serverName={serverName}
              modId={selectedModForConfig}
              configFileName={configFileName}
              onClose={() => setSelectedModForConfig(null)}
              onSave={() => setMessage("Configuration saved. Restart server to apply.")}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
