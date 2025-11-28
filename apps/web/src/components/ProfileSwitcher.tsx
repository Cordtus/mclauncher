import { useState, useEffect } from "react";
import { Server, Package2, Blocks, Box, Hammer, Download, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ProfileType = "paper" | "fabric" | "forge" | "vanilla";

interface ProfileInfo {
  type: ProfileType;
  mcVersion: string;
  loaderVersion?: string;
  installedAt: string;
  isActive: boolean;
}

interface ProfilesData {
  active: ProfileType;
  profiles: Record<ProfileType, ProfileInfo | null>;
}

interface ProfileSwitcherProps {
  serverName: string;
  currentMcVersion: string;
  onProfileChange?: () => void;
}

const profileMeta: Record<ProfileType, { name: string; icon: typeof Server; description: string; color: string }> = {
  paper: {
    name: "Paper",
    icon: Server,
    description: "High-performance plugin server",
    color: "bg-blue-500",
  },
  fabric: {
    name: "Fabric",
    icon: Blocks,
    description: "Lightweight mod loader",
    color: "bg-amber-500",
  },
  forge: {
    name: "Forge",
    icon: Hammer,
    description: "Classic mod loader",
    color: "bg-orange-500",
  },
  vanilla: {
    name: "Vanilla",
    icon: Box,
    description: "Official Mojang server",
    color: "bg-green-500",
  },
};

export function ProfileSwitcher({ serverName, currentMcVersion, onProfileChange }: ProfileSwitcherProps) {
  const [profilesData, setProfilesData] = useState<ProfilesData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSwitching, setIsSwitching] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [installType, setInstallType] = useState<ProfileType | null>(null);
  const [installVersion, setInstallVersion] = useState<string>("");
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    loadProfiles();
  }, [serverName]);

  async function loadProfiles() {
    try {
      const response = await fetch(`/api/servers/${serverName}/profiles`);
      if (response.ok) {
        const data = await response.json();
        setProfilesData(data);
      }
    } catch (err) {
      console.error("Failed to load profiles:", err);
    } finally {
      setIsLoading(false);
    }
  }

  async function switchProfile(profileType: ProfileType) {
    if (profilesData?.active === profileType) return;

    setIsSwitching(true);
    setMessage("");

    try {
      const response = await fetch(`/api/servers/${serverName}/profiles/${profileType}/switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('ADMIN_TOKEN')}`,
        },
      });

      if (response.ok) {
        setMessage(`Switched to ${profileMeta[profileType].name}. Server is restarting...`);
        await loadProfiles();
        if (onProfileChange) onProfileChange();
      } else {
        const error = await response.json();
        setMessage(`Failed to switch: ${error.error}`);
      }
    } catch (err) {
      setMessage(`Failed to switch: ${err}`);
    } finally {
      setIsSwitching(false);
    }
  }

  async function openInstallDialog(profileType: ProfileType) {
    setInstallType(profileType);
    setInstallVersion("");
    setAvailableVersions([]);
    setInstallDialogOpen(true);

    try {
      const response = await fetch(`/api/servers/${serverName}/profiles/${profileType}/versions`);
      if (response.ok) {
        const data = await response.json();
        setAvailableVersions(data.versions || []);
        // Default to current MC version if available
        if (data.versions?.includes(currentMcVersion)) {
          setInstallVersion(currentMcVersion);
        } else if (data.versions?.length > 0) {
          setInstallVersion(data.versions[0]);
        }
      }
    } catch (err) {
      console.error("Failed to load versions:", err);
    }
  }

  async function installProfile() {
    if (!installType || !installVersion) return;

    setIsInstalling(true);
    setMessage("");

    try {
      const response = await fetch(`/api/servers/${serverName}/profiles/${installType}/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('ADMIN_TOKEN')}`,
        },
        body: JSON.stringify({ mcVersion: installVersion }),
      });

      if (response.ok) {
        setMessage(`${profileMeta[installType].name} profile installed!`);
        setInstallDialogOpen(false);
        await loadProfiles();
      } else {
        const error = await response.json();
        setMessage(`Failed to install: ${error.error}`);
      }
    } catch (err) {
      setMessage(`Failed to install: ${err}`);
    } finally {
      setIsInstalling(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const profileTypes: ProfileType[] = ["paper", "fabric", "forge", "vanilla"];

  return (
    <div className="space-y-4">
      {message && (
        <div className={`p-3 rounded-lg text-sm ${
          message.includes('Failed')
            ? 'bg-destructive/10 border border-destructive/20'
            : 'bg-primary/10 border border-primary/20'
        }`}>
          {message}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Server Profiles</h2>
          <p className="text-sm text-muted-foreground">
            Switch between different server types instantly
          </p>
        </div>
        {profilesData && (
          <Badge variant="outline" className="text-sm">
            Active: {profileMeta[profilesData.active].name}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {profileTypes.map((type) => {
          const meta = profileMeta[type];
          const Icon = meta.icon;
          const profile = profilesData?.profiles[type];
          const isActive = profilesData?.active === type;
          const isInstalled = profile !== null;

          return (
            <Card
              key={type}
              className={`rounded-sm transition-all ${
                isActive
                  ? 'border-primary ring-2 ring-primary/20'
                  : isInstalled
                    ? 'hover:border-primary/50 cursor-pointer'
                    : 'opacity-60'
              }`}
              onClick={() => isInstalled && !isActive && !isSwitching && switchProfile(type)}
            >
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-center justify-between">
                  <div className={`p-2 rounded-md ${meta.color}`}>
                    <Icon className="h-4 w-4 text-white" />
                  </div>
                  {isActive && (
                    <Badge className="bg-green-500 text-xs">Active</Badge>
                  )}
                </div>
                <CardTitle className="text-base mt-2">{meta.name}</CardTitle>
                <CardDescription className="text-xs">{meta.description}</CardDescription>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {isInstalled ? (
                  <div className="space-y-2">
                    <div className="text-xs text-muted-foreground">
                      MC {profile.mcVersion}
                    </div>
                    {!isActive && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full rounded-sm text-xs"
                        disabled={isSwitching}
                        onClick={(e) => {
                          e.stopPropagation();
                          switchProfile(type);
                        }}
                      >
                        {isSwitching ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <Check className="h-3 w-3 mr-1" />
                        )}
                        Switch
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full rounded-sm text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      openInstallDialog(type);
                    }}
                  >
                    <Download className="h-3 w-3 mr-1" />
                    Install
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="p-4 bg-muted/50 rounded-lg">
        <h3 className="text-sm font-semibold mb-2">How it works</h3>
        <ul className="text-xs text-muted-foreground space-y-1">
          <li>- Each profile has its own server JAR and mods/plugins folder</li>
          <li>- World data, settings, and player data are shared across profiles</li>
          <li>- Switching profiles takes ~10 seconds (server restart)</li>
          <li>- Install mods/plugins for any profile, even when not active</li>
        </ul>
      </div>

      <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle>
              Install {installType && profileMeta[installType].name} Profile
            </DialogTitle>
            <DialogDescription>
              Choose the Minecraft version for this profile
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Minecraft Version</label>
              <Select value={installVersion} onValueChange={setInstallVersion}>
                <SelectTrigger className="rounded-sm">
                  <SelectValue placeholder="Select version..." />
                </SelectTrigger>
                <SelectContent>
                  {availableVersions.slice(0, 20).map((version) => (
                    <SelectItem key={version} value={version}>
                      {version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInstallDialogOpen(false)}
              className="rounded-sm"
            >
              Cancel
            </Button>
            <Button
              onClick={installProfile}
              disabled={!installVersion || isInstalling}
              className="rounded-sm"
            >
              {isInstalling ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Installing...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  Install
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
