import { useState } from "react";
import { Settings, Trash2, Power, PowerOff, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";

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

interface InstalledModCardProps {
  mod: InstalledMod;
  serverName: string;
  onToggle: (fileName: string, enabled: boolean) => Promise<void>;
  onRemove: (fileName: string, removeConfigs: boolean) => Promise<void>;
  onConfigure: (modId: string) => void;
  onUpdate?: (mod: InstalledMod) => void;
}

export function InstalledModCard({
  mod,
  serverName,
  onToggle,
  onRemove,
  onConfigure,
  onUpdate,
}: InstalledModCardProps) {
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  const [isToggling, setIsToggling] = useState(false);

  async function handleToggle(checked: boolean) {
    setIsToggling(true);
    try {
      await onToggle(mod.fileName, checked);
    } finally {
      setIsToggling(false);
    }
  }

  async function handleRemove(removeConfigs: boolean) {
    await onRemove(mod.fileName, removeConfigs);
    setShowRemoveDialog(false);
  }

  const iconUrl = `/api/servers/${serverName}/mods/${encodeURIComponent(mod.fileName)}/icon`;

  return (
    <>
      <Card className="rounded-sm">
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0">
              <img
                src={iconUrl}
                alt={mod.name}
                className="w-16 h-16 rounded object-cover bg-muted"
                onError={(e) => {
                  // Fallback to placeholder
                  e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="%23334155"/><text x="50%" y="50%" font-size="32" text-anchor="middle" dy=".3em" fill="%239ca3af">?</text></svg>';
                }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{mod.name}</CardTitle>
                  <CardDescription className="text-xs mt-0.5">
                    v{mod.version} · {mod.loader}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={mod.enabled}
                    onCheckedChange={handleToggle}
                    disabled={isToggling}
                    className="data-[state=checked]:bg-green-500"
                  />
                  <Badge variant={mod.enabled ? "default" : "secondary"} className="text-xs">
                    {mod.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {mod.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
              {mod.description}
            </p>
          )}

          {mod.authors && mod.authors.length > 0 && (
            <p className="text-xs text-muted-foreground mb-3">
              by {mod.authors.join(", ")}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onConfigure(mod.modId)}
              className="rounded-sm flex-1"
            >
              <Settings className="h-3 w-3 mr-1" />
              Configure
            </Button>

            {onUpdate && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onUpdate(mod)}
                className="rounded-sm"
              >
                <Download className="h-3 w-3 mr-1" />
                Update
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRemoveDialog(true)}
              className="rounded-sm text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showRemoveDialog} onOpenChange={setShowRemoveDialog}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {mod.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the mod file from the server. Do you want to also remove the mod's configuration files?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleRemove(false)}
              className="rounded-sm"
            >
              Remove mod only
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => handleRemove(true)}
              className="rounded-sm bg-destructive hover:bg-destructive/90"
            >
              Remove mod + configs
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
