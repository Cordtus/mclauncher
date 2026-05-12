import { useState } from "react";
import { Download, FileText, Globe, Copy, Check, ExternalLink, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";

interface ModpackExportProps {
  serverName: string;
  mcVersion: string;
  loader: string;
  modsCount: number;
  apiBaseUrl?: string;
  publicAddress?: string;
}

export function ModpackExport({
  serverName,
  mcVersion,
  loader,
  modsCount,
  apiBaseUrl = '',
  publicAddress,
}: ModpackExportProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const gatewayOrigin = apiBaseUrl || window.location.origin;
  const encodedServerName = encodeURIComponent(serverName);
  const hasPublicAddress = Boolean(publicAddress);
  const publicUrl = `${gatewayOrigin}/public/${encodedServerName}/modpack`;
  const connectionAddress = publicAddress || "the configured public server address";
  const mrpackUrl = `${gatewayOrigin}/public/${encodedServerName}/modpack.mrpack`;
  const modlistUrl = `${gatewayOrigin}/public/${encodedServerName}/modlist.txt`;

  async function copyPublicLink() {
    if (!hasPublicAddress) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  function downloadMrpack() {
    if (!hasPublicAddress) return;
    window.location.href = mrpackUrl;
  }

  function downloadModlist() {
    if (!hasPublicAddress) return;
    window.location.href = modlistUrl;
  }

  function openPublicPage() {
    if (!hasPublicAddress) return;
    window.open(publicUrl, '_blank');
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="rounded-sm">
          <Share2 className="h-4 w-4 mr-2" />
          Share Modpack
        </Button>
      </DialogTrigger>
      <DialogContent className="rounded-sm max-w-2xl">
        <DialogHeader>
          <DialogTitle>Share Modpack with Players</DialogTitle>
          <DialogDescription>
            Generate downloadable modpacks or share a link so players can easily install the required mods
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-4 p-4 bg-muted/50 rounded-lg">
            <div className="flex-1">
              <div className="font-semibold">{serverName}</div>
              <div className="text-sm text-muted-foreground">
                Minecraft {mcVersion} - {loader} - {modsCount} mods
              </div>
            </div>
            <Badge variant="outline">{loader}</Badge>
          </div>

          <Separator />

          <div className="space-y-3">
            <h3 className="font-semibold text-sm">Public Download Page</h3>
            <p className="text-sm text-muted-foreground">
              {hasPublicAddress
                ? `Share this link when the gateway exposes public modpack pages. Players connect to ${connectionAddress}.`
                : "Configure a public server address before sharing player download links."}
            </p>
            <div className="flex gap-2">
              <div className="flex-1 px-3 py-2 bg-muted rounded-md text-sm font-mono truncate">
                {hasPublicAddress ? publicUrl : "Public address not configured"}
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={copyPublicLink}
                disabled={!hasPublicAddress}
                className="rounded-sm shrink-0"
              >
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={openPublicPage}
                disabled={!hasPublicAddress}
                className="rounded-sm shrink-0"
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <h3 className="font-semibold text-sm">Direct Downloads</h3>
            <p className="text-sm text-muted-foreground">
              Download modpack files directly from the admin panel
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <Card className="rounded-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Download className="h-4 w-4" />
                    Modrinth Modpack
                  </CardTitle>
                  <CardDescription className="text-xs">
                    .mrpack file - Compatible with Prism Launcher, ATLauncher, and more
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  <Button
                    onClick={downloadMrpack}
                    disabled={!hasPublicAddress}
                    className="w-full rounded-sm"
                    size="sm"
                  >
                    Download .mrpack
                  </Button>
                </CardContent>
              </Card>

              <Card className="rounded-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Mod List
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Plain text list of all mods with installation instructions
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  <Button
                    onClick={downloadModlist}
                    variant="secondary"
                    disabled={!hasPublicAddress}
                    className="w-full rounded-sm"
                    size="sm"
                  >
                    Download .txt
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>

          <Separator />

          <div className="space-y-2 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Player Instructions
            </h3>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Download and install <strong>Prism Launcher</strong> (free, open source)</li>
              <li>Download the .mrpack file from the link above</li>
              <li>In Prism: Add Instance → Import → Select the .mrpack file</li>
              <li>Launch and connect to <strong>{connectionAddress}</strong></li>
            </ol>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
