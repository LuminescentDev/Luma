import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CheckCheck, Inbox, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  agentDisplayName,
  agentStateLabel,
  agentStateTone,
  type AgentStateTone,
} from "../../lib/agentInbox";
import { relativeTime } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import {
  type AgentInboxItem,
  useAgentInboxStore,
} from "../../stores/agentInboxStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";

/** Dot colour per tone, using the app's semantic tokens and Tailwind accents. */
const TONE_DOT: Record<AgentStateTone, string> = {
  danger: "bg-danger",
  warning: "bg-amber-400",
  info: "bg-accent",
  success: "bg-green-400",
  neutral: "bg-muted",
};

/** Text colour per tone for the state label. */
const TONE_TEXT: Record<AgentStateTone, string> = {
  danger: "text-danger",
  warning: "text-amber-400",
  info: "text-accent",
  success: "text-green-400",
  neutral: "text-muted",
};

/**
 * Title-bar Agent Inbox: an icon with an unread-count badge that opens a panel
 * listing agent notifications (approvals, waits, failures, limits, turn/tool
 * progress). Clicking an item focuses the owning terminal tab; items whose
 * session is gone are shown muted as "stale".
 */
export function AgentInbox() {
  const items = useAgentInboxStore((s) => s.items);
  const unreadCount = useAgentInboxStore((s) => s.unreadCount);
  const markRead = useAgentInboxStore((s) => s.markRead);
  const markAllRead = useAgentInboxStore((s) => s.markAllRead);
  const clearDone = useAgentInboxStore((s) => s.clearDone);
  const markStale = useAgentInboxStore((s) => s.markStale);

  const sessions = useSessionStore((s) => s.sessions);
  const focusSession = useSessionStore((s) => s.focusSession);
  const showTerminal = useUiStore((s) => s.showTerminal);

  const [open, setOpen] = useState(false);

  // Keep item staleness in sync with the live session list: an item whose
  // terminal session has closed becomes muted and non-navigable.
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);
  useEffect(() => {
    markStale(sessionIds);
  }, [sessionIds, markStale]);

  const sessionTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) map.set(session.id, session.title);
    return map;
  }, [sessions]);

  const hasDone = items.some((item) => item.done);

  const activate = (item: AgentInboxItem) => {
    markRead(item.key);
    // Deep-link: reuse the exact focus mechanism the command palette / tab bar
    // use — switch to the terminal workspace, then focus the owning pane. A
    // missing session (stale item) simply does nothing.
    if (!sessionTitle.has(item.terminalSessionId)) return;
    showTerminal();
    focusSession(item.terminalSessionId);
    setOpen(false);
  };

  const label =
    unreadCount > 0
      ? `Agent inbox, ${unreadCount} unread`
      : "Agent inbox";

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <span className="sr-only" role="status" aria-live="polite">
        {unreadCount > 0
          ? `${unreadCount} agent notification${unreadCount === 1 ? "" : "s"} need attention`
          : ""}
      </span>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          onDoubleClick={(event) => event.stopPropagation()}
          title={label}
          aria-label={label}
          className="relative mr-1 flex shrink-0 items-center rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-foreground"
        >
          <Inbox size={15} />
          {unreadCount > 0 && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-semibold leading-none text-white"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-lg border border-border bg-raised text-sm shadow-glow"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="font-medium text-foreground">Agent Inbox</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  markAllRead();
                }}
                disabled={unreadCount === 0}
                title="Mark all read"
                aria-label="Mark all read"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <CheckCheck size={14} />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  clearDone();
                }}
                disabled={!hasDone}
                title="Clear finished"
                aria-label="Clear finished"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-muted">
              <Inbox size={22} className="opacity-60" />
              <p className="text-xs">No agent activity yet.</p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {items.map((item) => (
                <InboxRow
                  key={item.key}
                  item={item}
                  tabName={sessionTitle.get(item.terminalSessionId)}
                  onActivate={() => activate(item)}
                />
              ))}
            </div>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function InboxRow({
  item,
  tabName,
  onActivate,
}: {
  item: AgentInboxItem;
  tabName: string | undefined;
  onActivate: () => void;
}) {
  const tone = agentStateTone(item.state);
  const stale = item.stale || tabName === undefined;

  return (
    <DropdownMenu.Item
      onSelect={(event) => {
        // A stale row has nowhere to navigate; keep the panel open.
        if (stale) event.preventDefault();
        onActivate();
      }}
      className={cn(
        "flex cursor-default flex-col gap-1 rounded-md px-2.5 py-2 outline-none transition-colors data-highlighted:bg-surface",
        item.unread && "bg-accent/10",
        item.done && "opacity-60",
        stale && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            TONE_DOT[tone],
            item.unread && "ring-2 ring-accent/40",
          )}
        />
        <span className="truncate font-medium text-foreground">
          {agentDisplayName(item.agent)}
        </span>
        <span className={cn("ml-auto shrink-0 text-[11px]", TONE_TEXT[tone])}>
          {agentStateLabel(item.state)}
        </span>
      </div>

      {(item.title || item.detail) && (
        <div className="pl-4 text-xs text-muted">
          {item.title && (
            <p className="truncate text-foreground/90">{item.title}</p>
          )}
          {item.detail && <p className="line-clamp-2">{item.detail}</p>}
        </div>
      )}

      <div className="flex items-center gap-1.5 pl-4 text-[10px] text-muted">
        <span>{relativeTime(item.ts)}</span>
        <span aria-hidden>·</span>
        {stale ? (
          <span className="italic">stale (session closed)</span>
        ) : (
          <span className="truncate">{tabName}</span>
        )}
      </div>
    </DropdownMenu.Item>
  );
}
