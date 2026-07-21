import { ChevronRight, Plus, Server, SquareTerminal, X } from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import type { PaneNode } from "../../types";
import { cn } from "../../lib/utils";

/*
 * The Sessions tab in the non-full-screen state: a list of open terminal
 * sessions. Tapping one opens it full-screen (onOpen); the list also offers a
 * shortcut to the Hosts screen to start a new connection. Reads session metadata
 * only — the terminal bytes live in terminalManager.
 */

const DOT: Record<string, string> = {
  connected: "bg-green-400",
  connecting: "bg-amber-400",
  disconnected: "bg-muted",
  error: "bg-danger",
};

export function MobileSessionsList({
  onOpen,
  onGoHosts,
}: {
  onOpen: (tabId: string) => void;
  onGoHosts: () => void;
}) {
  const tabs = useSessionStore((s) => s.tabs);
  const sessions = useSessionStore((s) => s.sessions);
  const closeTab = useSessionStore((s) => s.closeTab);

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background px-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface">
          <SquareTerminal size={26} className="text-accent" />
        </div>
        <div>
          <p className="text-base font-semibold">No open sessions</p>
          <p className="mt-1 text-sm text-muted">
            Connect to a saved host to start an SSH session.
          </p>
        </div>
        <button
          type="button"
          onClick={onGoHosts}
          className="flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground"
        >
          <Server size={16} /> Go to Hosts
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="px-4 py-4 pt-safe">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Sessions</h1>
          <button
            type="button"
            onClick={onGoHosts}
            aria-label="New connection"
            className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-muted active:bg-raised"
          >
            <Plus size={16} /> New
          </button>
        </div>
        <ul className="space-y-2">
          {tabs.map((tab) => {
            const session = sessions.find(
              (s) => s.id === firstSessionId(tab.root),
            );
            const status = session?.status ?? "connecting";
            return (
              <li key={tab.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onOpen(tab.id)}
                  className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl bg-raised px-3 text-left active:ring-1 active:ring-accent"
                >
                  <span
                    className={cn(
                      "h-2.5 w-2.5 shrink-0 rounded-full",
                      DOT[status] ?? "bg-muted",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {session?.title ?? "Terminal"}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {session?.connectionTarget ?? status}
                    </span>
                  </span>
                  <ChevronRight size={16} className="shrink-0 text-muted" />
                </button>
                <button
                  type="button"
                  aria-label="Close session"
                  onClick={() => closeTab(tab.id)}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted active:bg-raised"
                >
                  <X size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** First leaf session id in a pane tree. */
function firstSessionId(node: PaneNode): string | null {
  const stack: PaneNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.kind === "leaf") return current.sessionId;
    stack.push(...current.children);
  }
  return null;
}
