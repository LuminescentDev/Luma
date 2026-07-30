import { beforeEach, describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  itemKey,
  useAgentInboxStore,
} from "./agentInboxStore";
import type { AgentEventPayload } from "../lib/agentInbox";

function event(overrides: Partial<AgentEventPayload> = {}): AgentEventPayload {
  return {
    terminalSessionId: "term-1",
    agentSessionId: "agent-1",
    agent: "claude-code",
    event: "tool-started",
    ...overrides,
  };
}

const record = (overrides: Partial<AgentEventPayload> = {}) =>
  useAgentInboxStore.getState().recordEvent(event(overrides));

describe("agentInboxStore", () => {
  beforeEach(() => {
    useAgentInboxStore.setState({ items: [], unreadCount: 0 });
  });

  it("upserts an item keyed by terminal + agent session and replaces its state", () => {
    record({ event: "session-started", title: "Started" });
    record({ event: "tool-started", title: "Reading file" });

    const { items } = useAgentInboxStore.getState();
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe(itemKey("term-1", "agent-1"));
    // Latest event replaces the current state.
    expect(items[0].state).toBe("tool-started");
    expect(items[0].title).toBe("Reading file");
    // But the history retains both events (newest first).
    expect(items[0].history.map((h) => h.event)).toEqual([
      "tool-started",
      "session-started",
    ]);
  });

  it("keeps distinct items for different agent sessions on the same terminal", () => {
    record({ agentSessionId: "agent-1" });
    record({ agentSessionId: "agent-2" });
    expect(useAgentInboxStore.getState().items).toHaveLength(2);
  });

  it("caps history at 20 events, dropping the oldest", () => {
    for (let i = 0; i < 25; i++) {
      record({ event: "tool-started", title: `evt-${i}` });
    }
    const item = useAgentInboxStore.getState().items[0];
    expect(item.history).toHaveLength(HISTORY_LIMIT);
    // Newest first: the most recent is evt-24, and evt-5 is the oldest kept.
    expect(item.history[0].title).toBe("evt-24");
    expect(item.history[HISTORY_LIMIT - 1].title).toBe("evt-5");
  });

  it("marks attention states unread and tracks the global unread count", () => {
    record({ terminalSessionId: "t1", agentSessionId: "a1", event: "needs-approval" });
    record({ terminalSessionId: "t2", agentSessionId: "a2", event: "waiting-for-input" });
    record({ terminalSessionId: "t3", agentSessionId: "a3", event: "session-failed" });
    record({ terminalSessionId: "t4", agentSessionId: "a4", event: "limit-warning" });
    // Non-attention event does not add to the unread count.
    record({ terminalSessionId: "t5", agentSessionId: "a5", event: "turn-completed" });

    const state = useAgentInboxStore.getState();
    expect(state.unreadCount).toBe(4);
    const byKey = (k: string) => state.items.find((i) => i.key === k)!;
    expect(byKey(itemKey("t1", "a1")).unread).toBe(true);
    expect(byKey(itemKey("t5", "a5")).unread).toBe(false);
  });

  it("treats unknown event strings as a neutral, non-unread state", () => {
    record({ event: "something-new" });
    const item = useAgentInboxStore.getState().items[0];
    expect(item.state).toBe("something-new");
    expect(item.unread).toBe(false);
    expect(useAgentInboxStore.getState().unreadCount).toBe(0);
  });

  it("preserves an unread flag when a later non-attention event arrives", () => {
    record({ event: "needs-approval" });
    expect(useAgentInboxStore.getState().unreadCount).toBe(1);
    record({ event: "tool-finished" });
    const item = useAgentInboxStore.getState().items[0];
    expect(item.state).toBe("tool-finished");
    expect(item.unread).toBe(true);
    expect(useAgentInboxStore.getState().unreadCount).toBe(1);
  });

  it("marks an item done on session-ended but keeps it", () => {
    record({ event: "tool-started" });
    record({ event: "session-ended" });
    const item = useAgentInboxStore.getState().items[0];
    expect(item.done).toBe(true);
    expect(item.state).toBe("session-ended");
    // Done items are retained.
    expect(useAgentInboxStore.getState().items).toHaveLength(1);
  });

  it("markRead clears one item's unread flag and decrements the count", () => {
    record({ terminalSessionId: "t1", agentSessionId: "a1", event: "needs-approval" });
    record({ terminalSessionId: "t2", agentSessionId: "a2", event: "session-failed" });
    expect(useAgentInboxStore.getState().unreadCount).toBe(2);

    useAgentInboxStore.getState().markRead(itemKey("t1", "a1"));
    const state = useAgentInboxStore.getState();
    expect(state.unreadCount).toBe(1);
    expect(state.items.find((i) => i.key === itemKey("t1", "a1"))!.unread).toBe(false);
    expect(state.items.find((i) => i.key === itemKey("t2", "a2"))!.unread).toBe(true);
  });

  it("markAllRead clears every unread flag", () => {
    record({ terminalSessionId: "t1", agentSessionId: "a1", event: "needs-approval" });
    record({ terminalSessionId: "t2", agentSessionId: "a2", event: "session-failed" });
    useAgentInboxStore.getState().markAllRead();
    const state = useAgentInboxStore.getState();
    expect(state.unreadCount).toBe(0);
    expect(state.items.every((i) => !i.unread)).toBe(true);
  });

  it("clearDone removes only finished items and recomputes the unread count", () => {
    record({ terminalSessionId: "t1", agentSessionId: "a1", event: "session-ended" });
    record({ terminalSessionId: "t2", agentSessionId: "a2", event: "needs-approval" });
    useAgentInboxStore.getState().clearDone();
    const state = useAgentInboxStore.getState();
    expect(state.items).toHaveLength(1);
    expect(state.items[0].key).toBe(itemKey("t2", "a2"));
    expect(state.unreadCount).toBe(1);
  });

  it("markStale flags items whose terminal session is gone and clears it on a new event", () => {
    record({ terminalSessionId: "t1", agentSessionId: "a1", event: "tool-started" });
    record({ terminalSessionId: "t2", agentSessionId: "a2", event: "tool-started" });

    useAgentInboxStore.getState().markStale(["t1"]);
    let state = useAgentInboxStore.getState();
    expect(state.items.find((i) => i.terminalSessionId === "t1")!.stale).toBe(false);
    expect(state.items.find((i) => i.terminalSessionId === "t2")!.stale).toBe(true);

    // A fresh event proves the session is alive again.
    record({ terminalSessionId: "t2", agentSessionId: "a2", event: "turn-completed" });
    state = useAgentInboxStore.getState();
    expect(state.items.find((i) => i.terminalSessionId === "t2")!.stale).toBe(false);
  });

  it("uses payload ts (unix seconds) when present, else falls back to now", () => {
    record({ event: "tool-started", ts: 1_700_000_000 });
    expect(useAgentInboxStore.getState().items[0].ts).toBe(1_700_000_000_000);

    const before = Date.now();
    record({ agentSessionId: "a2", event: "tool-started" });
    const item = useAgentInboxStore.getState().items.find(
      (i) => i.agentSessionId === "a2",
    )!;
    expect(item.ts).toBeGreaterThanOrEqual(before);
  });
});
