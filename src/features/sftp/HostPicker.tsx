import { useMemo } from "react";
import { FolderOpen, Loader2, Server } from "lucide-react";
import { useHosts, useRecentHosts } from "../../hooks/useHosts";
import { useSftpStore } from "../../stores/sftpStore";
import { describeSshError, sshCategoryLabel } from "../hosts/sshErrors";
import type { Host } from "../../lib/hosts";

/*
 * Not-connected state for the SFTP screen: pick a saved host to open an SFTP
 * session. Recently used hosts float to the top. Connect failures surface via
 * describeSshError (the same readable mapping the terminal uses).
 */
export function HostPicker() {
  const { data: hosts } = useHosts();
  const { data: recent } = useRecentHosts();
  const connect = useSftpStore((s) => s.connect);
  const connectingHostId = useSftpStore((s) => s.connectingHostId);
  const connectError = useSftpStore((s) => s.connectError);
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

        {connectError && (
          <div className="mt-5 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-xs text-danger">
            <div className="font-semibold">{sshCategoryLabel(connectError.category)}</div>
            <p className="mt-0.5 text-danger/90">
              {describeSshError(connectError.category, connectError.message)}
            </p>
            <button
              type="button"
              onClick={clearConnectError}
              className="mt-1.5 text-[11px] underline hover:no-underline"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="mt-6">
          {ordered.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface/50 text-center">
              <Server size={24} className="text-muted" />
              <p className="mt-2 text-sm font-medium">No saved hosts</p>
              <p className="mt-1 text-xs text-muted">
                Add an SSH host in the Hosts section, then connect here.
              </p>
            </div>
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {ordered.map((host) => (
                <HostCard
                  key={host.id}
                  host={host}
                  connecting={connectingHostId === host.id}
                  disabled={connectingHostId !== null}
                  onConnect={() => void connect(host.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
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
