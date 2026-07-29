import { AlertTriangle, MoveRight, Play, Square } from "lucide-react";
import { useAllPortForwards } from "../../hooks/usePortForwards";
import { useHosts } from "../../hooks/useHosts";
import { useTunnelStore } from "../../stores/tunnelStore";
import { useBrowsingVaultId } from "../../stores/vaultStore";
import type { PortForward } from "../../lib/portForwards";
import { MobileScreen } from "./MobileScreen";
import { cn } from "../../lib/utils";

/*
 * Vault-level port forwarding: every stored forward for the active vault's
 * hosts, grouped by host, with start/stop for each. The desktop reaches
 * forwards through one host's editor dialog; on mobile a flat list is the more
 * useful shape, since the tab is "what tunnels do I have" rather than "edit this
 * host". Editing still lives in the host editor — this screen runs them.
 */

export function MobilePortForwardsScreen({ onBack }: { onBack: () => void }) {
  const vaultId = useBrowsingVaultId();
  const { data: forwards, isLoading } = useAllPortForwards();
  const { data: hosts } = useHosts(vaultId);

  const hostsById = new Map((hosts ?? []).map((host) => [host.id, host]));
  // Scope to the browsing vault by way of its hosts: forwards hang off hosts,
  // so a forward is in-scope exactly when its host is.
  const visible = (forwards ?? []).filter((forward) =>
    hostsById.has(forward.hostId),
  );

  const groups = new Map<string, PortForward[]>();
  for (const forward of visible) {
    const list = groups.get(forward.hostId) ?? [];
    list.push(forward);
    groups.set(forward.hostId, list);
  }

  return (
    <MobileScreen title="Port Forwarding" onBack={onBack}>
      {isLoading && <p className="py-8 text-center text-sm text-muted">Loading…</p>}

      {!isLoading && visible.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface">
            <MoveRight size={24} className="text-accent" />
          </div>
          <p className="text-base font-semibold">No port forwards</p>
          <p className="text-sm text-muted">
            Add local, remote, or dynamic tunnels from a host's editor, then start
            them here.
          </p>
        </div>
      )}

      {[...groups.entries()].map(([hostId, list]) => (
        <section key={hostId} className="mt-6 first:mt-3">
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
            {hostsById.get(hostId)?.name ?? "Unknown host"}
          </h2>
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface">
            {list.map((forward) => (
              <ForwardRow key={forward.id} forward={forward} />
            ))}
          </ul>
        </section>
      ))}
    </MobileScreen>
  );
}

function ForwardRow({ forward }: { forward: PortForward }) {
  const tunnels = useTunnelStore((s) => s.tunnels);
  const pending = useTunnelStore((s) => s.pending[forward.id]);
  const error = useTunnelStore((s) => s.startErrors[forward.id]);
  const start = useTunnelStore((s) => s.start);
  const stop = useTunnelStore((s) => s.stop);

  const running = Object.values(tunnels).find(
    (entry) => entry.portForwardId === forward.id && entry.status === "running",
  );

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[17px] leading-tight">
          {forward.name}
        </span>
        <span className="mt-0.5 block truncate font-mono text-xs text-muted">
          {describeForward(forward)}
        </span>
        {error && (
          <span className="mt-1 flex items-center gap-1 text-xs text-danger">
            <AlertTriangle size={12} className="shrink-0" />
            <span className="min-w-0 truncate">{error}</span>
          </span>
        )}
      </span>
      <button
        type="button"
        disabled={pending}
        aria-label={`${running ? "Stop" : "Start"} ${forward.name}`}
        onClick={() => {
          if (running) void stop(running.tunnelId);
          else void start(forward);
        }}
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors",
          running
            ? "border-accent/40 bg-accent/15 text-accent"
            : "border-border text-muted active:bg-raised",
          pending && "opacity-50",
        )}
      >
        {running ? <Square size={16} /> : <Play size={16} />}
      </button>
    </li>
  );
}

/** Mirrors the desktop dialog's summary line so both surfaces read alike. */
function describeForward(forward: PortForward): string {
  const bind = forward.bindAddress || "127.0.0.1";
  if (forward.type === "local") {
    return `${bind}:${forward.localPort} → ${forward.destinationHost}:${forward.destinationPort}`;
  }
  if (forward.type === "remote") {
    return `remote ${bind}:${forward.remotePort} → ${forward.destinationHost}:${forward.destinationPort}`;
  }
  return `SOCKS ${bind}:${forward.localPort}`;
}
