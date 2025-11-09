import { useState, useEffect } from "react";
import { Search, Download, AlertTriangle, CheckCircle2, Info, X, ExternalLink, Package2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

interface ModBrowserProps {
  serverName: string;
  mcVersion: string;
  loader: 'forge' | 'fabric' | 'neoforge' | 'paper' | 'bukkit' | 'spigot' | 'purpur' | 'folia';
  serverMemoryMB: number;
  type?: 'mod' | 'plugin';
  onInstall?: () => void;
}

interface ModrinthMod {
  slug: string;
  title: string;
  description: string;
  categories: string[];
  client_side: 'required' | 'optional' | 'unsupported';
  server_side: 'required' | 'optional' | 'unsupported';
  project_type: string;
  downloads: number;
  follows: number;
  icon_url?: string;
  date_created: string;
  date_modified: string;
  latest_version: string;
  license: string;
  gallery?: string[];
  author: string;
  versions: string[];
  project_id: string;
}

interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  files: Array<{
    url: string;
    filename: string;
    primary: boolean;
    size: number;
  }>;
}

interface CompatibilityInfo {
  compatible: boolean;
  warnings: string[];
  resourceImpact: 'light' | 'medium' | 'heavy';
  estimatedMemoryMB: number;
  conflicts: string[];
  resourceAvailable: boolean;
  resourceWarning?: string;
}

export function ModBrowser({ serverName, mcVersion, loader, serverMemoryMB, type = 'mod', onInstall }: ModBrowserProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("relevance");
  const [mods, setMods] = useState<ModrinthMod[]>([]);
  const [selectedMod, setSelectedMod] = useState<ModrinthMod | null>(null);
  const [modVersions, setModVersions] = useState<ModrinthVersion[]>([]);
  const [compatibility, setCompatibility] = useState<CompatibilityInfo | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installedMods, setInstalledMods] = useState<string[]>([]);
  const [message, setMessage] = useState<string>("");
  const [showPopular, setShowPopular] = useState(true);

  // Popular mods/plugins by loader type
  const popularMods: Record<string, Array<{slug: string; name: string; description: string; category: string}>> = {
    fabric: [
      { slug: "sodium", name: "Sodium", description: "Modern rendering engine and optimization mod", category: "Optimization" },
      { slug: "lithium", name: "Lithium", description: "Server-side performance optimization", category: "Optimization" },
      { slug: "ferritecore", name: "FerriteCore", description: "Memory usage optimization", category: "Optimization" },
      { slug: "starlight", name: "Starlight", description: "Rewrites lighting engine", category: "Optimization" },
      { slug: "fabric-api", name: "Fabric API", description: "Essential library for Fabric mods", category: "Library" },
      { slug: "roughly-enough-items", name: "REI (Roughly Enough Items)", description: "Recipe viewer and crafting helper", category: "Utility" },
      { slug: "waystones", name: "Waystones", description: "Teleportation stones", category: "Utility" },
      { slug: "journeymap", name: "JourneyMap", description: "Real-time map and minimap", category: "Utility" },
    ],
    forge: [
      { slug: "jei", name: "JEI (Just Enough Items)", description: "Recipe viewer and crafting helper", category: "Utility" },
      { slug: "waystones", name: "Waystones", description: "Teleportation stones", category: "Utility" },
      { slug: "journeymap", name: "JourneyMap", description: "Real-time map and minimap", category: "Utility" },
      { slug: "create", name: "Create", description: "Mechanical contraptions and automation", category: "Technology" },
      { slug: "ae2", name: "Applied Energistics 2", description: "Advanced storage and automation", category: "Technology" },
      { slug: "mekanism", name: "Mekanism", description: "Tech mod with machines and tools", category: "Technology" },
      { slug: "botania", name: "Botania", description: "Nature-themed magic mod", category: "Magic" },
      { slug: "ferritecore", name: "FerriteCore", description: "Memory usage optimization", category: "Optimization" },
    ],
    neoforge: [
      { slug: "jei", name: "JEI (Just Enough Items)", description: "Recipe viewer and crafting helper", category: "Utility" },
      { slug: "waystones", name: "Waystones", description: "Teleportation stones", category: "Utility" },
      { slug: "journeymap", name: "JourneyMap", description: "Real-time map and minimap", category: "Utility" },
      { slug: "create", name: "Create", description: "Mechanical contraptions and automation", category: "Technology" },
      { slug: "ae2", name: "Applied Energistics 2", description: "Advanced storage and automation", category: "Technology" },
      { slug: "ferritecore", name: "FerriteCore", description: "Memory usage optimization", category: "Optimization" },
    ],
    paper: [
      { slug: "luckperms", name: "LuckPerms", description: "Advanced permissions plugin", category: "Admin Tools" },
      { slug: "essentialsx", name: "EssentialsX", description: "Essential server commands and features", category: "Admin Tools" },
      { slug: "worldedit", name: "WorldEdit", description: "In-game map editor", category: "World Management" },
      { slug: "worldguard", name: "WorldGuard", description: "Region protection and management", category: "World Management" },
      { slug: "vault", name: "Vault", description: "Economy and permissions API", category: "Library" },
      { slug: "coreprotect", name: "CoreProtect", description: "Block logging and rollback", category: "Admin Tools" },
      { slug: "dynmap", name: "Dynmap", description: "Real-time web-based map", category: "Utility" },
      { slug: "papi", name: "PlaceholderAPI", description: "Placeholder system for plugins", category: "Library" },
    ],
    bukkit: [
      { slug: "luckperms", name: "LuckPerms", description: "Advanced permissions plugin", category: "Admin Tools" },
      { slug: "essentialsx", name: "EssentialsX", description: "Essential server commands and features", category: "Admin Tools" },
      { slug: "worldedit", name: "WorldEdit", description: "In-game map editor", category: "World Management" },
      { slug: "vault", name: "Vault", description: "Economy and permissions API", category: "Library" },
    ],
    spigot: [
      { slug: "luckperms", name: "LuckPerms", description: "Advanced permissions plugin", category: "Admin Tools" },
      { slug: "essentialsx", name: "EssentialsX", description: "Essential server commands and features", category: "Admin Tools" },
      { slug: "worldedit", name: "WorldEdit", description: "In-game map editor", category: "World Management" },
      { slug: "worldguard", name: "WorldGuard", description: "Region protection and management", category: "World Management" },
      { slug: "vault", name: "Vault", description: "Economy and permissions API", category: "Library" },
    ],
  };

  const categories = [
    { value: "all", label: "All Categories" },
    { value: "optimization", label: "Optimization" },
    { value: "utility", label: "Utility" },
    { value: "decoration", label: "Decoration" },
    { value: "worldgen", label: "World Generation" },
    { value: "technology", label: "Technology" },
    { value: "magic", label: "Magic" },
    { value: "adventure", label: "Adventure" },
    { value: "food", label: "Food" },
    { value: "mobs", label: "Mobs" },
    { value: "equipment", label: "Equipment" },
    { value: "library", label: "Library" },
  ];

  const sortOptions = [
    { value: "relevance", label: "Relevance" },
    { value: "downloads", label: "Most Downloaded" },
    { value: "follows", label: "Most Followed" },
    { value: "newest", label: "Newest" },
    { value: "updated", label: "Recently Updated" },
  ];

  useEffect(() => {
    fetchInstalledMods();
  }, []);

  useEffect(() => {
    const hasSearch = searchQuery.length > 0 || category !== "all";
    setShowPopular(!hasSearch);

    const timer = setTimeout(() => {
      if (hasSearch) {
        searchMods();
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [searchQuery, category, sortBy]);

  async function fetchInstalledMods() {
    try {
      const response = await fetch(`/api/servers/${serverName}/mods/installed`);
      const data = await response.json();
      setInstalledMods(data.mods || []);
    } catch (err) {
      console.error("Failed to fetch installed mods:", err);
    }
  }

  async function searchMods() {
    setIsSearching(true);
    try {
      const params = new URLSearchParams({
        query: searchQuery,
        mcVersion: mcVersion,
        loader: loader,
        projectType: type,
        limit: "20",
        sort: sortBy,
      });

      if (category !== "all") {
        params.set("category", category);
      }

      const response = await fetch(`/api/mods/search?${params}`);
      const data = await response.json();
      setMods(data.hits || []);
    } catch (err) {
      console.error("Search failed:", err);
      setMods([]);
    } finally {
      setIsSearching(false);
    }
  }

  async function searchModBySlug(slug: string) {
    setIsSearching(true);
    try {
      const params = new URLSearchParams({
        query: slug,
        mcVersion: mcVersion,
        loader: loader,
        limit: "1",
        sort: "relevance",
      });

      const response = await fetch(`/api/mods/search?${params}`);
      const data = await response.json();

      if (data.hits && data.hits.length > 0) {
        await selectMod(data.hits[0]);
      }
    } catch (err) {
      console.error("Failed to load mod:", err);
    } finally {
      setIsSearching(false);
    }
  }

  async function selectMod(mod: ModrinthMod) {
    setSelectedMod(mod);
    setCompatibility(null);
    setModVersions([]);

    try {
      const [versionsRes, compatRes] = await Promise.all([
        fetch(`/api/mods/${mod.project_id}/versions?mcVersion=${mcVersion}&loader=${loader}`),
        fetch('/api/mods/check-compatibility', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mod,
            serverMemoryMB,
            installedMods,
            currentMemoryUsage: 0,
          }),
        }),
      ]);

      const versions = await versionsRes.json();
      const compat = await compatRes.json();

      setModVersions(versions);
      setCompatibility(compat);
    } catch (err) {
      console.error("Failed to load mod details:", err);
    }
  }

  async function installMod(version: ModrinthVersion) {
    if (!selectedMod) return;

    setIsInstalling(true);
    setMessage("");

    try {
      const primaryFile = version.files.find(f => f.primary) || version.files[0];

      const response = await fetch(`/api/servers/${serverName}/mods/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('ADMIN_TOKEN')}`,
        },
        body: JSON.stringify({
          projectId: selectedMod.project_id,
          versionId: version.id,
          downloadUrl: primaryFile.url,
          fileName: primaryFile.filename,
        }),
      });

      const result = await response.json();

      if (response.ok) {
        setMessage(`Successfully installed ${selectedMod.title}. Restart server to load the mod.`);
        setSelectedMod(null);
        await fetchInstalledMods();
        if (onInstall) onInstall();
      } else {
        setMessage(`Installation failed: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      setMessage(`Installation failed: ${err}`);
    } finally {
      setIsInstalling(false);
    }
  }

  function getResourceImpactColor(impact: string) {
    switch (impact) {
      case 'light': return 'bg-green-500';
      case 'medium': return 'bg-yellow-500';
      case 'heavy': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  }

  function formatDownloads(count: number): string {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
  }

  return (
    <div className="space-y-4">
      {message && (
        <div className="p-3 bg-primary/10 border border-primary/20 rounded-lg text-sm">
          {message}
        </div>
      )}

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
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-48 rounded-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {categories.map(cat => (
              <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className="w-48 rounded-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="text-sm text-muted-foreground">
        Showing mods compatible with {mcVersion} ({loader})
      </div>

      {showPopular ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Popular & Recommended Mods</h3>
            <Badge variant="outline">Quick Install</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            These are the most popular and commonly used mods for {loader}. Click any mod to see details and install.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto">
            {popularMods[loader].map((mod) => (
              <Card
                key={mod.slug}
                className="rounded-sm cursor-pointer hover:border-primary transition-colors"
                onClick={() => searchModBySlug(mod.slug)}
              >
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{mod.name}</CardTitle>
                  <CardDescription className="text-xs">{mod.category}</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="text-xs text-muted-foreground">
                    {mod.description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
          <Separator />
          <p className="text-xs text-center text-muted-foreground">
            Use the search bar above to find thousands more mods from Modrinth
          </p>
        </div>
      ) : isSearching ? (
        <div className="py-12 text-center text-muted-foreground">
          Searching...
        </div>
      ) : mods.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          No mods found. Try different search terms.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto">
          {mods.map((mod) => (
            <Card
              key={mod.project_id}
              className="rounded-sm cursor-pointer hover:border-primary transition-colors"
              onClick={() => selectMod(mod)}
            >
              <CardHeader className="pb-3">
                <div className="flex gap-3">
                  {mod.icon_url && (
                    <img src={mod.icon_url} alt={mod.title} className="w-12 h-12 rounded object-cover" />
                  )}
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base truncate">{mod.title}</CardTitle>
                    <CardDescription className="text-xs truncate">by {mod.author}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                  {mod.description}
                </p>
                <div className="flex gap-2 flex-wrap">
                  <Badge variant="secondary" className="text-xs">
                    {formatDownloads(mod.downloads)} downloads
                  </Badge>
                  {mod.server_side === 'required' && (
                    <Badge className="bg-blue-500 text-xs">Server-side</Badge>
                  )}
                  {mod.client_side === 'required' && mod.server_side === 'optional' && (
                    <Badge variant="outline" className="text-xs">Requires client</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!selectedMod} onOpenChange={(open) => !open && setSelectedMod(null)}>
        <DialogContent className="rounded-sm max-w-2xl max-h-[85vh] overflow-y-auto">
          {selectedMod && (
            <>
              <DialogHeader>
                <div className="flex items-start gap-3">
                  {selectedMod.icon_url && (
                    <img src={selectedMod.icon_url} alt={selectedMod.title} className="w-16 h-16 rounded" />
                  )}
                  <div className="flex-1">
                    <DialogTitle className="text-xl">{selectedMod.title}</DialogTitle>
                    <DialogDescription>by {selectedMod.author}</DialogDescription>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSelectedMod(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </DialogHeader>

              <div className="space-y-4">
                <div>
                  <p className="text-sm">{selectedMod.description}</p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {selectedMod.categories.map(cat => (
                    <Badge key={cat} variant="secondary" className="text-xs">{cat}</Badge>
                  ))}
                </div>

                <Separator />

                {compatibility && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <div className={`w-3 h-3 rounded-full ${getResourceImpactColor(compatibility.resourceImpact)}`} />
                      <span className="text-sm font-semibold">
                        {compatibility.resourceImpact.toUpperCase()} Resource Impact
                      </span>
                      <span className="text-xs text-muted-foreground">
                        (~{compatibility.estimatedMemoryMB}MB RAM)
                      </span>
                    </div>

                    {!compatibility.compatible && (
                      <div className="flex gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                        <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                        <div className="text-sm">
                          <p className="font-semibold">Incompatible</p>
                          <p className="text-xs text-muted-foreground">This mod cannot be installed on the server</p>
                        </div>
                      </div>
                    )}

                    {compatibility.warnings.length > 0 && (
                      <div className="space-y-2">
                        {compatibility.warnings.map((warning, idx) => (
                          <div key={idx} className="flex gap-2 p-2 bg-yellow-500/10 border border-yellow-500/20 rounded text-xs">
                            <Info className="h-3 w-3 text-yellow-500 flex-shrink-0 mt-0.5" />
                            <span>{warning}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {compatibility.conflicts.length > 0 && (
                      <div className="space-y-2">
                        {compatibility.conflicts.map((conflict, idx) => (
                          <div key={idx} className="flex gap-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs">
                            <AlertTriangle className="h-3 w-3 text-red-500 flex-shrink-0 mt-0.5" />
                            <span>{conflict}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {!compatibility.resourceAvailable && compatibility.resourceWarning && (
                      <div className="flex gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                        <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                        <div className="text-sm">
                          <p className="font-semibold">Insufficient Resources</p>
                          <p className="text-xs text-muted-foreground">{compatibility.resourceWarning}</p>
                        </div>
                      </div>
                    )}

                    {compatibility.resourceAvailable && compatibility.compatible && compatibility.warnings.length === 0 && compatibility.conflicts.length === 0 && (
                      <div className="flex gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                        <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
                        <div className="text-sm">
                          <p className="font-semibold">Compatible</p>
                          <p className="text-xs text-muted-foreground">This mod is safe to install</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <Separator />

                {modVersions.length > 0 ? (
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold">Available Versions</h3>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {modVersions.map((version) => (
                        <div key={version.id} className="flex items-center justify-between p-3 border rounded-lg">
                          <div className="flex-1">
                            <p className="text-sm font-semibold">{version.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {version.version_number} · {version.game_versions.join(', ')}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            onClick={() => installMod(version)}
                            disabled={!compatibility?.compatible || !compatibility?.resourceAvailable || isInstalling}
                            className="rounded-sm"
                          >
                            <Download className="h-3 w-3 mr-1" />
                            {isInstalling ? "Installing..." : "Install"}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    No compatible versions found for {mcVersion}
                  </div>
                )}

                <div className="flex gap-2 text-xs">
                  <a
                    href={`https://modrinth.com/mod/${selectedMod.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-primary hover:underline"
                  >
                    View on Modrinth <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
