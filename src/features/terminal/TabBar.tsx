import { Plus, X } from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { cn } from "../../lib/utils";

export function TabBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const closeSession = useSessionStore((s) => s.closeSession);
  const openLocalSession = useSessionStore((s) => s.openLocalSession);

  if (sessions.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-1 border-b border-border bg-surface px-1 pt-1">
      {sessions.map((session) => {
        const active = session.id === activeSessionId;
        return (
          <div
            key={session.id}
            className={cn(
              "group flex min-w-0 max-w-48 items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-sm",
              active
                ? "border-border bg-background text-foreground"
                : "border-transparent text-muted hover:bg-raised hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => setActiveSession(session.id)}
              className="min-w-0 flex-1 truncate py-1.5 text-left"
            >
              {session.title}
            </button>
            <button
              type="button"
              aria-label={`Close ${session.title}`}
              onClick={() => closeSession(session.id)}
              className={cn(
                "shrink-0 rounded p-0.5 hover:bg-raised hover:text-danger",
                active ? "" : "invisible group-hover:visible",
              )}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New local terminal"
        title="New local terminal"
        onClick={openLocalSession}
        className="my-auto flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-foreground"
      >
        <Plus size={15} />
      </button>
    </div>
  );
}
