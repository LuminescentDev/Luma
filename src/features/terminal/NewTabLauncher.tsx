import { useEffect, useMemo, useRef, useState } from "react";
import { Clock3, FolderKanban, Search, Server, SquareTerminal, Star } from "lucide-react";
import { useHostGroups, useHosts, useRecentHosts } from "../../hooks/useHosts";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { cn } from "../../lib/utils";

export function NewTabLauncher() {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: hosts = [] } = useHosts();
  const { data: recent = [] } = useRecentHosts();
  const { data: groups = [] } = useHostGroups();
  const openSshSession = useSessionStore((s) => s.openSshSession);
  const openLocalSession = useSessionStore((s) => s.openLocalSession);
  const closeNewTab = useUiStore((s) => s.closeNewTab);

  useEffect(() => inputRef.current?.focus(), []);

  const needle = query.trim().toLowerCase();
  const matchingHosts = useMemo(() => {
    const source = needle ? hosts : recent.length ? recent : hosts;
    return source.filter((host) =>
      [host.name, host.hostname, host.username, ...host.tags]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [hosts, recent, needle]);
  const matchingGroups = groups.filter((group) =>
    group.name.toLowerCase().includes(needle),
  );

  const connect = (host: (typeof hosts)[number]) =>
    void openSshSession(host.id, host.name, host.hostname);
  const openGroup = (groupId: string) => {
    const groupHosts = hosts.filter((host) => host.groupId === groupId);
    if (groupHosts.length) {
      closeNewTab();
      for (const host of groupHosts) void openSshSession(host.id, host.name, host.hostname);
    }
  };

  return (
    <div className="absolute inset-0 overflow-y-auto bg-background px-6 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeNewTab();
              if (event.key === "Enter" && matchingHosts[0]) connect(matchingHosts[0]);
            }}
            placeholder="Search hosts, templates, or commands"
            aria-label="Search hosts and workspace templates"
            className="h-11 w-full rounded-xl border border-border bg-surface pl-11 pr-16 text-sm outline-none transition focus:border-accent focus:shadow-glow"
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-raised px-2 py-0.5 text-[10px] text-muted">ESC</kbd>
        </div>

        {!needle && (
          <button
            type="button"
            onClick={() => void openLocalSession()}
            className="mt-4 flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left text-sm hover:border-accent hover:bg-raised"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent"><SquareTerminal size={16} /></span>
            <span><span className="block font-medium">Local terminal</span><span className="text-xs text-muted">Open your default shell</span></span>
          </button>
        )}

        {matchingGroups.length > 0 && (
          <section className="mt-7 rounded-2xl border border-border bg-surface p-3">
            <h2 className="flex items-center gap-2 px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted"><FolderKanban size={14} /> Workspace templates</h2>
            <div className="space-y-1">
              {matchingGroups.map((group) => {
                const count = hosts.filter((host) => host.groupId === group.id).length;
                return <button key={group.id} type="button" disabled={!count} onClick={() => openGroup(group.id)} className="flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm hover:bg-raised disabled:opacity-45"><span className="font-medium">{group.name}</span><span className="ml-auto text-xs text-muted">{count} connection{count === 1 ? "" : "s"}</span></button>;
              })}
            </div>
          </section>
        )}

        <section className="mt-5 rounded-2xl border border-border bg-surface p-3">
          <h2 className="flex items-center gap-2 px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted">{needle ? <Search size={14} /> : <Clock3 size={14} />} {needle ? "Search results" : "Recent connections"}</h2>
          <div className="space-y-1">
            {matchingHosts.map((host) => (
              <button key={host.id} type="button" onClick={() => connect(host)} className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-raised">
                <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg bg-raised text-muted group-hover:text-accent", host.favorite && "text-amber-400")}>
                  {host.favorite ? <Star size={15} fill="currentColor" /> : <Server size={15} />}
                </span>
                <span className="min-w-0"><span className="block truncate text-sm font-medium">{host.name}</span><span className="block truncate text-xs text-muted">{host.username ? `${host.username}@` : ""}{host.hostname}:{host.port}</span></span>
                <span className="ml-auto text-xs text-muted">SSH</span>
              </button>
            ))}
            {matchingHosts.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">No hosts match “{query}”.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
