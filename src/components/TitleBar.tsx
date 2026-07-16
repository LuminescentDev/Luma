import {
  AlertTriangle,
  Cable,
  Cloud,
  CloudAlert,
  Menu,
  Minus,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUiStore } from "../stores/uiStore";
import { selectRunningCount, useTunnelStore } from "../stores/tunnelStore";
import { useSyncConfig } from "../hooks/useSync";
import { useSyncStore } from "../stores/syncStore";

const appWindow = getCurrentWindow();

export function TitleBar() {
  const navOpen = useUiStore((s) => s.navOpen);
  const toggleNav = useUiStore((s) => s.toggleNav);
  const runningTunnels = useTunnelStore(selectRunningCount);
  const { data: syncConfig } = useSyncConfig();
  return (
    <header
      data-tauri-drag-region
      onDoubleClick={() => void appWindow.toggleMaximize()}
      className="flex h-9 shrink-0 select-none items-center border-b border-border bg-surface"
    >
      <button type="button" onClick={toggleNav} onDoubleClick={(event) => event.stopPropagation()} aria-expanded={navOpen} aria-label="Toggle workspace navigation" className={navOpen ? "flex h-full items-center gap-2 border-r border-border bg-raised px-3 text-xs text-foreground" : "flex h-full items-center gap-2 border-r border-border px-3 text-xs text-muted hover:bg-raised hover:text-foreground"}><Menu size={15} className="text-accent" /> Workspace</button>
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2 px-3">
        <span className="h-2 w-2 rounded-full bg-accent shadow-glow" />
        <span className="text-xs font-semibold tracking-wide text-foreground">Luma</span>
        <span className="text-[10px] text-muted">Secure terminal workspace</span>
      </div>
      {runningTunnels > 0 && (
        <div
          title={`${runningTunnels} active tunnel${runningTunnels === 1 ? "" : "s"}`}
          className="mr-2 flex shrink-0 items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-400"
        >
          <Cable size={11} /> {runningTunnels} tunnel{runningTunnels === 1 ? "" : "s"}
        </div>
      )}
      {syncConfig?.enabled && <SyncIndicator />}
      <div className="flex h-full shrink-0 items-stretch">
        <WindowButton label="Minimize" onClick={() => void appWindow.minimize()}>
          <Minus size={15} />
        </WindowButton>
        <WindowButton label="Maximize or restore" onClick={() => void appWindow.toggleMaximize()}>
          <Square size={12} />
        </WindowButton>
        <WindowButton label="Close" destructive onClick={() => void appWindow.close()}>
          <X size={15} />
        </WindowButton>
      </div>
    </header>
  );
}

function SyncIndicator() {
  const status = useSyncStore((s) => s.status);
  const conflictCount = useSyncStore((s) => s.conflicts.length);
  const activate = useSyncStore((s) => s.activate);

  const config: Record<
    string,
    { Icon: typeof Cloud; className: string; label: string; spin?: boolean }
  > = {
    idle: { Icon: Cloud, className: "text-muted hover:text-foreground", label: "Sync now" },
    syncing: { Icon: RefreshCw, className: "text-accent", label: "Syncing…", spin: true },
    error: { Icon: CloudAlert, className: "text-danger", label: "Sync error — retry" },
    conflict: {
      Icon: AlertTriangle,
      className: "text-amber-400",
      label: `${conflictCount} sync conflict${conflictCount === 1 ? "" : "s"} — resolve`,
    },
  };
  const { Icon, className, label, spin } = config[status] ?? config.idle;

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => activate()}
      className={`mr-2 flex shrink-0 items-center rounded-md p-1.5 transition-colors hover:bg-raised ${className}`}
    >
      <Icon size={15} className={spin ? "animate-spin" : undefined} />
    </button>
  );
}

function WindowButton({
  label,
  onClick,
  destructive = false,
  children,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={
        destructive
          ? "flex w-12 items-center justify-center text-muted transition-colors hover:bg-danger hover:text-white"
          : "flex w-12 items-center justify-center text-muted transition-colors hover:bg-raised hover:text-foreground"
      }
    >
      {children}
    </button>
  );
}
