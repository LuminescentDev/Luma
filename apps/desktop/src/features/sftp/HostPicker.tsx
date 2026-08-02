import { useMemo } from "react";
import { FolderOpen, Loader2, Monitor, Server } from "lucide-react";
import { useHosts, useRecentHosts } from "../../hooks/useHosts";
import { useBrowsingVaultId } from "../../stores/vaultStore";
import { useSftpStore, type PaneSide } from "../../stores/sftpStore";
import { describeSshError, sshCategoryLabel } from "../hosts/sshErrors";
import { cn } from "../../lib/utils";
import type { Host } from "../../lib/hosts";

/*
 * Endpoint picker for an empty SFTP pane: this computer (desktop only) or a
 * saved host. Recently used hosts float to the top. Connect failures surface
 * via describeSshError (the same readable mapping the terminal uses).
 *
 * "page" fills the screen (mobile, which has no local pane); "pane" is the
 * compact variant that sits inside one half of the desktop browser.
 */

type HostPickerProps = {
  /** Pane the chosen endpoint is assigned to. */
  side: PaneSide;
  variant?: "page" | "pane";
  /** Offer "This computer" alongside the hosts. */
  allowLocal?: boolean;
  /** Local is offered but unavailable because the other pane already holds it. */
  localDisabled?: boolean;
};

export function HostPicker({
  side,
  variant = "page",
  allowLocal = false,
  localDisabled = false,
}: HostPickerProps) {
  const { data: hosts } = useHosts(useBrowsingVaultId());
  const { data: recent } = useRecentHosts();
  const connect = useSftpStore((s) => s.connect);
  const setPaneLocal = useSftpStore((s) => s.setPaneLocal);
  const connectingHostId = useSftpStore((s) => s.connecting[side]);
  const connectError = useSftpStore((s) => s.connectError[side]);
  const clearConnectError = useSftpStore((s) => s.clearConnectError);

  const ordered = useMemo(() => {
    const all = hosts ?? [];
    const recentIds = (recent ?? []).map((h) => h.id);
    const rank = new Map(recentIds.map((id, i) => [id, i]));
    return [...all].sort((a, b) => {
      const ra = rank.has(a.id) ? (rank.get(a.id) as number) : Infinity;
      const rb = rank.has(b.id) ? (rank.get(b.id) as number) : Infinity;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
  }, [hosts, recent]);

  const compact = variant === "pane";

  const error = connectError && (
    <div
      className={cn(
        "bg-danger/10 text-xs text-danger",
        compact
          ? "border-b border-danger/30 px-3 py-2"
          : "rounded-lg border border-danger/40 px-3 py-2.5",
      )}
    >
      <div className="font-semibold">{sshCategoryLabel(connectError.category)}</div>
      <p className="mt-0.5 text-danger/90">
        {describeSshError(connectError.category, connectError.message)}
      </p>
      <button
        type="button"
        onClick={() => clearConnectError(side)}
        className="mt-1.5 text-[11px] underline hover:no-underline"
      >
        Dismiss
      </button>
    </div>
  );

  // In a pane the options are list rows, matching the file list they replace;
  // the full-page variant keeps its cards.
  const localOption = allowLocal && (
    <button
      type="button"
      onClick={() => setPaneLocal(side)}
      disabled={localDisabled}
      title={
        localDisabled
          ? "The other pane is already showing this computer"
          : undefined
      }
      className={cn(
        "flex w-full items-center text-left",
        compact
          ? "gap-2.5 px-3 py-2 hover:bg-raised disabled:opacity-50 disabled:hover:bg-transparent"
          : "gap-3 rounded-xl bg-raised px-4 py-3 transition-all hover:ring-1 hover:ring-accent disabled:opacity-50 disabled:hover:ring-0",
      )}
    >
      {compact ? (
        <Monitor size={15} className="shrink-0 text-accent" />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <Monitor size={18} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate font-medium text-foreground",
            compact ? "text-xs" : "text-sm font-semibold",
          )}
        >
          This computer
        </span>
        <span
          className={cn(
            "block truncate text-muted",
            compact ? "text-[11px]" : "text-xs",
          )}
        >
          {localDisabled
            ? "Already open in the other pane"
            : "Browse local files"}
        </span>
      </span>
    </button>
  );

  const list =
    ordered.length === 0 ? (
      <div
        className={cn(
          "flex flex-col items-center justify-center text-center",
          compact
            ? "flex-1 px-4 py-10"
            : "min-h-48 rounded-xl border border-dashed border-border bg-surface/50",
        )}
      >
        <Server size={compact ? 18 : 24} className="text-muted" />
        <p className={cn("mt-2 font-medium", compact ? "text-xs" : "text-sm")}>
          No saved hosts
        </p>
        <p className={cn("mt-1 text-muted", compact ? "text-[11px]" : "text-xs")}>
          Add an SSH host in the Hosts section, then connect here.
        </p>
      </div>
    ) : compact ? (
      <ul role="list">
        {ordered.map((host) => (
          <li key={host.id}>
            <HostRow
              host={host}
              connecting={connectingHostId === host.id}
              disabled={connectingHostId !== null}
              onConnect={() => void connect(host.id, side)}
            />
          </li>
        ))}
      </ul>
    ) : (
      <div className="grid gap-2.5 sm:grid-cols-2">
        {ordered.map((host) => (
          <HostCard
            key={host.id}
            host={host}
            connecting={connectingHostId === host.id}
            disabled={connectingHostId !== null}
            onConnect={() => void connect(host.id, side)}
          />
        ))}
      </div>
    );

  if (compact) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error}
        {localOption}
        {allowLocal && ordered.length > 0 && (
          <div className="my-1 h-px bg-border" />
        )}
        {list}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <FolderOpen size={22} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">SFTP</h1>
        <p className="mt-1 text-sm text-muted">
          Connect to a saved host to browse and transfer files.
        </p>

        {connectError && <div className="mt-5">{error}</div>}

        <div className="mt-6 space-y-2.5">
          {localOption}
          {list}
        </div>
      </div>
    </div>
  );
}

function HostRow({
  host,
  connecting,
  disabled,
  onConnect,
}: {
  host: Host;
  connecting: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={disabled}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-raised disabled:opacity-60 disabled:hover:bg-transparent"
    >
      {connecting ? (
        <Loader2 size={15} className="shrink-0 animate-spin text-accent" />
      ) : (
        <Server size={15} className="shrink-0 text-accent" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">
          {host.name}
        </span>
        <span className="block truncate text-[11px] text-muted">
          {host.username ? `${host.username}@` : ""}
          {host.hostname}:{host.port}
        </span>
      </span>
      {connecting && (
        <span className="shrink-0 text-[11px] font-medium text-accent">
          Connecting…
        </span>
      )}
    </button>
  );
}

function HostCard({
  host,
  connecting,
  disabled,
  onConnect,
}: {
  host: Host;
  connecting: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={disabled}
      className="flex items-center gap-3 rounded-xl bg-raised px-4 py-3 text-left transition-all hover:ring-1 hover:ring-accent disabled:opacity-60 disabled:hover:ring-0"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
        {connecting ? (
          <Loader2 size={18} className="animate-spin" />
        ) : (
          <Server size={18} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">
          {host.name}
        </span>
        <span className="block truncate text-xs text-muted">
          {host.username ? `${host.username}@` : ""}
          {host.hostname}:{host.port}
        </span>
      </span>
      <span className="shrink-0 text-[11px] font-medium text-accent">
        {connecting ? "Connecting…" : "Connect"}
      </span>
    </button>
  );
}
