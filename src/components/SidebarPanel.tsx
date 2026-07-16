import { Plus, SquareTerminal, X } from "lucide-react";
import { useSessionStore } from "../stores/sessionStore";
import type { SidebarSection } from "../types";
import { cn } from "../lib/utils";

const TITLES: Record<Exclude<SidebarSection, "settings">, string> = {
  search: "Search",
  hosts: "Hosts",
  sessions: "Sessions",
  sftp: "SFTP",
  snippets: "Snippets",
};

export function SidebarPanel({ section }: { section: Exclude<SidebarSection, "settings"> }) {
  return (
    <div className="flex w-56 flex-col border-r border-border bg-surface">
      <header className="flex h-9 items-center px-3 text-xs font-semibold uppercase tracking-wider text-muted">
        {TITLES[section]}
      </header>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {section === "search" && <SearchPanel />}
        {section === "hosts" && <HostsPanel />}
        {section === "sessions" && <SessionsPanel />}
        {section === "sftp" && (
          <PanelPlaceholder text="The SFTP browser arrives in a later milestone." />
        )}
        {section === "snippets" && (
          <PanelPlaceholder text="Reusable command snippets arrive with the productivity milestone." />
        )}
      </div>
    </div>
  );
}

function SearchPanel() {
  return (
    <div className="space-y-2">
      <input
        type="search"
        placeholder="Search hosts and snippets…"
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted focus:border-accent"
      />
      <p className="px-1 text-xs text-muted">
        Nothing to search yet — add hosts once host management lands.
      </p>
    </div>
  );
}

function HostsPanel() {
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled
        title="Host management arrives in the SSH milestone"
        className="flex w-full cursor-not-allowed items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5 text-sm text-muted"
      >
        <Plus size={14} /> Add host
      </button>
      <p className="px-1 text-xs text-muted">
        Saved SSH hosts and groups will live here.
      </p>
    </div>
  );
}

function SessionsPanel() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const closeSession = useSessionStore((s) => s.closeSession);
  const openLocalSession = useSessionStore((s) => s.openLocalSession);

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={openLocalSession}
        className="mb-2 flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground transition-colors hover:border-accent hover:text-accent"
      >
        <Plus size={14} /> New local terminal
      </button>
      {sessions.length === 0 && (
        <p className="px-1 text-xs text-muted">No open sessions.</p>
      )}
      {sessions.map((session) => (
        <div
          key={session.id}
          className={cn(
            "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            session.id === activeSessionId
              ? "bg-raised text-foreground"
              : "text-muted hover:bg-raised hover:text-foreground",
          )}
        >
          <button
            type="button"
            onClick={() => setActiveSession(session.id)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <SquareTerminal size={14} className="shrink-0" />
            <span className="truncate">{session.title}</span>
          </button>
          <button
            type="button"
            aria-label={`Close ${session.title}`}
            onClick={() => closeSession(session.id)}
            className="hidden shrink-0 rounded p-0.5 hover:text-danger group-hover:block"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function PanelPlaceholder({ text }: { text: string }) {
  return <p className="px-1 text-xs text-muted">{text}</p>;
}
