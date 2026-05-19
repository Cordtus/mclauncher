import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  DatabaseBackup,
  Download,
  ExternalLink,
  FilePlus,
  Fingerprint,
  Globe,
  HardDrive,
  HelpCircle,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  Map as MapIcon,
  Package,
  Package2,
  Play,
  Plus,
  RotateCw,
  Server,
  Settings,
  Shield,
  Square,
  Terminal,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { ModBrowser } from "@/components/ModBrowser";
import { ModsManagementPanel } from "@/components/ModsManagementPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api-client";
import { loginWithAdminToken, loginWithDevAdmin, readAdminSession } from "@/lib/auth";
import {
  buildPlayerInviteText,
  formatMinecraftAddress,
  getHostProxyPort,
  getLocalJoinAddress,
  getPublicJoinAddress,
  isDefaultMinecraftPort,
  requiresClientMods,
} from "@/lib/minecraft";
import {
  deletePasskeyRegistrationCode,
  listPasskeyRegistrationCodes,
  loginWithPasskey,
  logoutPasskeySession,
  passkeysAvailable,
  registerPasskey,
  type PasskeyRegistrationCode,
} from "@/lib/passkeys";
import type {
  AuthConfig,
  BansResponse,
  CreateServerInput,
  InstalledPlugin,
  LifecycleState,
  PublicServerRow,
  PublicAccessState,
  ServerArchive,
  ServerRow,
  ServerSettingsDraft,
  ServerSettingsResponse,
  WorldInfo,
} from "@/types";

type Route =
  | { page: "fleet" }
  | { page: "archives" }
  | { page: "admin" }
  | { page: "server"; name: string; tab: WorkspaceTab }
  | { page: "public"; name?: string };

type WorkspaceTab = "overview" | "players" | "content" | "worlds" | "settings";

const workspaceTabs: Array<{ value: WorkspaceTab; label: string; icon: typeof Activity }> = [
  { value: "overview", label: "Overview", icon: Activity },
  { value: "players", label: "Players", icon: Users },
  { value: "content", label: "Content", icon: Package },
  { value: "worlds", label: "Worlds", icon: MapIcon },
  { value: "settings", label: "Settings", icon: Settings },
];

const MAX_LOG_LINES = 120;

const defaultSettings: ServerSettingsDraft = {
  hostIp: "",
  publicDomain: "",
  publicPort: 25565,
  hostProxyPort: 25565,
  motd: "A Minecraft Server",
  maxPlayers: 20,
  gamemode: "survival",
  difficulty: "normal",
  pvp: true,
  spawnProtection: 16,
  viewDistance: 10,
  onlineMode: true,
  allowFlight: false,
  enforceWhitelist: false,
  whitelist: [],
  operators: [],
  bannedPlayers: [],
  bannedIps: [],
  jvmXms: 512,
  jvmXmsUnit: "M",
  jvmXmx: 2048,
  jvmXmxUnit: "M",
  jvmGc: "default",
  jvmCustomFlags: "",
};

function parseRoute(pathname = window.location.pathname): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "archives") return { page: "archives" };
  if (parts[0] === "admin") return { page: "admin" };
  if (parts[0] === "public") return { page: "public", name: parts[1] ? decodeURIComponent(parts[1]) : undefined };
  if (parts[0] === "server" && parts[1]) {
    const tab = (parts[2] || "overview") as WorkspaceTab;
    return {
      page: "server",
      name: decodeURIComponent(parts[1]),
      tab: workspaceTabs.some((entry) => entry.value === tab) ? tab : "overview",
    };
  }
  return { page: "fleet" };
}

function pathFor(route: Route) {
  if (route.page === "archives") return "/archives";
  if (route.page === "admin") return "/admin";
  if (route.page === "public") return route.name ? `/public/${encodeURIComponent(route.name)}` : "/public";
  if (route.page === "server") {
    const base = `/server/${encodeURIComponent(route.name)}`;
    return route.tab === "overview" ? base : `${base}/${route.tab}`;
  }
  return "/";
}

function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute());

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = pathFor(next);
    window.history.pushState(null, "", path);
    setRoute(next);
  }, []);

  return { route, navigate };
}

function isAuthBlocked(error: unknown) {
  return error instanceof ApiError && [401, 403, 503].includes(error.status);
}

async function copyToClipboard(text: string) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  } catch {
    return false;
  }
}

function toBool(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
}

function toNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function readTpsValue(data: { raw?: unknown; tps?: unknown } | null | undefined) {
  const direct = toNullableNumber(data?.tps);
  if (direct !== null) return direct;

  const raw = typeof data?.raw === "string" ? data.raw : "";
  const paperMatch = raw.match(/TPS from last[^:]*:\s*(\d+(?:\.\d+)?)/i);
  const forgeMatch = raw.match(/Mean TPS:\s*(\d+(?:\.\d+)?)/i);
  return toNullableNumber((paperMatch || forgeMatch)?.[1]);
}

function formatTps(value: number | null) {
  return value === null ? "N/A" : value.toFixed(1);
}

function statusVariant(status: string) {
  const lower = status.toLowerCase();
  if (lower.includes("running")) return "default";
  if (lower.includes("stopped")) return "secondary";
  return "destructive";
}

function serverSupportsPlugins(server: ServerRow) {
  return ["paper", "purpur", "spigot"].includes(server.edition.toLowerCase());
}

function serverSupportsMods(server: ServerRow) {
  return ["forge", "neoforge", "fabric"].includes(server.edition.toLowerCase());
}

export function App() {
  const { route, navigate } = useRoute();
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [lifecycle, setLifecycle] = useState<LifecycleState | null>(null);
  const [serverInventoryBlocked, setServerInventoryBlocked] = useState(false);
  const [liveStatus, setLiveStatus] = useState<"checking" | "live" | "syncing" | "locked">("checking");
  const [globalMessage, setGlobalMessage] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);

  const loadAuthConfig = useCallback(async () => {
    try {
      setAuthConfig(await api.getAuthConfig());
    } catch {
      setAuthConfig(null);
    }
  }, []);

  const checkSession = useCallback(async () => {
    const authenticated = await readAdminSession();
    setIsAdminAuthenticated(authenticated);
    if (authenticated) {
      setServerInventoryBlocked(false);
      setGlobalMessage("");
      setLiveStatus("checking");
    } else {
      setServers([]);
      setLifecycle(null);
      setServerInventoryBlocked(true);
      setGlobalMessage("Sign in to manage servers.");
      setLiveStatus("locked");
    }
    setAuthReady(true);
  }, []);

  const refresh = useCallback(async () => {
    if (route.page === "public") return;
    try {
      const serverData = await api.getServers();
      setServers(Array.isArray(serverData) ? serverData : []);
      setIsAdminAuthenticated(true);
      setServerInventoryBlocked(false);
      setGlobalMessage("");
      try {
        setLifecycle(await api.getLifecycle());
      } catch {
        setLifecycle(null);
      }
    } catch (error) {
      if (isAuthBlocked(error)) {
        setServers([]);
        setLifecycle(null);
        setIsAdminAuthenticated(false);
        setServerInventoryBlocked(true);
        setLiveStatus("locked");
        setGlobalMessage("Sign in to manage servers.");
      } else {
        setGlobalMessage(error instanceof Error ? error.message : "Failed to fetch servers");
      }
    }
  }, [route.page]);

  useEffect(() => {
    localStorage.removeItem("ADMIN_TOKEN");
    localStorage.removeItem("ADMIN_SESSION");
    void loadAuthConfig();
    void checkSession();
  }, [checkSession, loadAuthConfig]);

  useEffect(() => {
    if (route.page === "public") return;
    if (!authReady || !isAdminAuthenticated) return;
    void refresh();
  }, [authReady, isAdminAuthenticated, refresh, route.page]);

  useEffect(() => {
    if (route.page === "public") return;
    if (!authReady || !isAdminAuthenticated) {
      setLiveStatus("locked");
      return;
    }

    let fallbackInterval: number | undefined;
    let fallbackTimer: number | undefined;
    let source: EventSource | null = null;

    const stopFallback = () => {
      if (fallbackInterval) {
        window.clearInterval(fallbackInterval);
        fallbackInterval = undefined;
      }
      if (fallbackTimer) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
    };

    const startFallback = () => {
      if (fallbackInterval) return;
      setLiveStatus("syncing");
      void refresh();
      fallbackInterval = window.setInterval(() => void refresh(), 10000);
    };

    if ("EventSource" in window) {
      setLiveStatus("checking");
      fallbackTimer = window.setTimeout(startFallback, 12000);
      source = api.subscribeServerEvents(
        (state) => {
          stopFallback();
          setServers(Array.isArray(state.servers) ? state.servers : []);
          setLifecycle(state.lifecycle || null);
          setIsAdminAuthenticated(true);
          setServerInventoryBlocked(false);
          setGlobalMessage("");
          setLiveStatus("live");
        },
        () => startFallback()
      );
    } else {
      startFallback();
    }

    return () => {
      source?.close();
      stopFallback();
    };
  }, [authReady, isAdminAuthenticated, refresh, route.page]);

  const handleSignedIn = useCallback(async () => {
    await loadAuthConfig();
    await checkSession();
    await refresh();
  }, [checkSession, loadAuthConfig, refresh]);

  const handleSignOut = useCallback(async () => {
    try {
      await logoutPasskeySession();
    } catch {
      // UI state is still cleared below.
    }
    localStorage.removeItem("ADMIN_TOKEN");
    localStorage.removeItem("ADMIN_SESSION");
    setIsAdminAuthenticated(false);
    setServers([]);
    setLifecycle(null);
    setServerInventoryBlocked(true);
    setLiveStatus("locked");
    setGlobalMessage("Sign in to manage servers.");
    toast.success("Signed out");
    navigate({ page: "admin" });
  }, [navigate]);

  if (route.page === "public") {
    return (
      <PublicServersPage
        serverName={route.name}
        onPublicHome={() => navigate({ page: "public" })}
        onAdminAccess={() => navigate({ page: "admin" })}
      />
    );
  }

  if (authReady && !isAdminAuthenticated && route.page === "fleet") {
    return (
      <PublicServersPage
        onPublicHome={() => navigate({ page: "public" })}
        onAdminAccess={() => navigate({ page: "admin" })}
      />
    );
  }

  return (
    <TooltipProvider>
      <div className="h-screen overflow-hidden bg-black text-slate-100 antialiased">
        <div className="flex h-full">
          <AppSidebar
            route={route}
            isAuthenticated={isAdminAuthenticated}
            liveStatus={liveStatus}
            onNavigate={navigate}
            onSignOut={handleSignOut}
            onHelp={() => setHelpOpen(true)}
          />
          <main className="min-w-0 flex-1 overflow-auto bg-[#050505]">
            <AdminMobileBar
              route={route}
              isAuthenticated={isAdminAuthenticated}
              onNavigate={navigate}
              onSignOut={handleSignOut}
              onHelp={() => setHelpOpen(true)}
            />
            {globalMessage && route.page !== "admin" && (
              <div className="border-b border-[#1a1a1a] bg-black px-4 py-3 text-xs font-bold uppercase tracking-[0.16em] text-neutral-500 lg:px-8">
                {globalMessage}
              </div>
            )}
            <div className="mx-auto max-w-7xl px-4 py-8 lg:px-10">
              {route.page === "admin" ? (
                <AdminAccessPage
                  authConfig={authConfig}
                  isAuthenticated={isAdminAuthenticated}
                  onSignedIn={handleSignedIn}
                  onSignOut={handleSignOut}
                />
              ) : !authReady ? (
                <LoadingState label="Checking admin session..." />
              ) : serverInventoryBlocked ? (
                <LockedState onUnlock={() => navigate({ page: "admin" })} />
              ) : route.page === "archives" ? (
                <ArchivePage lifecycle={lifecycle} onRefresh={refresh} />
              ) : route.page === "server" ? (
                <ServerWorkspacePage
                  route={route}
                  servers={servers}
                  lifecycle={lifecycle}
                  onNavigate={navigate}
                  onRefresh={refresh}
                />
              ) : (
                <FleetPage
                  servers={servers}
                  lifecycle={lifecycle}
                  onNavigate={navigate}
                  onRefresh={refresh}
                />
              )}
            </div>
          </main>
        </div>

        <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      </div>
    </TooltipProvider>
  );
}

function AppSidebar({
  route,
  isAuthenticated,
  liveStatus,
  onNavigate,
  onSignOut,
  onHelp,
}: {
  route: Route;
  isAuthenticated: boolean;
  liveStatus: "checking" | "live" | "syncing" | "locked";
  onNavigate: (route: Route) => void;
  onSignOut: () => void;
  onHelp: () => void;
}) {
  const liveLabel = liveStatus === "live"
    ? "Live server updates"
    : liveStatus === "syncing"
      ? "Syncing server state"
      : liveStatus === "locked"
        ? "Sign in required"
        : "Checking server state";

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-[#1a1a1a] bg-black lg:flex">
      <div className="flex h-24 items-center border-b border-[#1a1a1a] px-8">
        <button type="button" onClick={() => onNavigate({ page: "fleet" })} className="flex items-center gap-3 text-left">
          <div className="h-3 w-3 bg-brand-primary shadow-[0_0_12px_rgba(190,242,100,0.45)]" />
          <div>
            <p className="font-display text-xl font-extrabold uppercase tracking-tight text-white">Server</p>
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.25em] text-neutral-700">Portal</p>
          </div>
        </button>
      </div>

      <nav className="no-scrollbar flex-1 space-y-8 overflow-y-auto p-6">
        <div>
          <h4 className="mb-4 px-4 text-[10px] font-bold uppercase tracking-[0.22em] text-neutral-700">
            Servers
          </h4>
          <div className="space-y-1">
            <SidebarButton
              active={route.page === "fleet"}
              icon={LayoutDashboard}
              label="Servers"
              onClick={() => onNavigate({ page: "fleet" })}
            />
            <SidebarButton
              active={route.page === "archives"}
              icon={Archive}
              label="Saved Servers"
              onClick={() => onNavigate({ page: "archives" })}
            />
          </div>
        </div>

        <div>
          <h4 className="mb-4 px-4 text-[10px] font-bold uppercase tracking-[0.22em] text-neutral-700">
            Account
          </h4>
          <div className="space-y-1">
            <SidebarButton
              active={route.page === "admin"}
              icon={KeyRound}
              label={isAuthenticated ? "Signed In" : "Admin Login"}
              onClick={() => onNavigate({ page: "admin" })}
            />
            <SidebarButton active={false} icon={HelpCircle} label="Help" onClick={onHelp} />
          </div>
        </div>
      </nav>

      <div className="space-y-3 border-t border-[#1a1a1a] p-6">
        <div className="flex items-center gap-3 border border-[#1f1f1f] bg-[#0a0a0a] px-4 py-3 text-neutral-500">
          <div className={`status-square ${liveStatus === "live" ? "bg-brand-primary shadow-[0_0_10px_rgba(190,242,100,0.85)]" : ""}`} />
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-600">Server State</p>
            <p className="mt-1 text-xs font-bold uppercase tracking-[0.12em] text-neutral-400">{liveLabel}</p>
          </div>
        </div>
        {isAuthenticated && (
          <Button
            variant="ghost"
            className="control-button w-full justify-start text-rose-500 hover:bg-rose-500/10 hover:text-rose-400"
            onClick={onSignOut}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign Out
          </Button>
        )}
      </div>
    </aside>
  );
}

function AdminMobileBar({
  route,
  isAuthenticated,
  onNavigate,
  onSignOut,
  onHelp,
}: {
  route: Route;
  isAuthenticated: boolean;
  onNavigate: (route: Route) => void;
  onSignOut: () => void;
  onHelp: () => void;
}) {
  return (
    <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-[#1a1a1a] bg-black/95 px-3 py-3 backdrop-blur lg:hidden">
      <button
        type="button"
        onClick={() => onNavigate({ page: "fleet" })}
        className="mr-auto flex items-center gap-2 text-left"
      >
        <div className="h-3 w-3 bg-brand-primary" />
        <span className="text-xs font-black uppercase tracking-[0.16em] text-white">Server Portal</span>
      </button>
      <Button
        variant={route.page === "fleet" || route.page === "server" ? "default" : "ghost"}
        size="icon"
        className="h-9 w-9 rounded-sm"
        onClick={() => onNavigate({ page: "fleet" })}
        title="Servers"
      >
        <Server className="h-4 w-4" />
      </Button>
      <Button
        variant={route.page === "archives" ? "default" : "ghost"}
        size="icon"
        className="h-9 w-9 rounded-sm"
        onClick={() => onNavigate({ page: "archives" })}
        title="Saved Servers"
      >
        <Archive className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" className="h-9 w-9 rounded-sm" onClick={onHelp} title="Help">
        <HelpCircle className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 rounded-sm"
        onClick={isAuthenticated ? onSignOut : () => onNavigate({ page: "admin" })}
        title={isAuthenticated ? "Sign Out" : "Sign In"}
      >
        {isAuthenticated ? <LogOut className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
      </Button>
    </div>
  );
}

function SidebarButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof Server;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-4 px-4 py-3 text-xs font-bold uppercase tracking-[0.15em] transition ${
        active ? "bg-brand-primary text-black" : "text-neutral-500 hover:bg-white/5 hover:text-white"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="grid min-h-[50vh] place-items-center text-xs font-bold uppercase tracking-[0.2em] text-neutral-600">
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin text-brand-primary" />
        {label}
      </div>
    </div>
  );
}

function LockedState({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div className="grid min-h-[55vh] place-items-center">
      <div className="control-surface relative max-w-md p-10 text-center">
        <div className="absolute left-0 top-0 h-3 w-3 border-l border-t border-brand-primary" />
        <div className="absolute right-0 top-0 h-3 w-3 border-r border-t border-brand-primary" />
        <div className="absolute bottom-0 left-0 h-3 w-3 border-b border-l border-brand-primary" />
        <div className="absolute bottom-0 right-0 h-3 w-3 border-b border-r border-brand-primary" />
        <KeyRound className="mx-auto mb-5 h-10 w-10 text-brand-primary" />
        <p className="control-label text-brand-primary">Admin Login</p>
        <h1 className="mt-3 text-3xl font-black uppercase tracking-tight text-white">Admin Login Required</h1>
        <p className="mt-4 text-sm text-neutral-500">
          Sign in to manage servers, worlds, players, mods, and settings.
        </p>
        <Button className="control-button mt-8 bg-brand-primary text-black hover:bg-white" onClick={onUnlock}>
          Sign In
        </Button>
      </div>
    </div>
  );
}

function AdminAccessPage({
  authConfig,
  isAuthenticated,
  onSignedIn,
  onSignOut,
}: {
  authConfig: AuthConfig | null;
  isAuthenticated: boolean;
  onSignedIn: () => Promise<void>;
  onSignOut: () => void;
}) {
  const [adminToken, setAdminToken] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [passkeyName, setPasskeyName] = useState("Admin passkey");
  const [setupCodes, setSetupCodes] = useState<PasskeyRegistrationCode[]>([]);
  const [busy, setBusy] = useState(false);
  const passkeysEnabled = Boolean(authConfig?.passkeys?.enabled);
  const browserSupportsPasskeys = passkeysAvailable();
  const canUsePasskeys = passkeysEnabled && browserSupportsPasskeys;
  const hasPasskeys = Boolean(authConfig?.passkeys?.hasPasskeys);
  const tokenAuthEnabled = Boolean(authConfig?.authMethods?.includes("token"));
  const devLoginEnabled = Boolean(authConfig?.devLogin?.enabled);
  const registrationOpen = Boolean(
    passkeysEnabled && authConfig && (!hasPasskeys || authConfig.passkeys?.registrationCodesAvailable || isAuthenticated)
  );
  const showPasskeyActions = passkeysEnabled && ((!isAuthenticated && hasPasskeys) || isAuthenticated);
  const currentOrigin = window.location.origin;
  const configuredPasskeyOrigin = authConfig?.passkeys?.origin;
  const passkeyOriginMismatch = Boolean(configuredPasskeyOrigin && configuredPasskeyOrigin !== currentOrigin);
  const passkeyHelp = !passkeysEnabled
    ? "Passkeys are not enabled for this portal."
    : !browserSupportsPasskeys
    ? `Passkeys only work from HTTPS or localhost. This page is ${currentOrigin}.`
    : passkeyOriginMismatch
      ? `Passkeys are configured for ${configuredPasskeyOrigin}, but this page is ${currentOrigin}. Open the matching origin before signing in.`
      : null;

  const loadSetupCodes = useCallback(async () => {
    if (!isAuthenticated) {
      setSetupCodes([]);
      return;
    }
    try {
      setSetupCodes(await listPasskeyRegistrationCodes());
    } catch {
      setSetupCodes([]);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    void loadSetupCodes();
  }, [loadSetupCodes]);

  const signInWithToken = async () => {
    const token = adminToken.trim();
    if (!token) {
      toast.error("Enter an admin token");
      return;
    }
    setBusy(true);
    try {
      await loginWithAdminToken(token);
      setAdminToken("");
      toast.success("Signed in");
      await onSignedIn();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Admin token sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const signInWithPasskey = async () => {
    setBusy(true);
    try {
      await loginWithPasskey();
      toast.success("Signed in with passkey");
      await onSignedIn();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Passkey sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const signInWithDev = async () => {
    setBusy(true);
    try {
      await loginWithDevAdmin();
      toast.success("Signed in");
      await onSignedIn();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Dev sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const addPasskey = async () => {
    setBusy(true);
    try {
      await registerPasskey(passkeyName.trim() || "Admin passkey", setupCode);
      setSetupCode("");
      toast.success("Passkey registered");
      await onSignedIn();
      await loadSetupCodes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to register passkey");
    } finally {
      setBusy(false);
    }
  };

  const revokeSetupCode = async (id: string) => {
    try {
      await deletePasskeyRegistrationCode(id);
      toast.success("Setup code revoked");
      await loadSetupCodes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke setup code");
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#F27D26]">Admin</p>
        <h1 className="mt-2 text-3xl font-semibold text-white">Sign In</h1>
      </div>

      {devLoginEnabled && !isAuthenticated && (
        <section className="border border-brand-primary/30 bg-brand-primary/10 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Dev Login</h2>
              <p className="mt-1 text-sm text-[#8E9299]">Enabled by the local dev server.</p>
            </div>
            <Button onClick={signInWithDev} disabled={busy} className="rounded-sm bg-brand-primary text-black hover:bg-white">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
              Sign In
            </Button>
          </div>
        </section>
      )}

      {passkeysEnabled && (
      <section className="border border-[#2C2E33] bg-[#1C1D21] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Passkey</h2>
            <p className="mt-1 text-sm text-[#8E9299]">
              {isAuthenticated
                ? "Signed in on this browser."
                : hasPasskeys
                  ? "Use your saved passkey."
                  : "Register the first admin passkey."}
            </p>
          </div>
          <Badge variant={isAuthenticated ? "default" : "outline"} className="rounded-sm">
            {isAuthenticated ? "Signed in" : "Locked"}
          </Badge>
        </div>

        {!canUsePasskeys && (
          <div className="mt-4 border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">
            {passkeyHelp}
            {!tokenAuthEnabled && !devLoginEnabled && (
              <span className="mt-2 block text-amber-100/70">
                Token sign-in is not enabled, so this origin cannot be used for admin access.
              </span>
            )}
          </div>
        )}

        {canUsePasskeys && passkeyOriginMismatch && (
          <div className="mt-4 border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">
            {passkeyHelp}
          </div>
        )}

        {showPasskeyActions && (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {!isAuthenticated && hasPasskeys && (
              <Button onClick={signInWithPasskey} disabled={!canUsePasskeys || busy} className="rounded-sm">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Fingerprint className="mr-2 h-4 w-4" />}
                Sign In
              </Button>
            )}
            {isAuthenticated && (
              <Button variant="outline" onClick={onSignOut} className="rounded-sm">
                <LogOut className="mr-2 h-4 w-4" />
                Sign Out
              </Button>
            )}
          </div>
        )}

        {registrationOpen && (
          <div className="mt-5 space-y-4 border-t border-[#2C2E33] pt-5">
            {!isAuthenticated && (
              <div className="space-y-2">
                <Label htmlFor="setup-code">One-time setup code</Label>
                <Input
                  id="setup-code"
                  type="password"
                  value={setupCode}
                  onChange={(event) => setSetupCode(event.target.value)}
                  placeholder="Paste setup code"
                  className="rounded-sm"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="passkey-name">Passkey name</Label>
              <Input
                id="passkey-name"
                value={passkeyName}
                onChange={(event) => setPasskeyName(event.target.value)}
                className="rounded-sm"
              />
            </div>
            <Button
              onClick={addPasskey}
              disabled={!canUsePasskeys || busy || (!isAuthenticated && !setupCode.trim())}
              className="w-full rounded-sm"
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Fingerprint className="mr-2 h-4 w-4" />}
              Register Passkey
            </Button>
          </div>
        )}
      </section>
      )}

      {tokenAuthEnabled && !isAuthenticated && (
        <section className="border border-[#2C2E33] bg-[#1C1D21] p-5">
          <h2 className="text-lg font-semibold text-white">Admin Token Sign In</h2>
          <p className="mt-1 text-sm text-[#8E9299]">
            Use this only if token sign-in is enabled for this portal.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
            <Input
              type="password"
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
              placeholder="Paste admin token"
              className="rounded-sm"
            />
            <Button onClick={signInWithToken} disabled={busy} className="rounded-sm">
              Sign In
            </Button>
          </div>
        </section>
      )}

      {isAuthenticated && setupCodes.length > 0 && (
        <section className="border border-[#2C2E33] bg-[#1C1D21] p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">One-time Codes</h2>
              <p className="mt-1 text-sm text-[#8E9299]">Created from the server tools. Plaintext codes are shown once and are not stored.</p>
            </div>
            <Badge variant="outline" className="rounded-sm">
              {setupCodes.filter((code) => !code.usedAt).length} open
            </Badge>
          </div>
          <div className="mt-4 divide-y divide-[#2C2E33]">
            {setupCodes.map((code) => (
              <div key={code.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{code.label || "Setup code"}</p>
                  <p className="text-xs text-[#8E9299]">
                    {code.usedAt ? `Used ${new Date(code.usedAt).toLocaleString()}` : "Unused"}
                  </p>
                </div>
                <Badge variant={code.usedAt ? "secondary" : "outline"} className="rounded-sm">
                  {code.usedAt ? "Used" : "Open"}
                </Badge>
                {!code.usedAt && code.source === "generated" && (
                  <Button variant="ghost" size="sm" className="rounded-sm" onClick={() => revokeSetupCode(code.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function FleetPage({
  servers,
  lifecycle,
  onNavigate,
  onRefresh,
}: {
  servers: ServerRow[];
  lifecycle: LifecycleState | null;
  onNavigate: (route: Route) => void;
  onRefresh: () => Promise<void> | void;
}) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<CreateServerInput>({
    name: "",
    edition: "paper",
    mc_version: "1.21.1",
    memory_mb: 4096,
    cpu_limit: "2",
    public_port: 34567,
  });
  const maxActive = lifecycle?.maxActiveServers ?? 3;
  const slotsAvailable = lifecycle?.slotsAvailable ?? Math.max(0, maxActive - servers.length);
  const archives = lifecycle?.archives ?? [];

  const createServer = async () => {
    setBusy(true);
    try {
      const input = { ...form, name: form.name.trim() || undefined };
      await api.createServer(input);
      toast.success("Server created");
      setCreating(false);
      await onRefresh();
      if (input.name) onNavigate({ page: "server", name: input.name, tab: "overview" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-14">
      <div className="flex flex-col gap-10 border-b-2 border-white/5 pb-10 md:flex-row md:items-end md:justify-between">
        <div className="space-y-4">
          <p className="control-label text-brand-primary">Server slots</p>
          <h1 className="font-display text-6xl font-black uppercase leading-[0.85] tracking-tight text-white md:text-7xl">
            <span className="mt-2 inline-block border-[5px] border-double border-brand-primary bg-black px-4 py-1 text-brand-primary">
              Servers
            </span>
          </h1>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-neutral-600">
            {servers.length} / {maxActive} active servers // {archives.length} saved // {slotsAvailable} open
          </p>
        </div>
        <Button
          className="control-button bg-brand-primary px-8 py-4 text-black hover:bg-white"
          onClick={() => setCreating(true)}
          disabled={slotsAvailable <= 0 || lifecycle?.configured === false}
        >
          <Plus className="mr-2 h-4 w-4" />
          Create Server
        </Button>
      </div>

      {lifecycle?.configured === false && (
        <div className="border border-amber-400/25 bg-amber-400/5 p-4 text-xs font-bold uppercase tracking-[0.16em] text-amber-200">
          Server creation and restore are not set up yet: {lifecycle.unavailableReason}
        </div>
      )}

      {creating && (
        <div className="control-surface relative overflow-hidden p-10">
          <div className="pointer-events-none absolute right-4 top-4 opacity-[0.03]">
            <Plus className="h-32 w-32" />
          </div>
          <div className="relative z-10">
            <div className="mb-10">
              <p className="control-label">New Server</p>
              <h2 className="mt-2 text-2xl font-black uppercase tracking-tight text-white">Create Server</h2>
              <p className="mt-2 text-sm text-neutral-500">
                Creates one of the three managed server slots. New servers currently support Paper or Vanilla.
              </p>
            </div>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              <Field label="Server name">
                <Input
                  value={form.name || ""}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="mc-server-2"
                  className="control-input"
                />
              </Field>
              <Field label="Edition">
                <Select value={form.edition} onValueChange={(edition) => setForm((current) => ({ ...current, edition }))}>
                  <SelectTrigger className="control-input"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="paper">Paper</SelectItem>
                    <SelectItem value="vanilla">Vanilla</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Minecraft version">
                <Input
                  value={form.mc_version}
                  onChange={(event) => setForm((current) => ({ ...current, mc_version: event.target.value }))}
                  className="control-input font-mono"
                />
              </Field>
              <Field label="Public port">
                <Input
                  type="number"
                  value={form.public_port}
                  onChange={(event) => setForm((current) => ({ ...current, public_port: Number(event.target.value) }))}
                  className="control-input font-mono"
                />
              </Field>
              <Field label="Memory MB">
                <Input
                  type="number"
                  min={1024}
                  value={form.memory_mb}
                  onChange={(event) => setForm((current) => ({ ...current, memory_mb: Number(event.target.value) }))}
                  className="control-input font-mono"
                />
              </Field>
              <Field label="CPU limit">
                <Input
                  value={form.cpu_limit}
                  onChange={(event) => setForm((current) => ({ ...current, cpu_limit: event.target.value }))}
                  className="control-input font-mono"
                />
              </Field>
            </div>
            <div className="mt-10 flex justify-end gap-4 border-t border-white/5 pt-8">
              <Button variant="ghost" className="control-button text-neutral-600 hover:text-white" onClick={() => setCreating(false)}>Cancel</Button>
              <Button className="control-button bg-white px-8 text-black hover:bg-brand-primary" onClick={createServer} disabled={busy || slotsAvailable <= 0}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Create
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-3">
        {servers.map((server) => (
          <button
            key={server.name}
            type="button"
            onClick={() => onNavigate({ page: "server", name: server.name, tab: "overview" })}
            className="group flex min-h-[17rem] flex-col border border-[#1a1a1a] bg-[#0a0a0a] p-8 text-left transition hover:border-brand-primary/60"
          >
            <div className="mb-10 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className={`status-square ${server.status === "Running" ? "bg-brand-primary shadow-[0_0_10px_rgba(190,242,100,0.85)]" : ""}`} />
                <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-neutral-500">{server.status}</span>
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-700">Port {server.public_port}</div>
            </div>

            <div className="flex-1">
              <h2 className="font-display text-3xl font-black uppercase leading-none tracking-tight text-white transition group-hover:text-brand-primary">
                {server.name}
              </h2>
              <div className="mt-4 flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-neutral-600">
                <span>{server.edition}</span>
                <span className="opacity-25">/</span>
                <span>v{server.mc_version}</span>
              </div>
            </div>

            <div className="mt-8 grid grid-cols-[1fr_auto] items-end gap-6 border-t border-white/5 pt-6">
              <div className="grid grid-cols-2 gap-5 text-sm">
                <Metric label="Players" value={`${server.minecraft?.players?.online ?? 0}/${server.minecraft?.players?.max ?? 0}`} />
                <Metric label="Memory" value={`${server.memory_mb} MB`} />
                <Metric label="Public" value={getPublicJoinAddress(server) || `:${server.public_port}`} />
                <Metric label="CPU" value={server.cpu_limit || "Unlimited"} />
              </div>
              <div className="grid h-10 w-10 place-items-center border border-white/5 text-neutral-500 transition group-hover:bg-brand-primary group-hover:text-black">
                <ChevronRight className="h-5 w-5" />
              </div>
            </div>
          </button>
        ))}

        {Array.from({ length: slotsAvailable }).map((_, index) => (
          <button
            key={`slot-${index}`}
            type="button"
            className="group flex min-h-[17rem] flex-col items-center justify-center gap-6 border border-dashed border-[#1a1a1a] bg-[#0a0a0a]/45 p-8 text-neutral-700 transition hover:border-brand-primary/30 hover:text-brand-primary"
            onClick={() => setCreating(true)}
          >
            <div className="grid h-12 w-12 place-items-center border border-[#1a1a1a] transition group-hover:bg-brand-primary group-hover:text-black">
              <Plus className="h-6 w-6" />
            </div>
            <span className="text-[10px] font-bold uppercase tracking-[0.3em]">Open Server Slot</span>
          </button>
        ))}
      </div>

      {archives.length > 0 && (
        <section className="space-y-5">
          <div className="flex items-center justify-between border-b border-white/5 pb-4">
            <div>
              <p className="control-label">Saved Servers</p>
              <h2 className="mt-1 text-xl font-black uppercase tracking-tight text-white">Recent Saves</h2>
            </div>
            <Button variant="ghost" className="control-button text-brand-primary hover:text-white" onClick={() => onNavigate({ page: "archives" })}>
              View all <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {archives.slice(0, 3).map((archive) => (
              <div key={archive.id} className="control-surface p-5">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-700">{new Date(archive.createdAt).toLocaleDateString()}</p>
                <p className="mt-2 font-bold uppercase tracking-tight text-white">{archive.label || archive.sourceName}</p>
                <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-neutral-600">{archive.server.edition} {archive.server.mc_version}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ArchivePage({ lifecycle, onRefresh }: { lifecycle: LifecycleState | null; onRefresh: () => Promise<void> | void }) {
  const [restoreTarget, setRestoreTarget] = useState<ServerArchive | null>(null);
  const [restoreName, setRestoreName] = useState("");
  const [restorePort, setRestorePort] = useState(34567);
  const [busy, setBusy] = useState(false);
  const archives = lifecycle?.archives ?? [];
  const slotsAvailable = lifecycle?.slotsAvailable ?? 0;

  const openRestore = (archive: ServerArchive) => {
    setRestoreTarget(archive);
    setRestoreName(archive.server.name || archive.sourceName);
    setRestorePort(archive.server.public_port || 34567);
  };

  const restore = async () => {
    if (!restoreTarget) return;
    setBusy(true);
    try {
      await api.restoreArchive(restoreTarget.id, { name: restoreName.trim() || undefined, public_port: restorePort });
      toast.success("Saved server restored");
      setRestoreTarget(null);
      await onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to restore saved server");
    } finally {
      setBusy(false);
    }
  };

  const deleteArchive = async (archive: ServerArchive) => {
    setBusy(true);
    try {
      await api.deleteArchive(archive.id);
      toast.success("Saved server deleted");
      await onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete saved server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#F27D26]">Saved servers</p>
          <h1 className="mt-2 text-3xl font-semibold text-white">Saved Servers</h1>
          <p className="mt-2 text-sm text-[#8E9299]">Bring a saved Minecraft server back into an open server slot.</p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-[0.16em] text-[#8E9299]">Slots available</p>
          <p className="text-2xl font-semibold text-white">{slotsAvailable}</p>
        </div>
      </div>

      {archives.length === 0 ? (
        <div className="border border-dashed border-[#2C2E33] bg-[#1C1D21] p-12 text-center text-[#8E9299]">
          <Archive className="mx-auto mb-4 h-10 w-10 opacity-40" />
          <p className="font-medium text-white">No saved servers yet</p>
          <p className="mt-2 text-sm">Save a season or world before freeing one of the three active server slots.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {archives.map((archive) => (
            <div key={archive.id} className="grid gap-4 border border-[#2C2E33] bg-[#1C1D21] p-5 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-white">{archive.label || archive.sourceName}</h2>
                  <Badge variant="secondary" className="rounded-sm">{archive.server.edition} {archive.server.mc_version}</Badge>
                </div>
                <p className="mt-1 text-xs text-[#8E9299]">
                  {new Date(archive.createdAt).toLocaleString()} | {archive.server.memory_mb} MB | {archive.id}
                </p>
              </div>
              <div className="flex gap-2">
                <Button className="rounded-sm" disabled={slotsAvailable <= 0 || busy} onClick={() => openRestore(archive)}>
                  <DatabaseBackup className="mr-2 h-4 w-4" />
                  Restore
                </Button>
                <Button variant="outline" className="rounded-sm text-red-200" disabled={busy} onClick={() => deleteArchive(archive)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={Boolean(restoreTarget)} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle>Restore Saved Server</DialogTitle>
            <DialogDescription>Bring this saved server back into an open server slot.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field label="Server name">
              <Input value={restoreName} onChange={(event) => setRestoreName(event.target.value)} className="rounded-sm" />
            </Field>
            <Field label="Public port">
              <Input type="number" value={restorePort} onChange={(event) => setRestorePort(Number(event.target.value))} className="rounded-sm" />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-sm" onClick={() => setRestoreTarget(null)}>Cancel</Button>
            <Button className="rounded-sm" onClick={restore} disabled={busy || slotsAvailable <= 0}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <DatabaseBackup className="mr-2 h-4 w-4" />}
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ServerWorkspacePage({
  route,
  servers,
  lifecycle,
  onNavigate,
  onRefresh,
}: {
  route: Extract<Route, { page: "server" }>;
  servers: ServerRow[];
  lifecycle: LifecycleState | null;
  onNavigate: (route: Route) => void;
  onRefresh: () => Promise<void> | void;
}) {
  const server = servers.find((candidate) => candidate.name === route.name);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveLabel, setArchiveLabel] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  if (!server) {
    return (
      <div className="control-surface p-8 text-neutral-500">
        Server `{route.name}` is not currently registered.
      </div>
    );
  }

  const runLifecycleAction = async (action: "start" | "stop" | "restart" | "backup") => {
    setBusyAction(action);
    try {
      const result = await api.serverAction(server.name, action);
      const message = typeof result === "string" ? result : result.message;
      toast.success(message || `${action} completed`);
      await onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to ${action} server`);
    } finally {
      setBusyAction(null);
    }
  };

  const archiveServer = async () => {
    setBusyAction("archive");
    try {
      await api.archiveServer(server.name, archiveLabel);
      toast.success(`${server.name} saved`);
      setArchiveOpen(false);
      await onRefresh();
      onNavigate({ page: "fleet" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save server");
    } finally {
      setBusyAction(null);
    }
  };

  const isRunning = server.status === "Running";
  const currentTab = route.tab;

  return (
    <div className="-mx-4 -my-8 min-h-[calc(100vh-0px)] lg:-mx-10">
      <div className="sticky top-0 z-20 border-b border-[#1a1a1a] bg-black/95 px-4 py-6 backdrop-blur lg:px-10">
        <div className="mx-auto max-w-7xl">
          <div className="mb-7 flex flex-col gap-6 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-start gap-5">
              <button
                type="button"
                onClick={() => onNavigate({ page: "fleet" })}
                className="mt-1 grid h-10 w-10 shrink-0 place-items-center border border-[#1f1f1f] text-neutral-600 transition hover:border-brand-primary hover:text-brand-primary"
                title="Back to servers"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div>
                <div className="flex flex-wrap items-center gap-4">
                  <h1 className="font-display text-4xl font-black uppercase leading-none tracking-tight text-white">
                    {server.name}
                  </h1>
                  <div className="flex items-center gap-3 border border-[#1f1f1f] bg-[#0a0a0a] px-3 py-1">
                    <div className={`status-square ${isRunning ? "bg-brand-primary shadow-[0_0_10px_rgba(190,242,100,0.85)]" : ""}`} />
                    <span className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-500">{server.status}</span>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-xs font-bold uppercase tracking-[0.14em] text-neutral-600">
                  <span className="flex items-center gap-2"><Server className="h-3.5 w-3.5 text-brand-primary" />{server.edition} v{server.mc_version}</span>
                  <span className="h-1 w-1 bg-neutral-800" />
                  <span>{server.memory_mb} MB</span>
                  <span className="h-1 w-1 bg-neutral-800" />
                  <span>{server.cpu_limit || "Unlimited"} CPU</span>
                  <span className="h-1 w-1 bg-neutral-800" />
                  <span className="font-mono">{getPublicJoinAddress(server) || `:${server.public_port}`}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="control-button bg-brand-primary px-6 text-black hover:bg-white"
                onClick={() => runLifecycleAction("start")}
                disabled={busyAction !== null || isRunning}
              >
                <Play className="mr-2 h-4 w-4" />
                Start
              </Button>
              <Button
                variant="outline"
                className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-white/5 hover:text-white"
                onClick={() => runLifecycleAction("restart")}
                disabled={busyAction !== null || !isRunning}
              >
                <RotateCw className="mr-2 h-4 w-4" />
                Restart
              </Button>
              <Button
                variant="destructive"
                className="control-button bg-rose-600 px-6 text-white hover:bg-rose-500"
                onClick={() => runLifecycleAction("stop")}
                disabled={busyAction !== null || !isRunning}
              >
                <Square className="mr-2 h-4 w-4" />
                Stop
              </Button>
              <Button
                variant="outline"
                className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-white/5 hover:text-white"
                onClick={() => window.open(pathFor({ page: "public", name: server.name }), "_blank")}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Friend Join Page
              </Button>
              <Button
                variant="outline"
                className="control-button border-amber-400/25 bg-amber-400/5 text-amber-300 hover:bg-amber-400/10 hover:text-amber-200"
                disabled={lifecycle?.configured === false || busyAction !== null}
                onClick={() => {
                  setArchiveLabel(`${server.name} ${new Date().toLocaleDateString()}`);
                  setArchiveOpen(true);
                }}
              >
                <Archive className="mr-2 h-4 w-4" />
                Save Server
              </Button>
            </div>
          </div>

          <Tabs value={currentTab} onValueChange={(value) => onNavigate({ page: "server", name: server.name, tab: value as WorkspaceTab })}>
            <TabsList className="h-auto flex-wrap justify-start rounded-none border-0 bg-transparent p-0">
              {workspaceTabs.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="rounded-none border-b-2 border-transparent px-5 py-3 text-xs font-bold uppercase tracking-[0.16em] text-neutral-500 data-[state=active]:border-brand-primary data-[state=active]:bg-[#0a0a0a] data-[state=active]:text-brand-primary"
                >
                  <Icon className="mr-2 h-4 w-4" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 lg:px-10">
        <div role="tabpanel" aria-label={workspaceTabs.find((tab) => tab.value === currentTab)?.label || "Workspace"}>
          {currentTab === "overview" && (
            <OverviewTab server={server} onBackup={() => runLifecycleAction("backup")} />
          )}
          {currentTab === "players" && <PlayersTab server={server} />}
          {currentTab === "content" && <ContentTab server={server} onRefresh={onRefresh} />}
          {currentTab === "worlds" && <WorldsTab server={server} />}
          {currentTab === "settings" && <SettingsTab server={server} onRefresh={onRefresh} />}
        </div>
      </div>

      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle>Save Server</DialogTitle>
            <DialogDescription>
              This saves the complete Minecraft server, removes it from the active list, and frees one of the three server slots.
            </DialogDescription>
          </DialogHeader>
          <Field label="Saved server name">
            <Input value={archiveLabel} onChange={(event) => setArchiveLabel(event.target.value)} className="rounded-sm" />
          </Field>
          <DialogFooter>
            <Button variant="outline" className="rounded-sm" onClick={() => setArchiveOpen(false)}>Cancel</Button>
            <Button variant="destructive" className="rounded-sm" onClick={archiveServer} disabled={busyAction !== null}>
              {busyAction === "archive" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Archive className="mr-2 h-4 w-4" />}
              Save Server
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OverviewTab({
  server,
  onBackup,
}: {
  server: ServerRow;
  onBackup: () => void;
}) {
  const [logs, setLogs] = useState("");
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [tps, setTps] = useState<number | null>(null);
  const [publicAccess, setPublicAccess] = useState<PublicAccessState | null>(null);
  const [command, setCommand] = useState("");
  const [commandOutput, setCommandOutput] = useState("");
  const logsRef = useRef<HTMLDivElement>(null);

  const loadLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const text = await api.getLogs(server.name);
      setLogs(text.trim().split("\n").slice(-MAX_LOG_LINES).join("\n"));
    } catch {
      // Logs are convenience data; keep the workspace usable.
    } finally {
      setLoadingLogs(false);
    }
  }, [server.name]);

  const loadTps = useCallback(async () => {
    if (server.status !== "Running") {
      setTps(null);
      return;
    }
    try {
      const data = await api.getTps(server.name);
      setTps(readTpsValue(data));
    } catch {
      setTps(null);
    }
  }, [server.name, server.status]);

  const checkPublic = useCallback(async () => {
    if (!server.public_domain) {
      setPublicAccess({ accessible: false, checking: false, reason: "No public domain configured" });
      return;
    }
    setPublicAccess((current) => ({ ...(current || { accessible: null }), checking: true }));
    try {
      const data = await api.checkPublicAccess(server.name);
      setPublicAccess({ ...data, checking: false, checkedAt: new Date().toISOString() });
    } catch (error) {
      setPublicAccess({
        accessible: false,
        checking: false,
        reason: error instanceof Error ? error.message : "External status check failed",
      });
    }
  }, [server.name, server.public_domain]);

  useEffect(() => {
    void loadLogs();
    void loadTps();
    void checkPublic();
    let logsInterval: number | null = null;
    let logsSource: EventSource | null = null;
    const stopLogPolling = () => {
      if (logsInterval === null) return;
      window.clearInterval(logsInterval);
      logsInterval = null;
    };
    const startLogPolling = () => {
      if (logsInterval !== null) return;
      logsInterval = window.setInterval(() => void loadLogs(), 3000);
    };
    if ("EventSource" in window) {
      logsSource = api.subscribeServerLogs(
        server.name,
        (state) => {
          stopLogPolling();
          setLoadingLogs(false);
          setLogs(state.logs.trim().split("\n").slice(-MAX_LOG_LINES).join("\n"));
        },
        () => {
          setLoadingLogs(false);
          startLogPolling();
        }
      );
    } else {
      startLogPolling();
    }
    const tpsInterval = window.setInterval(() => void loadTps(), 5000);
    const publicInterval = window.setInterval(() => void checkPublic(), 30000);
    return () => {
      logsSource?.close();
      stopLogPolling();
      window.clearInterval(tpsInterval);
      window.clearInterval(publicInterval);
    };
  }, [checkPublic, loadLogs, loadTps, server.name]);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  const runCommand = async () => {
    if (!command.trim()) return;
    try {
      const output = await api.runCommand(server.name, command.trim());
      setCommandOutput(output.trim() || "Command completed with no output.");
      setCommand("");
      await loadLogs();
    } catch (error) {
      setCommandOutput(error instanceof Error ? error.message : "Command failed");
    }
  };

  const publicAddress = getPublicJoinAddress(server);
  const localAddress = getLocalJoinAddress(server);
  const logLines = logs ? logs.split("\n").filter(Boolean) : [];

  return (
    <div className="grid min-h-[42rem] gap-8 xl:grid-cols-[24rem_minmax(0,1fr)]">
      <div className="space-y-6">
        <section className="control-surface">
          <div className="flex items-center justify-between border-b border-[#1a1a1a] px-6 py-4">
            <h2 className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.2em] text-neutral-600">
              <Activity className="h-4 w-4 text-brand-primary" />
              Server Status
            </h2>
            {server.status === "Running" && <div className="status-square bg-brand-primary shadow-[0_0_8px_rgba(190,242,100,0.85)]" />}
          </div>
          <div className="grid grid-cols-2">
            <MetricCell label="Status" value={server.status} tone={server.status === "Running" ? "primary" : "muted"} />
            <MetricCell label="TPS" value={formatTps(tps)} mono />
            <MetricCell label="Players" value={`${server.minecraft?.players?.online ?? 0}/${server.minecraft?.players?.max ?? 0}`} mono />
            <MetricCell label="Memory" value={`${server.memory_mb} MB`} mono />
            <MetricCell label="CPU" value={server.cpu_limit || "Unlimited"} mono />
            <MetricCell label="Version" value={server.mc_version} mono />
          </div>
        </section>

        <section className="control-surface">
          <div className="border-b border-[#1a1a1a] px-6 py-4">
            <h2 className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.2em] text-neutral-600">
              <Globe className="h-4 w-4 text-brand-primary" />
              Join Addresses
            </h2>
          </div>
          <div className="space-y-7 p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="control-label">Public join test</p>
                <p className={`mt-1 text-sm font-black uppercase tracking-widest ${
                  publicAccess?.checking ? "text-neutral-400" : publicAccess?.accessible ? "text-brand-primary" : "text-rose-500"
                }`}>
                  {publicAccess?.checking ? "Checking" : publicAccess?.accessible ? "Reachable" : "Restricted"}
                </p>
              </div>
              {publicAccess?.checking && <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />}
            </div>
            <AddressBlock label="Public join address" value={publicAddress || "Set a public domain first"} />
            <AddressBlock label="LAN join address" value={localAddress || "Set LAN IP first"} />
            {publicAccess?.accessible === false && (
              <p className="border border-amber-400/25 bg-amber-400/5 p-4 text-xs font-bold uppercase tracking-[0.12em] text-amber-200">
                If friends outside your Wi-Fi cannot join, forward TCP {server.public_port} to server port {getHostProxyPort(server)}.
                {publicAccess.reason ? ` ${publicAccess.reason}` : ""}
              </p>
            )}
            <Button
              variant="outline"
              className="control-button w-full border-[#1f1f1f] bg-black text-neutral-300 hover:bg-brand-primary hover:text-black"
              disabled={!publicAddress}
              onClick={async () => {
                if (await copyToClipboard(buildPlayerInviteText(server))) toast.success("Player invite copied");
              }}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy Player Invite
            </Button>
          </div>
        </section>

        <section className="control-surface">
          <div className="border-b border-[#1a1a1a] px-6 py-4">
            <h2 className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.2em] text-neutral-600">
              <HardDrive className="h-4 w-4 text-brand-primary" />
              Server Actions
            </h2>
          </div>
          <div className="grid gap-3 p-6">
            <Button variant="outline" className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-white/5 hover:text-white" onClick={onBackup}>
              <HardDrive className="mr-2 h-4 w-4" />
              Create Full Server Backup
            </Button>
          </div>
        </section>
      </div>

      <section className="flex h-[40rem] flex-col overflow-hidden border border-[#1a1a1a] bg-[#050505]">
        <div className="flex items-center justify-between border-b border-[#1a1a1a] bg-[#0a0a0a] px-6 py-4">
          <h2 className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.2em] text-neutral-600">
            <Terminal className="h-4 w-4 text-brand-primary" />
            Minecraft Console
          </h2>
          <div className="flex items-center gap-3">
            {server.status === "Running" && (
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-primary">Live Logs / latest {MAX_LOG_LINES}</span>
            )}
            {loadingLogs && <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />}
          </div>
        </div>
        <div
          ref={logsRef}
          className="min-h-0 flex-1 overflow-y-auto bg-black p-8 font-mono text-[13px] leading-relaxed text-neutral-500"
          aria-live="polite"
        >
          {logLines.length > 0 ? (
            <div className="space-y-1">
              {logLines.map((line, index) => (
                <div key={`${index}-${line}`} className="group -mx-4 flex gap-4 px-4 py-0.5 transition hover:bg-white/5">
                  <span className="shrink-0 select-none text-[10px] text-neutral-800">{String(index + 1).padStart(3, "0")}</span>
                  <span className="whitespace-pre-wrap break-words transition group-hover:text-white">{line}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-neutral-800">
              <Terminal className="h-12 w-12 opacity-25" />
              <p className="text-[10px] font-bold uppercase tracking-[0.3em]">No Logs Yet</p>
            </div>
          )}
        </div>
        <div className="border-t border-[#1a1a1a] bg-[#0a0a0a] p-6">
          <div className="flex items-center gap-4 border border-[#1f1f1f] bg-black px-5 py-3 transition focus-within:border-brand-primary hover:border-brand-primary">
            <span className="select-none font-mono font-bold text-brand-primary">$</span>
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runCommand();
              }}
              placeholder={server.status === "Running" ? "say Server restarting soon" : "Server is stopped"}
              disabled={server.status !== "Running"}
              className="flex-1 border-0 bg-transparent p-0 font-mono text-sm text-white outline-none placeholder:text-neutral-800 disabled:opacity-50"
            />
            <Button className="control-button bg-brand-primary text-black hover:bg-white" onClick={() => void runCommand()} disabled={server.status !== "Running"}>
              Run
            </Button>
          </div>
          {commandOutput && (
            <pre className="mt-4 max-h-32 overflow-auto border border-[#1f1f1f] bg-black p-4 text-xs text-brand-primary whitespace-pre-wrap">
              {commandOutput}
            </pre>
          )}
        </div>
      </section>
    </div>
  );
}

function PlayersTab({ server }: { server: ServerRow }) {
  const [settings, setSettings] = useState<ServerSettingsResponse | null>(null);
  const [bans, setBans] = useState<BansResponse>({ players: [], ips: [] });
  const [whitelistName, setWhitelistName] = useState("");
  const [operatorName, setOperatorName] = useState("");
  const [banName, setBanName] = useState("");
  const [banReason, setBanReason] = useState("");
  const [banIpValue, setBanIpValue] = useState("");
  const [banIpReason, setBanIpReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [settingsData, bansData] = await Promise.all([api.getSettings(server.name), api.getBans(server.name)]);
      setSettings(settingsData);
      setBans({ players: bansData.players || [], ips: bansData.ips || [] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load player data");
    }
  }, [server.name]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(interval);
  }, [load]);

  const whitelist = (settings?.whitelist || []).map((entry) => entry.name).filter(Boolean);
  const operators = (settings?.operators || []).map((entry) => entry.name).filter(Boolean);

  const updateLists = async (next: { whitelist?: string[]; operators?: string[] }) => {
    setBusy(true);
    try {
      await api.applySettings(server.name, { ...next, restart: false });
      await load();
      toast.success("Player access updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update player access");
    } finally {
      setBusy(false);
    }
  };

  const addWhitelist = () => {
    const name = whitelistName.trim();
    if (!name) return;
    setWhitelistName("");
    void updateLists({ whitelist: Array.from(new Set([...whitelist, name])) });
  };

  const addOperator = () => {
    const name = operatorName.trim();
    if (!name) return;
    setOperatorName("");
    void updateLists({ operators: Array.from(new Set([...operators, name])) });
  };

  const banPlayer = async () => {
    const name = banName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.banPlayer(server.name, name, banReason.trim() || "Banned by an operator");
      setBanName("");
      setBanReason("");
      await load();
      toast.success("Player banned");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to ban player");
    } finally {
      setBusy(false);
    }
  };

  const banIp = async () => {
    const ip = banIpValue.trim();
    if (!ip) return;
    setBusy(true);
    try {
      await api.banIp(server.name, ip, banIpReason.trim() || "Banned by an operator");
      setBanIpValue("");
      setBanIpReason("");
      await load();
      toast.success("IP banned");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to ban IP");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <PlayerPanel title="Allowed Players" icon={Users}>
        <InlineAdd value={whitelistName} onChange={setWhitelistName} onAdd={addWhitelist} placeholder="Minecraft username" disabled={busy} />
        <NameList
          empty="No players are allowed yet."
          names={whitelist}
          actionLabel="Remove"
          onAction={(name) => updateLists({ whitelist: whitelist.filter((entry) => entry !== name) })}
        />
      </PlayerPanel>

      <PlayerPanel title="Operators (OP)" icon={Shield}>
        <InlineAdd value={operatorName} onChange={setOperatorName} onAdd={addOperator} placeholder="Minecraft username" disabled={busy} />
        <NameList
          empty="No operators assigned."
          names={operators}
          actionLabel="Deop"
          onAction={(name) => updateLists({ operators: operators.filter((entry) => entry !== name) })}
        />
      </PlayerPanel>

      <PlayerPanel title="Bans" icon={Trash2}>
        <div className="space-y-4">
          <div className="space-y-2">
            <Input value={banName} onChange={(event) => setBanName(event.target.value)} placeholder="Player username" />
            <Input value={banReason} onChange={(event) => setBanReason(event.target.value)} placeholder="Reason (optional)" />
            <Button variant="destructive" className="control-button w-full" onClick={banPlayer} disabled={busy}>Ban Player</Button>
          </div>
          <Separator />
          <div className="space-y-2">
            <Input value={banIpValue} onChange={(event) => setBanIpValue(event.target.value)} placeholder="IP address" />
            <Input value={banIpReason} onChange={(event) => setBanIpReason(event.target.value)} placeholder="Reason (optional)" />
            <Button variant="destructive" className="control-button w-full" onClick={banIp} disabled={busy}>Ban IP Address</Button>
          </div>
        </div>
        <Separator className="my-4" />
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#8E9299]">Banned players</p>
          {bans.players.length === 0 ? (
            <p className="text-sm text-[#8E9299]">No banned players.</p>
          ) : bans.players.map((ban) => (
            <BanRow key={ban.uuid || ban.name} label={ban.name} reason={ban.reason} onPardon={async () => {
              await api.pardonPlayer(server.name, ban.name);
              await load();
            }} />
          ))}
          <p className="pt-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#8E9299]">Banned IPs</p>
          {bans.ips.length === 0 ? (
            <p className="text-sm text-[#8E9299]">No banned IPs.</p>
          ) : bans.ips.map((ban) => (
            <BanRow key={ban.ip} label={ban.ip} reason={ban.reason} onPardon={async () => {
              await api.pardonIp(server.name, ban.ip);
              await load();
            }} />
          ))}
        </div>
      </PlayerPanel>
    </div>
  );
}

function ContentTab({ server, onRefresh }: { server: ServerRow; onRefresh: () => Promise<void> | void }) {
  if (serverSupportsMods(server)) {
    return (
      <ModsManagementPanel
        serverName={server.name}
        mcVersion={server.mc_version}
        loader={server.edition.toLowerCase() as "forge" | "fabric" | "neoforge"}
        serverMemoryMB={server.memory_mb}
        publicAddress={getPublicJoinAddress(server) || undefined}
      />
    );
  }

  if (!serverSupportsPlugins(server)) {
    return (
      <div className="control-surface p-8">
        <p className="control-label mb-3">Vanilla Server</p>
        <p className="max-w-2xl text-sm text-neutral-500">
          Vanilla servers do not use server-side plugins or client mods through this panel.
        </p>
      </div>
    );
  }

  return <PluginManagementPanel server={server} onRefresh={onRefresh} />;
}

function PluginManagementPanel({ server, onRefresh }: { server: ServerRow; onRefresh: () => Promise<void> | void }) {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [search, setSearch] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPlugins = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const data = await api.getPlugins(server.name);
      setPlugins(data.plugins || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load plugins");
    } finally {
      setLoading(false);
    }
  }, [server.name]);

  useEffect(() => {
    void loadPlugins(true);
    const interval = window.setInterval(() => void loadPlugins(), 15000);
    return () => window.clearInterval(interval);
  }, [loadPlugins]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const message = await api.uploadFile(server.name, "plugins", file);
      toast.success(message);
      await loadPlugins();
      await onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to upload ${file.name}`);
    } finally {
      setUploading(false);
    }
  };

  const toggle = async (plugin: InstalledPlugin) => {
    setBusyPlugin(plugin.fileName);
    try {
      const result = await api.togglePlugin(server.name, plugin.fileName, !plugin.enabled);
      toast.success(result.message || `Plugin ${plugin.enabled ? "disabled" : "enabled"}. Restart server to apply.`);
      await loadPlugins();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update plugin");
    } finally {
      setBusyPlugin(null);
    }
  };

  const remove = async (plugin: InstalledPlugin) => {
    setBusyPlugin(plugin.fileName);
    try {
      const result = await api.deletePlugin(server.name, plugin.fileName);
      toast.success(result.message || "Plugin removed. Restart server to apply.");
      await loadPlugins();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove plugin");
    } finally {
      setBusyPlugin(null);
    }
  };

  const filtered = plugins.filter((plugin) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return [plugin.name, plugin.fileName, plugin.pluginId, plugin.description]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <p className="control-label mb-2">Plugin Manager</p>
          <h2 className="text-3xl font-black uppercase tracking-tight text-white">Server Plugins</h2>
          <p className="mt-1 max-w-2xl text-sm text-neutral-500">
            Paper servers can use server-side plugins. Friends do not install these unless a plugin says otherwise.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button className="control-button bg-brand-primary text-black hover:bg-white" onClick={() => setBrowserOpen(true)}>
            <Package2 className="mr-2 h-4 w-4" />
            Browse Plugins
          </Button>
          <UploadButton
            label={uploading ? "Uploading..." : "Upload JAR"}
            accept=".jar"
            disabled={uploading}
            onFile={upload}
          />
        </div>
      </div>

      <Panel title="Installed Plugins" icon={Package}>
        <div className="space-y-4">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search installed plugins..."
          />
          {loading ? (
            <p className="py-8 text-center text-sm text-neutral-600">Loading plugins...</p>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-neutral-600">
              {plugins.length === 0 ? "No plugins installed." : "No plugins match your search."}
            </p>
          ) : (
            <div className="grid gap-3">
              {filtered.map((plugin) => (
                <div key={plugin.fileName} className="grid gap-3 border border-[#1a1a1a] bg-black p-4 transition hover:border-brand-primary/50 md:grid-cols-[1fr_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-white">{plugin.name || plugin.fileName}</p>
                      <Badge variant={plugin.enabled ? "default" : "secondary"} className="rounded-sm">
                        {plugin.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      <Badge variant="outline" className="rounded-sm">{plugin.version || "unknown"}</Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-[#8E9299]">{plugin.description || plugin.fileName}</p>
                    {plugin.main && <p className="mt-1 truncate font-mono text-[11px] text-[#8E9299]">{plugin.main}</p>}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-brand-primary hover:text-black"
                      onClick={() => toggle(plugin)}
                      disabled={busyPlugin === plugin.fileName}
                    >
                      {plugin.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="control-button border-[#1f1f1f] bg-black text-red-200 hover:border-red-400 hover:bg-red-500/10"
                      aria-label={`Delete ${plugin.name || plugin.fileName}`}
                      onClick={() => remove(plugin)}
                      disabled={busyPlugin === plugin.fileName}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Recommended Plugins" icon={Package}>
        <RecommendedPlugins server={server} onRefresh={async () => {
          await loadPlugins();
          await onRefresh();
        }} />
      </Panel>

      <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
        <DialogContent className="w-[min(94vw,64rem)] max-w-none overflow-hidden rounded-none border-[#1a1a1a] bg-[#050505] p-0">
          <DialogHeader className="border-b border-[#1a1a1a] px-5 py-4 pr-12 text-left">
            <DialogTitle>Plugin Browser</DialogTitle>
            <DialogDescription>
              Search Modrinth plugins compatible with {server.edition} {server.mc_version}.
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 py-5">
            <ModBrowser
              serverName={server.name}
              mcVersion={server.mc_version}
              loader={server.edition.toLowerCase() as "paper" | "spigot" | "purpur"}
              serverMemoryMB={server.memory_mb}
              type="plugin"
              onInstall={() => {
                toast.success(`Plugin installed. Restart ${server.name} to load it.`);
                void loadPlugins();
                void onRefresh();
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WorldsTab({ server }: { server: ServerRow }) {
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorldInfo | null>(null);
  const [generateForm, setGenerateForm] = useState({ name: "", seed: "", levelType: "default" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      try {
        setWorlds(await api.getWorldDetails(server.name));
      } catch {
        const names = await api.getWorlds(server.name);
        setWorlds(names.map((name) => ({
          name,
          size: 0,
          lastPlayed: "",
          isActive: name === "world" || name === "default",
        })));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load worlds");
    } finally {
      setLoading(false);
    }
  }, [server.name]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 20000);
    return () => window.clearInterval(interval);
  }, [load]);

  const switchWorld = async (world: WorldInfo) => {
    setBusy(true);
    try {
      const message = await api.switchWorld(server.name, world.name);
      toast.success(message || `Switched to ${world.name}`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to switch world");
    } finally {
      setBusy(false);
    }
  };

  const generateWorld = async () => {
    const name = generateForm.name.trim();
    if (!name) {
      toast.error("Enter a world name");
      return;
    }
    setBusy(true);
    try {
      const result = await api.generateWorld(server.name, {
        name,
        seed: generateForm.seed.trim() || undefined,
        levelType: generateForm.levelType,
      });
      toast.success(result.message || `Generated ${name}`);
      setGenerateForm({ name: "", seed: "", levelType: "default" });
      setGenerateOpen(false);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to generate world");
    } finally {
      setBusy(false);
    }
  };

  const uploadWorld = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const message = await api.uploadFile(server.name, "worlds/upload", file);
      toast.success(message);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload world");
    } finally {
      setBusy(false);
    }
  };

  const backupWorld = async (world: WorldInfo) => {
    setBusy(true);
    try {
      const result = await api.backupWorld(server.name, world.name);
      toast.success(result.backupPath ? `World backup created: ${result.backupPath}` : result.message || "World backup created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to back up world");
    } finally {
      setBusy(false);
    }
  };

  const deleteWorld = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      const result = await api.deleteWorld(server.name, deleteTarget.name);
      toast.success(result.message || `Deleted ${deleteTarget.name}`);
      setDeleteTarget(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete world");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-6xl space-y-5">
      <div className="flex flex-col gap-4 border-b border-[#1a1a1a] pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="control-label mb-2">World_Store</p>
          <h2 className="flex items-center gap-3 text-3xl font-black uppercase tracking-tight text-white">
            <MapIcon className="h-6 w-6 text-brand-primary" />
            Worlds
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-neutral-500">Generate, upload, switch, back up, download, and delete worlds.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-brand-primary hover:text-black" disabled={busy} onClick={() => setGenerateOpen(true)}>
            <FilePlus className="mr-2 h-4 w-4" />
            Generate
          </Button>
          <UploadButton label="Upload World" accept=".zip" disabled={busy} onFile={uploadWorld} />
        </div>
      </div>
      <div className="space-y-3">
        {loading ? (
          <p className="control-surface p-6 text-sm text-neutral-600">Loading worlds...</p>
        ) : worlds.length === 0 ? (
          <p className="control-surface p-6 text-sm text-neutral-600">No worlds found.</p>
        ) : worlds.map((world) => (
          <div key={world.name} className="control-surface flex flex-col gap-4 p-5 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-center gap-3">
              <div className={`status-square ${world.isActive ? "bg-brand-primary" : "bg-neutral-700"}`} />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-white">{world.name}</p>
                  {world.isActive && <Badge className="rounded-sm">Active</Badge>}
                </div>
                <p className="mt-1 text-xs text-[#8E9299]">
                  {world.size ? formatBytes(world.size) : "Size unavailable"}
                  {world.lastPlayed ? ` | Last played ${new Date(world.lastPlayed).toLocaleString()}` : ""}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-brand-primary hover:text-black" onClick={() => switchWorld(world)} disabled={busy || world.isActive}>
                Switch
              </Button>
              <Button variant="outline" className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-white/5 hover:text-white" onClick={() => backupWorld(world)} disabled={busy}>
                <DatabaseBackup className="mr-2 h-4 w-4" />
                Backup
              </Button>
              <Button
                variant="outline"
                className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-white/5 hover:text-white"
                disabled={busy}
                onClick={() => {
                  window.location.href = api.worldDownloadUrl(server.name, world.name);
                }}
              >
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
              <Button
                variant="outline"
                className="control-button border-[#1f1f1f] bg-black text-red-200 hover:border-red-400 hover:bg-red-500/10"
                aria-label={`Delete ${world.name}`}
                onClick={() => setDeleteTarget(world)}
                disabled={busy || world.isActive}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
        <DialogContent className="rounded-none border-[#1a1a1a] bg-[#050505]">
          <DialogHeader>
            <DialogTitle>Generate World</DialogTitle>
            <DialogDescription>
              Minecraft will be started long enough to create the new level data, then left in its previous running state.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field label="World name">
              <Input
                value={generateForm.name}
                onChange={(event) => setGenerateForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="survival-season-2"
              />
            </Field>
            <Field label="Seed">
              <Input
                value={generateForm.seed}
                onChange={(event) => setGenerateForm((current) => ({ ...current, seed: event.target.value }))}
                placeholder="Optional"
              />
            </Field>
            <Field label="World type">
              <Select value={generateForm.levelType} onValueChange={(levelType) => setGenerateForm((current) => ({ ...current, levelType }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default</SelectItem>
                  <SelectItem value="flat">Flat</SelectItem>
                  <SelectItem value="large_biomes">Large biomes</SelectItem>
                  <SelectItem value="amplified">Amplified</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-white/5 hover:text-white" onClick={() => setGenerateOpen(false)}>Cancel</Button>
            <Button className="control-button bg-brand-primary text-black hover:bg-white" onClick={generateWorld} disabled={busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FilePlus className="mr-2 h-4 w-4" />}
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="rounded-none border-[#1a1a1a] bg-[#050505]">
          <DialogHeader>
            <DialogTitle>Delete World</DialogTitle>
            <DialogDescription>
              A world backup is created before deletion. Active worlds must be switched before they can be deleted.
            </DialogDescription>
          </DialogHeader>
          <p className="border border-[#1f1f1f] bg-black p-3 font-mono text-sm text-white">
            {deleteTarget?.name}
          </p>
          <DialogFooter>
            <Button variant="outline" className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-white/5 hover:text-white" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" className="control-button" onClick={deleteWorld} disabled={busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SettingsTab({ server, onRefresh }: { server: ServerRow; onRefresh: () => Promise<void> | void }) {
  const [draft, setDraft] = useState<ServerSettingsDraft>({
    ...defaultSettings,
    hostIp: server.host_ip || "",
    publicDomain: server.public_domain || "",
    publicPort: server.public_port || 25565,
    hostProxyPort: server.host_proxy_port || server.public_port || 25565,
  });
  const [versionType, setVersionType] = useState<"paper" | "vanilla" | "fabric" | "forge">(
    server.edition.toLowerCase() as "paper" | "vanilla" | "fabric" | "forge"
  );
  const [newVersion, setNewVersion] = useState(server.mc_version);
  const [plugins, setPlugins] = useState<Record<string, boolean>>({
    luckperms: false,
    essentialsx: false,
    vault: false,
    worldedit: false,
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [settings, bans, jvm] = await Promise.all([
        api.getSettings(server.name),
        api.getBans(server.name),
        api.getJvmSettings(server.name),
      ]);
      const props = settings.properties || {};
      setDraft((current) => ({
        ...current,
        hostIp: server.host_ip || "",
        publicDomain: server.public_domain || "",
        publicPort: server.public_port || 25565,
        hostProxyPort: server.host_proxy_port || server.public_port || 25565,
        motd: String(props.motd ?? current.motd),
        maxPlayers: toNumber(props["max-players"], current.maxPlayers),
        gamemode: String(props.gamemode ?? current.gamemode),
        difficulty: String(props.difficulty ?? current.difficulty),
        pvp: toBool(props.pvp, current.pvp),
        spawnProtection: toNumber(props["spawn-protection"], current.spawnProtection),
        viewDistance: toNumber(props["view-distance"], current.viewDistance),
        onlineMode: toBool(props["online-mode"], current.onlineMode),
        allowFlight: toBool(props["allow-flight"], current.allowFlight),
        enforceWhitelist: toBool(props["white-list"] ?? props["enforce-whitelist"], current.enforceWhitelist),
        whitelist: Array.isArray(settings.whitelist) ? settings.whitelist.map((entry) => entry.name).filter(Boolean) : [],
        operators: Array.isArray(settings.operators) ? settings.operators.map((entry) => entry.name).filter(Boolean) : [],
        bannedPlayers: bans.players || [],
        bannedIps: bans.ips || [],
        jvmXms: jvm.xms,
        jvmXmsUnit: jvm.xmsUnit,
        jvmXmx: jvm.xmx,
        jvmXmxUnit: jvm.xmxUnit,
        jvmGc: jvm.gc,
        jvmCustomFlags: jvm.customFlags,
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load settings");
    }
  }, [server]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveNetwork = async () => {
    setBusy(true);
    try {
      await api.patchServerConfig(server.name, {
        host_ip: draft.hostIp.trim() || null,
        public_domain: draft.publicDomain.trim() || null,
        public_port: draft.publicPort,
        host_proxy_port: draft.hostProxyPort,
      });
      toast.success("Join address updated");
      await onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save network settings");
    } finally {
      setBusy(false);
    }
  };

  const saveProperties = async () => {
    setBusy(true);
    try {
      await api.applySettings(server.name, {
        properties: {
          motd: draft.motd,
          "max-players": draft.maxPlayers,
          gamemode: draft.gamemode,
          difficulty: draft.difficulty,
          pvp: draft.pvp,
          "spawn-protection": draft.spawnProtection,
          "view-distance": draft.viewDistance,
          "online-mode": draft.onlineMode,
          "allow-flight": draft.allowFlight,
          "white-list": draft.enforceWhitelist,
          "enforce-whitelist": draft.enforceWhitelist,
        },
        whitelist: draft.whitelist,
        operators: draft.operators,
        restart: true,
      });
      toast.success("Server settings applied");
      await onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to apply settings");
    } finally {
      setBusy(false);
    }
  };

  const saveJvm = async () => {
    setBusy(true);
    try {
      await api.applyJvmSettings(server.name, {
        xms: draft.jvmXms,
        xmsUnit: draft.jvmXmsUnit,
        xmx: draft.jvmXmx,
        xmxUnit: draft.jvmXmxUnit,
        gc: draft.jvmGc,
        customFlags: draft.jvmCustomFlags,
      });
      toast.success("JVM settings updated");
      await onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update JVM settings");
    } finally {
      setBusy(false);
    }
  };

  const changeVersion = async () => {
    if (!newVersion.trim()) {
      toast.error("Enter a Minecraft version");
      return;
    }
    setBusy(true);
    try {
      const result = await api.changeVersion(server.name, { type: versionType, version: newVersion.trim() });
      toast.success(result.message || "Version changed");
      await onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to change version");
    } finally {
      setBusy(false);
    }
  };

  const installPlugins = async () => {
    const requested = Object.entries(plugins).filter(([, enabled]) => enabled).map(([plugin]) => plugin);
    if (requested.length === 0) return;
    setBusy(true);
    try {
      const result = await api.installRecommendedPlugins(server.name, requested);
      if (result.failed?.length) {
        throw new Error(result.failed.map((entry) => `${entry.plugin}: ${entry.error}`).join("; "));
      }
      toast.success(`Installed plugins: ${result.installed.join(", ")}`);
      setPlugins({ luckperms: false, essentialsx: false, vault: false, worldedit: false });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to install plugins");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Panel title="Join Address" icon={Globe}>
        <div className="grid gap-4">
          <Field label="LAN IP address">
            <Input value={draft.hostIp} onChange={(event) => setDraft({ ...draft, hostIp: event.target.value })} />
          </Field>
          <div className="grid gap-3 md:grid-cols-[1fr_8rem_10rem]">
            <Field label="Public domain">
              <Input value={draft.publicDomain} onChange={(event) => setDraft({ ...draft, publicDomain: event.target.value })} />
            </Field>
            <Field label="Public port">
              <Input type="number" value={draft.publicPort} onChange={(event) => setDraft({ ...draft, publicPort: Number(event.target.value) })} />
            </Field>
            <Field label="Router target port">
              <Input type="number" value={draft.hostProxyPort} onChange={(event) => setDraft({ ...draft, hostProxyPort: Number(event.target.value) })} />
            </Field>
          </div>
          <AddressBlock
            label="Player invite address"
            value={formatMinecraftAddress(draft.publicDomain || server.public_domain, draft.publicPort || server.public_port) || "Set a public domain first"}
          />
          <p className="text-xs text-[#8E9299]">
            {isDefaultMinecraftPort(draft.publicPort)
              ? "Port 25565 is default; players can enter only the domain."
              : `Players must include :${draft.publicPort}.`}
          </p>
          <Button className="control-button bg-brand-primary text-black hover:bg-white" onClick={saveNetwork} disabled={busy}>Save Join Address</Button>
        </div>
      </Panel>

      <Panel title="Server Properties" icon={Settings}>
        <div className="grid gap-4">
          <Field label="MOTD">
            <Textarea value={draft.motd} onChange={(event) => setDraft({ ...draft, motd: event.target.value })} />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Max players">
              <Input type="number" value={draft.maxPlayers} onChange={(event) => setDraft({ ...draft, maxPlayers: Number(event.target.value) })} />
            </Field>
            <Field label="View distance">
              <Input type="number" value={draft.viewDistance} onChange={(event) => setDraft({ ...draft, viewDistance: Number(event.target.value) })} />
            </Field>
            <Field label="Game mode">
              <Select value={draft.gamemode} onValueChange={(gamemode) => setDraft({ ...draft, gamemode })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="survival">Survival</SelectItem>
                  <SelectItem value="creative">Creative</SelectItem>
                  <SelectItem value="adventure">Adventure</SelectItem>
                  <SelectItem value="spectator">Spectator</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Difficulty">
              <Select value={draft.difficulty} onValueChange={(difficulty) => setDraft({ ...draft, difficulty })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="peaceful">Peaceful</SelectItem>
                  <SelectItem value="easy">Easy</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="hard">Hard</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Spawn protection">
              <Input type="number" value={draft.spawnProtection} onChange={(event) => setDraft({ ...draft, spawnProtection: Number(event.target.value) })} />
            </Field>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <CheckField label="PVP" checked={draft.pvp} onChange={(pvp) => setDraft({ ...draft, pvp })} />
            <CheckField label="Online mode" checked={draft.onlineMode} onChange={(onlineMode) => setDraft({ ...draft, onlineMode })} />
            <CheckField label="Allow flight" checked={draft.allowFlight} onChange={(allowFlight) => setDraft({ ...draft, allowFlight })} />
            <CheckField label="Enforce whitelist" checked={draft.enforceWhitelist} onChange={(enforceWhitelist) => setDraft({ ...draft, enforceWhitelist })} />
          </div>
          <Button className="control-button bg-brand-primary text-black hover:bg-white" onClick={saveProperties} disabled={busy}>Save and Restart</Button>
        </div>
      </Panel>

      <Panel title="JVM Settings" icon={Activity}>
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2">
            <MemoryField label="Initial heap (-Xms)" value={draft.jvmXms} unit={draft.jvmXmsUnit} onValue={(jvmXms) => setDraft({ ...draft, jvmXms })} onUnit={(jvmXmsUnit) => setDraft({ ...draft, jvmXmsUnit })} />
            <MemoryField label="Maximum heap (-Xmx)" value={draft.jvmXmx} unit={draft.jvmXmxUnit} onValue={(jvmXmx) => setDraft({ ...draft, jvmXmx })} onUnit={(jvmXmxUnit) => setDraft({ ...draft, jvmXmxUnit })} />
          </div>
          <Field label="Garbage collector">
            <Select value={draft.jvmGc} onValueChange={(jvmGc) => setDraft({ ...draft, jvmGc })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="g1gc">G1GC</SelectItem>
                <SelectItem value="zgc">ZGC</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Custom flags">
            <Input value={draft.jvmCustomFlags} onChange={(event) => setDraft({ ...draft, jvmCustomFlags: event.target.value })} className="font-mono" />
          </Field>
          <Button className="control-button bg-brand-primary text-black hover:bg-white" onClick={saveJvm} disabled={busy}>Apply JVM Settings</Button>
        </div>
      </Panel>

      <Panel title="Minecraft Version" icon={Package}>
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-[12rem_1fr_auto] md:items-end">
            <Field label="Server type">
              <Select value={versionType} onValueChange={(value) => setVersionType(value as typeof versionType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paper">Paper</SelectItem>
                  <SelectItem value="vanilla">Vanilla</SelectItem>
                  <SelectItem value="fabric">Fabric</SelectItem>
                  <SelectItem value="forge">Forge</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Minecraft version">
              <Input value={newVersion} onChange={(event) => setNewVersion(event.target.value)} />
            </Field>
            <Button className="control-button bg-brand-primary text-black hover:bg-white" onClick={changeVersion} disabled={busy}>Change Version</Button>
          </div>

          {serverSupportsPlugins(server) && (
            <>
              <Separator />
              <p className="text-sm text-[#8E9299]">Install common Paper plugins from Modrinth.</p>
              <div className="grid gap-2 md:grid-cols-2">
                {Object.keys(plugins).map((plugin) => (
                  <CheckField
                    key={plugin}
                    label={plugin}
                    checked={plugins[plugin]}
                    onChange={(checked) => setPlugins((current) => ({ ...current, [plugin]: checked }))}
                  />
                ))}
              </div>
              <Button variant="outline" className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-brand-primary hover:text-black" onClick={installPlugins} disabled={busy}>
                Install Selected Plugins
              </Button>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}

function PublicServersPage({
  serverName,
  onPublicHome,
  onAdminAccess,
}: {
  serverName?: string;
  onPublicHome: () => void;
  onAdminAccess: () => void;
}) {
  const [servers, setServers] = useState<PublicServerRow[]>([]);
  const [liveStatus, setLiveStatus] = useState<"checking" | "live" | "syncing">("checking");
  const [message, setMessage] = useState("");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getPublicServers();
      setServers(Array.isArray(data) ? data : []);
      setMessage("");
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load running servers");
    }
  }, []);

  useEffect(() => {
    let fallbackInterval: number | undefined;
    let fallbackTimer: number | undefined;
    let source: EventSource | null = null;

    const stopFallback = () => {
      if (fallbackInterval) {
        window.clearInterval(fallbackInterval);
        fallbackInterval = undefined;
      }
      if (fallbackTimer) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
    };

    const startFallback = () => {
      if (fallbackInterval) return;
      setLiveStatus("syncing");
      void load();
      fallbackInterval = window.setInterval(() => void load(), 10000);
    };

    if ("EventSource" in window) {
      setLiveStatus("checking");
      fallbackTimer = window.setTimeout(startFallback, 12000);
      source = api.subscribePublicServerEvents(
        (state) => {
          stopFallback();
          setServers(Array.isArray(state.servers) ? state.servers : []);
          setLastUpdated(state.generatedAt);
          setMessage("");
          setLiveStatus("live");
        },
        () => startFallback()
      );
    } else {
      startFallback();
    }

    return () => {
      source?.close();
      stopFallback();
    };
  }, [load]);

  const visibleServers = serverName
    ? servers.filter((server) => server.name === serverName)
    : servers;
  const liveLabel = liveStatus === "live"
    ? "Live updates"
    : liveStatus === "syncing"
      ? "Syncing"
      : "Checking";
  const heading = serverName || "Server List";
  const emptyTitle = serverName ? "Offline" : "No Online Servers";

  return (
    <TooltipProvider>
      <main className="min-h-screen bg-black text-white lg:flex">
        <PublicSidebar
          liveStatus={liveStatus}
          liveLabel={liveLabel}
          onPublicHome={onPublicHome}
          onAdminAccess={onAdminAccess}
        />
        <section className="min-w-0 flex-1">
          <header className="border-b border-[#1a1a1a] bg-[#050505] px-4 py-5 lg:hidden">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <button type="button" onClick={onPublicHome} className="flex items-center gap-3 text-left">
                <div className="h-3 w-3 bg-brand-primary shadow-[0_0_12px_rgba(190,242,100,0.45)]" />
                <div>
                  <p className="font-display text-xl font-extrabold uppercase tracking-tight text-white">Minecraft</p>
                  <p className="font-mono text-[9px] font-bold uppercase tracking-[0.25em] text-neutral-700">Server Portal</p>
                </div>
              </button>
              <Button variant="outline" className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-brand-primary hover:text-black" onClick={onAdminAccess}>
                <KeyRound className="mr-2 h-4 w-4" />
                Admin
              </Button>
            </div>
          </header>

        <div className="mx-auto max-w-7xl px-4 py-10 lg:px-10">
          <div className="mb-10 flex flex-col gap-5 border-b border-white/5 pb-8 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="control-label text-brand-primary">Servers</p>
              <h1 className="mt-3 font-display text-5xl font-black uppercase leading-none tracking-tight text-white md:text-6xl">
                {heading}
              </h1>
              <p className="mt-4 max-w-2xl text-sm text-neutral-500">Online servers only.</p>
            </div>
            <div className="text-left md:text-right">
              <p className="control-label">Last update</p>
              <p className="mt-2 font-mono text-xs font-bold uppercase tracking-[0.12em] text-neutral-400">
                {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "Waiting"}
              </p>
            </div>
          </div>

          {message && (
            <div className="mb-6 border border-amber-400/25 bg-amber-400/5 p-4 text-xs font-bold uppercase tracking-[0.16em] text-amber-200">
              {message}
            </div>
          )}

          {visibleServers.length === 0 ? (
            <div className="grid min-h-[20rem] place-items-center border border-dashed border-[#1a1a1a] bg-[#050505] p-8 text-center">
              <div>
                <Server className="mx-auto mb-5 h-10 w-10 text-neutral-800" />
                <p className="text-sm font-bold uppercase tracking-[0.18em] text-neutral-400">
                  {emptyTitle}
                </p>
                <Button className="control-button mt-6 bg-brand-primary text-black hover:bg-white" onClick={onAdminAccess}>
                  <KeyRound className="mr-2 h-4 w-4" />
                  Admin
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              {visibleServers.map((server) => (
                <PublicServerCard key={server.name} server={server} />
              ))}
            </div>
          )}
        </div>
        </section>
      </main>
    </TooltipProvider>
  );
}

function PublicSidebar({
  liveStatus,
  liveLabel,
  onPublicHome,
  onAdminAccess,
}: {
  liveStatus: "checking" | "live" | "syncing";
  liveLabel: string;
  onPublicHome: () => void;
  onAdminAccess: () => void;
}) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-[#1a1a1a] bg-black lg:flex">
      <div className="flex h-24 items-center border-b border-[#1a1a1a] px-8">
        <button type="button" onClick={onPublicHome} className="flex items-center gap-3 text-left">
          <div className="h-3 w-3 bg-brand-primary shadow-[0_0_12px_rgba(190,242,100,0.45)]" />
          <div>
            <p className="font-display text-xl font-extrabold uppercase tracking-tight text-white">Server</p>
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.25em] text-neutral-700">Portal</p>
          </div>
        </button>
      </div>

      <nav className="flex-1 space-y-8 p-6">
        <div>
          <h4 className="mb-4 px-4 text-[10px] font-bold uppercase tracking-[0.22em] text-neutral-700">
            Servers
          </h4>
          <div className="space-y-1">
            <SidebarButton active icon={Server} label="Server List" onClick={onPublicHome} />
          </div>
        </div>

        <div>
          <h4 className="mb-4 px-4 text-[10px] font-bold uppercase tracking-[0.22em] text-neutral-700">
            Admin
          </h4>
          <div className="space-y-1">
            <SidebarButton active={false} icon={KeyRound} label="Login" onClick={onAdminAccess} />
          </div>
        </div>
      </nav>

      <div className="space-y-3 border-t border-[#1a1a1a] p-6">
        <div className="flex items-center gap-3 border border-[#1f1f1f] bg-[#0a0a0a] px-4 py-3 text-neutral-500">
          <div className={`status-square ${liveStatus === "live" ? "bg-brand-primary shadow-[0_0_10px_rgba(190,242,100,0.85)]" : ""}`} />
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-600">Server State</p>
            <p className="mt-1 text-xs font-bold uppercase tracking-[0.12em] text-neutral-400">{liveLabel}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}

function PublicServerCard({ server }: { server: PublicServerRow }) {
  const inviteText = [
    `${server.name}`,
    `IP: ${server.public_address}`,
    `Version: ${server.mc_version}`,
    `Type: ${server.edition}`,
    server.requires_client_mods && server.modpack_url
      ? `Mods: download the modpack from ${window.location.origin}${server.modpack_url}`
      : "Mods: no client modpack is required unless an admin says otherwise.",
  ].join("\n");

  return (
    <section className="control-surface grid min-h-[24rem] gap-6 p-6 md:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <div className="mb-8 flex flex-wrap items-center gap-3">
          <div className="status-square bg-brand-primary shadow-[0_0_10px_rgba(190,242,100,0.85)]" />
          <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-brand-primary">Online</span>
          <span className="h-1 w-1 bg-neutral-800" />
          <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-neutral-600">
            {server.edition} v{server.mc_version}
          </span>
        </div>

        <h2 className="font-display text-4xl font-black uppercase leading-none tracking-tight text-white">
          {server.name}
        </h2>
        {server.description && (
          <p className="mt-4 max-w-xl text-sm text-neutral-500">{server.description}</p>
        )}

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <Metric label="Players" value={`${server.players.online}/${server.players.max}`} />
          <Metric label="Version" value={server.version || server.mc_version} />
          <Metric label="Latency" value={server.latency === null ? "N/A" : `${server.latency}ms`} />
        </div>

        <div className="mt-8">
          <AddressBlock label="IP" value={server.public_address} />
        </div>
      </div>

      <div className="flex min-w-[13rem] flex-col justify-end gap-3">
        <Button
          className="control-button bg-brand-primary text-black hover:bg-white"
          onClick={async () => {
            if (await copyToClipboard(server.public_address)) toast.success("IP copied");
          }}
        >
          <Copy className="mr-2 h-4 w-4" />
          Copy IP
        </Button>
        <Button
          variant="outline"
          className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-white/5 hover:text-white"
          onClick={async () => {
            if (await copyToClipboard(inviteText)) toast.success("Invite copied");
          }}
        >
          <Copy className="mr-2 h-4 w-4" />
          Copy Invite
        </Button>
        {server.modpack_url && (
          <Button
            variant="outline"
            className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-white/5 hover:text-white"
            onClick={() => {
              window.location.href = server.modpack_url || "#";
            }}
          >
            <Download className="mr-2 h-4 w-4" />
            Pack
          </Button>
        )}
      </div>
    </section>
  );
}

function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-[min(94vw,48rem)] max-w-none overflow-y-auto rounded-sm">
        <DialogHeader>
          <DialogTitle>Minecraft Server Help</DialogTitle>
          <DialogDescription>Quick checklist for running servers and helping friends join.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 text-sm text-[#8E9299]">
          <GuideSection title="Pick A Server">
            Use Servers for the three active slots. Open a server, check that it is running, then copy the join address from Overview.
          </GuideSection>
          <GuideSection title="Help A Friend Join">
            Send the Friend Join Page. They open Java Edition, choose Multiplayer, add a server, and paste the public join address. If public access says restricted, use the LAN address only for friends on the same Wi-Fi until port forwarding is fixed.
          </GuideSection>
          <GuideSection title="Mods And Plugins">
            Paper servers use plugins. Fabric, Forge, and NeoForge servers require matching client mods. Use Content to copy a friend setup guide or share the modpack before anyone joins.
          </GuideSection>
          <GuideSection title="Worlds">
            Use Worlds to switch maps, upload a zip, generate a new seed or world type, download backups, and delete old worlds. The active world must be switched before it can be deleted.
          </GuideSection>
          <GuideSection title="Players And Safety">
            Use Players for allowed players, operators, player bans, and IP bans. Turn on whitelist enforcement in Settings before relying on the allowed-player list.
          </GuideSection>
          <GuideSection title="Settings That Matter">
            Server Properties cover MOTD, max players, gamemode, difficulty, PVP, view distance, and whitelist enforcement. Join Address controls what friends paste into Minecraft. JVM settings are for memory and Java flags.
          </GuideSection>
          <GuideSection title="When Something Breaks">
            Check Overview for server status, join addresses, public access, and console logs. Try Restart. If friends still cannot join, compare Minecraft version, loader, mod list, join address, and whitelist status.
          </GuideSection>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="control-label">{label}</span>
      {children}
    </label>
  );
}

function Panel({ title, icon: Icon, children }: { title: string; icon: typeof Activity; children: React.ReactNode }) {
  return (
    <section className="control-surface">
      <div className="flex items-center gap-3 border-b border-[#1a1a1a] bg-[#0c0c0c] px-4 py-3">
        <Icon className="h-4 w-4 text-brand-primary" />
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-neutral-500">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-neutral-700">{label}</p>
      <p className="truncate font-mono text-xs font-bold text-white" title={value}>{value}</p>
    </div>
  );
}

function MetricCell({
  label,
  value,
  mono,
  tone = "default",
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "default" | "primary" | "muted";
}) {
  return (
    <div className="border-b border-r border-[#1a1a1a] p-6 last:border-r-0">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-neutral-600">{label}</p>
      <p
        className={`truncate text-lg font-black uppercase leading-none tracking-tight ${
          mono ? "font-mono" : "font-display"
        } ${
          tone === "primary" ? "text-brand-primary" : tone === "muted" ? "text-neutral-700" : "text-white"
        }`}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function AddressBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="control-label">{label}</p>
      <code className="mt-2 block rounded-none border border-[#1f1f1f] bg-black px-4 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-neutral-300 break-all transition hover:border-brand-primary">
        {value}
      </code>
    </div>
  );
}

function PlayerPanel({ title, icon: Icon, children }: { title: string; icon: typeof Users; children: React.ReactNode }) {
  return (
    <section className="control-surface min-h-[32rem]">
      <div className="flex items-center gap-3 border-b border-[#1a1a1a] bg-[#0c0c0c] px-4 py-3">
        <Icon className="h-4 w-4 text-brand-primary" />
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-neutral-500">{title}</h2>
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

function InlineAdd({
  value,
  onChange,
  onAdd,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onAdd: () => void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onAdd();
        }}
        placeholder={placeholder}
      />
      <Button variant="outline" className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-brand-primary hover:text-black" onClick={onAdd} disabled={disabled}>Add</Button>
    </div>
  );
}

function NameList({
  names,
  empty,
  actionLabel,
  onAction,
}: {
  names: string[];
  empty: string;
  actionLabel: string;
  onAction: (name: string) => void;
}) {
  if (names.length === 0) return <p className="py-8 text-center text-sm text-[#8E9299]">{empty}</p>;
  return (
    <div className="space-y-2">
      {names.map((name) => (
        <div key={name} className="flex items-center justify-between gap-3 border border-[#1a1a1a] bg-black p-3">
          <span className="font-medium text-white">{name}</span>
          <Button variant="ghost" size="sm" className="rounded-none text-neutral-500 hover:bg-white/5 hover:text-white" onClick={() => onAction(name)}>
            {actionLabel}
          </Button>
        </div>
      ))}
    </div>
  );
}

function BanRow({ label, reason, onPardon }: { label: string; reason?: string; onPardon: () => Promise<void> }) {
  return (
    <div className="flex items-center justify-between gap-3 border border-[#1a1a1a] bg-black p-3">
      <div className="min-w-0">
        <p className="truncate font-medium text-white">{label}</p>
        {reason && <p className="truncate text-xs text-[#8E9299]">{reason}</p>}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="rounded-none text-brand-primary hover:bg-white/5 hover:text-white"
        onClick={() => {
          void onPardon().then(() => toast.success("Pardoned"));
        }}
      >
        <Check className="h-4 w-4" />
      </Button>
    </div>
  );
}

function UploadButton({
  label,
  accept,
  disabled,
  onFile,
}: {
  label: string;
  accept: string;
  disabled?: boolean;
  onFile: (file: File | undefined) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          onFile(file);
        }}
      />
      <Button variant="outline" className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-white/5 hover:text-white" disabled={disabled} onClick={() => inputRef.current?.click()}>
        <Upload className="mr-2 h-4 w-4" />
        {label}
      </Button>
    </>
  );
}

function RecommendedPlugins({ server, onRefresh }: { server: ServerRow; onRefresh: () => Promise<void> | void }) {
  const plugins = ["luckperms", "essentialsx", "vault", "worldedit"];
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const install = async () => {
    const requested = plugins.filter((plugin) => selected[plugin]);
    if (requested.length === 0) return;
    setBusy(true);
    try {
      const result = await api.installRecommendedPlugins(server.name, requested);
      if (result.failed?.length) {
        throw new Error(result.failed.map((entry) => `${entry.plugin}: ${entry.error}`).join("; "));
      }
      toast.success(`Installed plugins: ${result.installed.join(", ")}`);
      setSelected({});
      await onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to install plugins");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        {plugins.map((plugin) => (
          <CheckField
            key={plugin}
            label={plugin}
            checked={Boolean(selected[plugin])}
            onChange={(checked) => setSelected((current) => ({ ...current, [plugin]: checked }))}
          />
        ))}
      </div>
      <Button variant="outline" className="control-button border-[#1f1f1f] bg-black text-neutral-300 hover:bg-brand-primary hover:text-black" onClick={install} disabled={busy}>
        Install Selected
      </Button>
    </div>
  );
}

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 border border-[#1a1a1a] bg-black p-3 text-sm text-white">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(Boolean(value))} />
      <span className="capitalize">{label}</span>
    </label>
  );
}

function MemoryField({
  label,
  value,
  unit,
  onValue,
  onUnit,
}: {
  label: string;
  value: number;
  unit: string;
  onValue: (value: number) => void;
  onUnit: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Input type="number" value={value} onChange={(event) => onValue(Number(event.target.value))} />
        <Select value={unit} onValueChange={onUnit}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="M">MB</SelectItem>
            <SelectItem value="G">GB</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </Field>
  );
}

function GuideSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-[#2C2E33] pb-4 last:border-b-0">
      <h3 className="text-base font-semibold text-white">{title}</h3>
      <p className="mt-1">{children}</p>
    </section>
  );
}
