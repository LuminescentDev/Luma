import { useEffect } from "react";
import { CheckCheck, Inbox, Trash2 } from "lucide-react";
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
import { terminalManager } from "../terminal/terminalManager";
import { MobileScreen } from "./MobileScreen";

/*
 * Agent Inbox as a full mobile screen rather than the desktop title-bar
 * dropdown: one row per agent session, newest first, tapping a row opens the
 * terminal it belongs to. This is the surface the feature was designed for —
 * checking on a coding agent from a phone — so it is reachable from the
 * Connections tab instead of being buried behind a terminal long-press.
 */

const TONE_DOT: Record<AgentStateTone, string> = {
  danger: "bg-danger",
  warning: "bg-amber-400",
  info: "bg-accent",
  success: "bg-green-400",
  neutral: "bg-muted",
};

const TONE_TEXT: Record<AgentStateTone, string> = {
  danger: "text-danger",
  warning: "text-amber-400",
  info: "text-accent",
  success: "text-green-400",
  neutral: "text-muted",
};

export function MobileAgentInboxScreen({
  onBack,
  onOpenSession,
}: {
  onBack: () => void;
  /** Focus the terminal that owns an item and leave this screen. */
  onOpenSession: (sessionId: string) => void;
}) {
  const items = useAgentInboxStore((s) => s.items);
  const unreadCount = useAgentInboxStore((s) => s.unreadCount);
  const markRead = useAgentInboxStore((s) => s.markRead);
  const markAllRead = useAgentInboxStore((s) => s.markAllRead);
  const clearDone = useAgentInboxStore((s) => s.clearDone);
  const markStale = useAgentInboxStore((s) => s.markStale);
  const sessions = useSessionStore((s) => s.sessions);

  // Items are keyed by the BACKEND session id that agent events carry, not by
  // the store's session id, so resolve one to the other. Built on every render
  // rather than memoised: a session's backend id is assigned asynchronously
  // after the store knows about the session, and a cached map would miss the
  // window an event actually arrives in.
  const owners = new Map<string, { id: string; title: string }>();
  for (const session of sessions) {
    const backendId = terminalManager.getBackendId(session.id);
    if (backendId) owners.set(backendId, { id: session.id, title: session.title });
  }

  const liveKey = [...owners.keys()].join(" ");
  useEffect(() => {
    markStale(liveKey ? liveKey.split(" ") : []);
  }, [liveKey, markStale]);

  const hasDone = items.some((item) => item.done);

  return (
    <MobileScreen
      title="Agent Inbox"
      onBack={onBack}
      action={
        items.length > 0 ? (
          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                aria-label="Mark all as read"
                className="flex h-11 w-11 items-center justify-center rounded-full text-accent active:bg-raised"
              >
                <CheckCheck size={20} />
              </button>
            )}
            {hasDone && (
              <button
                type="button"
                onClick={clearDone}
                aria-label="Clear finished agent sessions"
                className="flex h-11 w-11 items-center justify-center rounded-full text-muted active:bg-raised"
              >
                <Trash2 size={19} />
              </button>
            )}
          </div>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
          <Inbox size={26} className="text-muted" />
          <p className="mt-3 text-[15px] font-medium">No agent activity</p>
          <p className="mt-1 text-xs text-muted">
            Install the luma-hook companion on a host and its coding agents
            report here — approvals, questions, finished turns and failures.
          </p>
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {items.map((item) => (
            <InboxCard
              key={item.key}
              item={item}
              tabName={owners.get(item.terminalSessionId)?.title}
              onActivate={() => {
                markRead(item.key);
                const owner = owners.get(item.terminalSessionId);
                if (owner) onOpenSession(owner.id);
              }}
            />
          ))}
        </ul>
      )}
    </MobileScreen>
  );
}

function InboxCard({
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
    <li>
      <button
        type="button"
        onClick={onActivate}
        className={cn(
          "w-full rounded-xl border border-border bg-surface px-3.5 py-3 text-left active:bg-raised",
          item.unread && "border-accent/40 bg-accent/10",
          (item.done || stale) && "opacity-65",
        )}
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn("h-2.5 w-2.5 shrink-0 rounded-full", TONE_DOT[tone])}
          />
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
            {agentDisplayName(item.agent)}
          </span>
          <span className={cn("shrink-0 text-xs", TONE_TEXT[tone])}>
            {agentStateLabel(item.state)}
          </span>
        </div>

        {(item.title || item.detail) && (
          <div className="mt-1 pl-4.5 text-xs text-muted">
            {item.title && (
              <p className="truncate text-foreground/90">{item.title}</p>
            )}
            {item.detail && <p className="line-clamp-3">{item.detail}</p>}
          </div>
        )}

        <div className="mt-1.5 flex items-center gap-1.5 pl-4.5 text-[11px] text-muted">
          <span>{relativeTime(item.ts)}</span>
          <span aria-hidden>·</span>
          {stale ? (
            <span className="italic">session closed</span>
          ) : (
            <span className="truncate">{tabName}</span>
          )}
        </div>
      </button>
    </li>
  );
}

/** Unread agent count, for the Connections hub badge. */
export function useAgentInboxUnread(): number {
  return useAgentInboxStore((s) => s.unreadCount);
}
