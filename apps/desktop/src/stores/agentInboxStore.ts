import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type AgentEventPayload,
  DONE_STATE,
  isAttentionState,
} from "../lib/agentInbox";

/*
 * Agent Inbox: collates `agent-event` window events (see src/lib/agentInbox.ts)
 * into one item per (terminalSessionId + agentSessionId). Terminal bytes never
 * touch this — these are discrete metadata notifications only.
 *
 * An item's state is always the latest event. Attention states (needs-approval,
 * waiting-for-input, session-failed, limit-warning) mark it unread/highlighted;
 * `session-ended` marks it done (kept, greyed out). A bounded history of the
 * last 20 events per item is retained (newest first) for the detail view.
 */

/** How many events to retain per item. */
export const HISTORY_LIMIT = 20;

/** One recorded event in an item's history (newest first). */
export type AgentEventEntry = {
  event: string;
  title?: string;
  detail?: string;
  /** Milliseconds. */
  ts: number;
};

/** One inbox item, keyed by `terminalSessionId::agentSessionId`. */
export type AgentInboxItem = {
  key: string;
  terminalSessionId: string;
  agentSessionId: string;
  agent: string;
  /** The latest event kind. */
  state: string;
  title?: string;
  detail?: string;
  /** Milliseconds of the latest event. */
  ts: number;
  /** In an attention state and not yet acknowledged. */
  unread: boolean;
  /** The agent session has ended (kept, greyed out). */
  done: boolean;
  /** The owning terminal session no longer exists. */
  stale: boolean;
  /** Last 20 events, newest first. */
  history: AgentEventEntry[];
};

type AgentInboxState = {
  /** Items newest-updated first. */
  items: AgentInboxItem[];
  /** Number of unread (attention) items. */
  unreadCount: number;
  /** Ingest one backend event, upserting its item. */
  recordEvent: (payload: AgentEventPayload) => void;
  /** Acknowledge one item (clear its unread flag). */
  markRead: (key: string) => void;
  /** Acknowledge every item. */
  markAllRead: () => void;
  /** Drop every finished (done) item. */
  clearDone: () => void;
  /** Remove one item outright. */
  remove: (key: string) => void;
  /** Empty the inbox. */
  clearAll: () => void;
  /** Flag items whose terminal session is no longer in `liveSessionIds`. */
  markStale: (liveSessionIds: Iterable<string>) => void;
};

/** Composite key for an item. */
export function itemKey(terminalSessionId: string, agentSessionId: string): string {
  return `${terminalSessionId}::${agentSessionId}`;
}

/** Resolve an event's timestamp to milliseconds (payload `ts` is unix seconds). */
function resolveTs(payload: AgentEventPayload): number {
  return typeof payload.ts === "number" ? payload.ts * 1000 : Date.now();
}

function countUnread(items: AgentInboxItem[]): number {
  return items.reduce((total, item) => total + (item.unread ? 1 : 0), 0);
}

export const useAgentInboxStore = create<AgentInboxState>((set) => ({
  items: [],
  unreadCount: 0,

  recordEvent: (payload) => {
    set((state) => {
      const key = itemKey(payload.terminalSessionId, payload.agentSessionId);
      const ts = resolveTs(payload);
      const entry: AgentEventEntry = {
        event: payload.event,
        title: payload.title,
        detail: payload.detail,
        ts,
      };
      const attention = isAttentionState(payload.event);
      const done = payload.event === DONE_STATE;

      const existing = state.items.find((item) => item.key === key);
      const history = [entry, ...(existing?.history ?? [])].slice(0, HISTORY_LIMIT);

      const updated: AgentInboxItem = {
        key,
        terminalSessionId: payload.terminalSessionId,
        agentSessionId: payload.agentSessionId,
        agent: payload.agent,
        state: payload.event,
        title: payload.title,
        detail: payload.detail,
        ts,
        // Attention states raise the unread flag; other states preserve it so a
        // prior unacknowledged alert is not silently cleared by a later
        // non-attention event.
        unread: attention ? true : (existing?.unread ?? false),
        done: done || (existing?.done ?? false),
        // A fresh event proves the terminal session is alive again.
        stale: false,
        history,
      };

      // Move the touched item to the front; keep the rest in order.
      const rest = state.items.filter((item) => item.key !== key);
      const items = [updated, ...rest];
      return { items, unreadCount: countUnread(items) };
    });
  },

  markRead: (key) => {
    set((state) => {
      let changed = false;
      const items = state.items.map((item) => {
        if (item.key !== key || !item.unread) return item;
        changed = true;
        return { ...item, unread: false };
      });
      if (!changed) return {};
      return { items, unreadCount: countUnread(items) };
    });
  },

  markAllRead: () => {
    set((state) => {
      if (state.unreadCount === 0) return {};
      const items = state.items.map((item) =>
        item.unread ? { ...item, unread: false } : item,
      );
      return { items, unreadCount: 0 };
    });
  },

  clearDone: () => {
    set((state) => {
      const items = state.items.filter((item) => !item.done);
      if (items.length === state.items.length) return {};
      return { items, unreadCount: countUnread(items) };
    });
  },

  remove: (key) => {
    set((state) => {
      const items = state.items.filter((item) => item.key !== key);
      if (items.length === state.items.length) return {};
      return { items, unreadCount: countUnread(items) };
    });
  },

  clearAll: () => set({ items: [], unreadCount: 0 }),

  markStale: (liveSessionIds) => {
    const live = new Set(liveSessionIds);
    set((state) => {
      let changed = false;
      const items = state.items.map((item) => {
        const stale = !live.has(item.terminalSessionId);
        if (stale === item.stale) return item;
        changed = true;
        return { ...item, stale };
      });
      if (!changed) return {};
      return { items };
    });
  },
}));

/**
 * Subscribe once to the backend `agent-event` window event and feed the store.
 * Wired from app bootstrap (useAppInit) exactly like the `deep-link` and
 * `ssh-remote-os` listeners. Returns an unlisten cleanup.
 */
export function startAgentInboxListener(): () => void {
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void (async () => {
    const un = await getCurrentWindow().listen<AgentEventPayload>(
      "agent-event",
      (event) => {
        const payload = event.payload;
        // Defensive: ignore malformed payloads missing their identifying ids.
        if (!payload?.terminalSessionId || !payload?.agentSessionId) return;
        useAgentInboxStore.getState().recordEvent(payload);
      },
    );
    if (cancelled) un();
    else unlisten = un;
  })();
  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = undefined;
  };
}
