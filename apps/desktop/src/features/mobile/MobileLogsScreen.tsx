import { Circle, Clock, ScrollText, Server } from "lucide-react";
import { useRecentHosts } from "../../hooks/useHosts";
import { useSessionLogStore } from "../../stores/sessionLogStore";
import { useSessionStore } from "../../stores/sessionStore";
import { MobileScreen } from "./MobileScreen";

/*
 * Connection history and session activity — the two things Luma actually
 * records. Recents come from the backend's per-device history (`recent_hosts_list`,
 * not vault-scoped), and active recordings come from sessionLogStore, which
 * tracks which live sessions the backend is capturing to disk.
 *
 * Deliberately not a transcript browser: session capture is runtime-only (the
 * backend stops on exit and nothing indexes past captures), so there is no
 * archive to list. This screen shows what exists rather than implying more.
 */

export function MobileLogsScreen({ onBack }: { onBack: () => void }) {
  const { data: recents, isLoading } = useRecentHosts();
  const logs = useSessionLogStore((s) => s.logs);
  const sessions = useSessionStore((s) => s.sessions);

  const recording = Object.entries(logs).filter(([, entry]) => entry.active);

  return (
    <MobileScreen title="Logs" onBack={onBack}>
      {recording.length > 0 && (
        <section className="mt-3">
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
            Recording now
          </h2>
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface">
            {recording.map(([sessionId, entry]) => (
              <li key={sessionId} className="flex items-center gap-3 px-4 py-3">
                <Circle
                  size={10}
                  className="shrink-0 animate-pulse fill-danger text-danger"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[17px] leading-tight">
                    {sessions.find((s) => s.id === sessionId)?.title ?? "Session"}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-muted">
                    {entry.path}
                  </span>
                </span>
                <span className="shrink-0 text-xs uppercase text-muted">
                  {entry.mode}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6 first:mt-3">
        <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
          Recent connections
        </h2>
        {isLoading && <p className="py-6 text-center text-sm text-muted">Loading…</p>}
        {!isLoading && (recents ?? []).length === 0 && (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface">
              <ScrollText size={24} className="text-accent" />
            </div>
            <p className="text-base font-semibold">No connection history</p>
            <p className="text-sm text-muted">
              Hosts you connect to will appear here.
            </p>
          </div>
        )}
        {(recents ?? []).length > 0 && (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface">
            {(recents ?? []).map((host) => (
              <li key={host.id} className="flex items-center gap-3 px-4 py-3">
                <Server size={20} strokeWidth={1.75} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[17px] leading-tight">
                    {host.name}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-muted">
                    {host.username ? `${host.username}@` : ""}
                    {host.hostname}:{host.port}
                  </span>
                </span>
                <Clock size={15} className="shrink-0 text-muted" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </MobileScreen>
  );
}
