import {
  ChevronRight,
  Inbox,
  Plus,
  RotateCw,
  Server,
  SquareTerminal,
  X,
} from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useMobileNavStore } from "../../stores/mobileNavStore";
import { useSettings } from "../../hooks/useSettings";
import { ContextMenu, type MenuAction } from "../../components/ContextMenu";
import { SETTING_KEYS, type PaneNode } from "../../types";
import { cn } from "../../lib/utils";
import { MobileList, MobileRow, MobileScreen } from "./MobileScreen";
import { MobileTerminalPreview } from "./MobileTerminalPreview";
import { useAgentInboxUnread } from "./MobileAgentInboxScreen";

/*
 * The Connections tab in the non-full-screen state: a list of open terminal
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

export function MobileConnectionsScreen({
  onOpen,
  onGoHosts,
}: {
  onOpen: (tabId: string) => void;
  onGoHosts: () => void;
}) {
  const tabs = useSessionStore((s) => s.tabs);
  const sessions = useSessionStore((s) => s.sessions);
  const closeTab = useSessionStore((s) => s.closeTab);
  const restartSession = useSessionStore((s) => s.restartSession);
  const push = useMobileNavStore((s) => s.push);
  const unreadAgents = useAgentInboxUnread();
  // Default ON. Each visible preview is a second (read-only) xterm instance, so
  // it can be turned off on a device where that is not worth the battery.
  const { data: settings } = useSettings();
  const previews = settings?.[SETTING_KEYS.connectionPreviews] !== false;

  // Agent activity is checked far more often than it is acted on, so it sits at
  // the top of this tab with its own count rather than behind a session.
  const agentInbox = (
    <MobileList className="mb-3">
      <MobileRow
        icon={Inbox}
        label="Agent Inbox"
        detail={
          unreadAgents > 0
            ? `${unreadAgents} needing attention`
            : "Approvals, questions and finished turns"
        }
        iconClassName={unreadAgents > 0 ? "text-accent" : undefined}
        count={unreadAgents > 0 ? unreadAgents : undefined}
        onSelect={() => push("agent-inbox")}
      />
    </MobileList>
  );

  const newButton = (
    <button
      type="button"
      onClick={onGoHosts}
      aria-label="New connection"
      className="flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm text-muted active:bg-raised"
    >
      <Plus size={16} /> New
    </button>
  );

  if (tabs.length === 0) {
    return (
      <MobileScreen title="Connections" large action={newButton}>
        <div className="pt-1">{agentInbox}</div>
        <div className="flex flex-col items-center gap-4 px-8 py-16 text-center">
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
      </MobileScreen>
    );
  }

  return (
    <MobileScreen title="Connections" large action={newButton}>
      <div className="pt-1">{agentInbox}</div>
      <ul className="space-y-2">
          {tabs.map((tab) => {
            const sessionId = firstSessionId(tab.root);
            const session = sessions.find((s) => s.id === sessionId);
            const status = session?.status ?? "connecting";
            const title = session?.title ?? "Terminal";
            const actions: MenuAction[] = [
              {
                label: "Open",
                icon: <SquareTerminal size={15} />,
                onSelect: () => onOpen(tab.id),
              },
              {
                label: "Reconnect",
                icon: <RotateCw size={15} />,
                disabled: sessionId === null,
                onSelect: () => {
                  if (sessionId) void restartSession(sessionId);
                },
              },
              { separator: true },
              {
                label: "Close session",
                icon: <X size={15} />,
                destructive: true,
                onSelect: () => closeTab(tab.id),
              },
            ];
            return (
              <ContextMenu key={tab.id} actions={actions} minWidth="min-w-44">
                <li className="overflow-hidden rounded-xl bg-raised">
                  {/* A live miniature of the session, so the list answers "what
                      is it doing?" without opening it. Only rendered once there
                      is a session to mirror; the row below is the tap target.
                      The preview renders the session's real grid scaled down, so
                      this box is what decides how many lines of tail it shows. */}
                  {previews && sessionId && (
                    <MobileTerminalPreview
                      sessionId={sessionId}
                      status={status}
                      className="h-36 w-full border-b border-border/60 bg-background px-2 py-1.5"
                    />
                  )}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onOpen(tab.id)}
                      className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 text-left active:bg-surface"
                    >
                      <span
                        className={cn(
                          "h-2.5 w-2.5 shrink-0 rounded-full",
                          DOT[status] ?? "bg-muted",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {title}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {session?.connectionTarget ?? status}
                        </span>
                      </span>
                      <ChevronRight size={16} className="shrink-0 text-muted" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${title}`}
                      onClick={() => closeTab(tab.id)}
                      className="mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted active:bg-surface"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </li>
              </ContextMenu>
            );
          })}
      </ul>
    </MobileScreen>
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
