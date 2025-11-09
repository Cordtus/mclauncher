import { useState, useEffect } from "react";
import { Package2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InstalledModCard } from "./InstalledModCard";
import { ModConfigEditor } from "./ModConfigEditor";
import { ModBrowser } from "./ModBrowser";
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
}

export function ModsManagementPanel({
  serverName,
  mcVersion,
  loader,
  serverMemoryMB,
}: ModsManagementPanelProps) {
  const [mods, setMods] = useState<InstalledMod[]>([]);
  const [filteredMods, setFilteredMods] = useState<InstalledMod[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [message, setMessage] = useState("");
  const [selectedModForConfig, setSelectedModForConfig] = useState<string | null>(null);
  const [configFileName, setConfigFileName] = useState<string>("");

  useEffect(() => {
    loadMods();
  }, [serverName]);

  useEffect(() => {
    filterMods();
  }, [mods, searchQuery, filterStatus]);

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
    try {
      const response = await fetch(`/api/servers/${serverName}/mods/${fileName}/toggle`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('ADMIN_TOKEN')}`,
        },
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
    try {
      const url = `/api/servers/${serverName}/mods/${fileName}${
        removeConfigs ? '?removeConfigs=true' : ''
      }`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('ADMIN_TOKEN')}`,
        },
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

  async function handleConfigure(modId: string) {
    try {
      // First, check if there are config files for this mod
      const response = await fetch(`/api/servers/${serverName}/mods/${modId}/configs`);
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

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Installed Mods</h2>
          <p className="text-sm text-muted-foreground">
            {mods.length} {mods.length === 1 ? 'mod' : 'mods'} installed
          </p>
        </div>
        <div className="flex gap-2">
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
