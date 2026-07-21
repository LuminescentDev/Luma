import { useEffect } from "react";
import { ChevronLeft, Layers, Plus, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { Workspace } from "../terminal/Workspace";
import { MobileAccessoryBar } from "./MobileAccessoryBar";
import { useVisualViewportHeight } from "./useVisualViewport";
import { cn } from "../../lib/utils";

/*
 * Full-screen mobile terminal. The container is sized to the visual viewport so
 * the on-screen keyboard shrinks it (keeping the prompt + accessory row visible)
 * rather than overlaying the terminal. One session per tab is shown at a time;
 * the Sessions sheet switches between open sessions. Terminal bytes remain in
 * terminalManager — this only reads session metadata.
 */

const STATUS_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
};

export function MobileTerminalView({
  onExit,
  onNewConnection,
}: {
  /** Leave the full-screen terminal and show the sessions list (nav visible). */
  onExit: () => void;
  /** Navigate to the Hosts screen to start a new connection. */
  onNewConnection: () => void;
}) {
  const tabs = useSessionStore((s) => s.tabs);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);
  const closeTab = useSessionStore((s) => s.closeTab);
  const searchOpen = useUiStore((s) => s.terminalSearchOpen);
  const setSearchOpen = useUiStore((s) => s.setTerminalSearchOpen);

  const height = useVisualViewportHeight(activeSessionId);
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  // If every tab closed while full-screen, drop back to the session list.
  useEffect(() => {
    if (tabs.length === 0) onExit();
  }, [tabs.length, onExit]);

  const title = activeSession?.title ?? "Terminal";
  const status = activeSession
    ? (STATUS_LABEL[activeSession.status] ?? activeSession.status)
    : "";

  return (
    <div
      className="fixed inset-0 z-30 flex flex-col bg-background"
      style={{ height: height > 0 ? `${height}px` : "100%" }}
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-1 pt-safe">
        <button
          type="button"
          onClick={onExit}
          aria-label="Back to sessions"
          className="flex h-11 w-11 items-center justify-center rounded-md text-muted active:bg-raised"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          <p
            className={cn(
              "truncate text-[11px]",
              activeSession?.status === "connected"
                ? "text-green-400"
                : activeSession?.status === "error"
                  ? "text-danger"
                  : "text-muted",
            )}
          >
            {status}
          </p>
        </div>
        <SessionSheet
          tabs={tabs}
          activeTabId={activeTabId}
          sessions={sessions}
          onSelect={(tabId) => setActiveTab(tabId)}
          onClose={(tabId) => closeTab(tabId)}
          onNew={() => {
            setSearchOpen(false);
            onNewConnection();
          }}
        />
      </header>

      {/* The workspace fills the remaining space; SearchBar (if open) renders
          inside it. */}
      <div className="relative min-h-0 flex-1">
        <Workspace />
      </div>

      {searchOpen ? null : activeSessionId ? (
        <MobileAccessoryBar sessionId={activeSessionId} />
      ) : null}
    </div>
  );
}

function SessionSheet({
  tabs,
  activeTabId,
  sessions,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: ReturnType<typeof useSessionStore.getState>["tabs"];
  activeTabId: string | null;
  sessions: ReturnType<typeof useSessionStore.getState>["sessions"];
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
}) {
  // Map each tab to its focused pane's session for a readable label.
  const labelFor = (tab: (typeof tabs)[number]): string => {
    const paneSessionId = firstSessionId(tab);
    const session = sessions.find((s) => s.id === paneSessionId);
    return session?.title ?? "Terminal";
  };

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Open sessions"
          className="relative flex h-11 w-11 items-center justify-center rounded-md text-muted active:bg-raised"
        >
          <Layers size={19} />
          {tabs.length > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-foreground">
              {tabs.length}
            </span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[80vh] rounded-t-2xl border-t border-border bg-surface pb-safe focus:outline-none">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">Sessions</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="rounded-md p-1 text-muted active:bg-raised"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <ul className="max-h-[55vh] overflow-y-auto p-2">
            {tabs.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted">
                No open sessions.
              </li>
            ) : (
              tabs.map((tab) => (
                <li key={tab.id} className="flex items-center gap-1">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      onClick={() => onSelect(tab.id)}
                      className={cn(
                        "flex min-h-11 min-w-0 flex-1 items-center rounded-lg px-3 py-2 text-left text-sm",
                        tab.id === activeTabId
                          ? "bg-raised text-foreground"
                          : "text-muted active:bg-raised",
                      )}
                    >
                      <span className="truncate">{labelFor(tab)}</span>
                    </button>
                  </Dialog.Close>
                  <button
                    type="button"
                    aria-label={`Close ${labelFor(tab)}`}
                    onClick={() => onClose(tab.id)}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted active:bg-raised"
                  >
                    <X size={16} />
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="border-t border-border p-2">
            <Dialog.Close asChild>
              <button
                type="button"
                onClick={onNew}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-accent-foreground"
              >
                <Plus size={16} /> New connection
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The session id of a tab's focused pane, falling back to the first leaf. */
function firstSessionId(
  tab: ReturnType<typeof useSessionStore.getState>["tabs"][number],
): string | null {
  const node = tab.root;
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.kind === "leaf") return current.sessionId;
    stack.push(...current.children);
  }
  return null;
}
