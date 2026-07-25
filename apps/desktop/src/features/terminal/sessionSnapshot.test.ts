import { describe, it, expect, vi } from "vitest";
import type { PaneNode, TerminalSession, WorkspaceTab } from "../../types";
import {
  parseSnapshot,
  serializeWorkspace,
  startSnapshotPersistence,
  type WorkspaceSnapshot,
} from "./sessionSnapshot";
import {
  fireCloseRequested,
  getCurrentWindow,
  setInvoke,
  wasCloseListenerActiveAtClose,
} from "../../test/tauriMock";
import { SETTING_KEYS } from "../../types";

function localSession(id: string): TerminalSession {
  return {
    id,
    title: "Terminal",
    type: "local",
    status: "connected",
    activePaneId: id,
    restore: { kind: "local" },
  };
}

function sshSession(id: string, hostId: string): TerminalSession {
  return {
    id,
    title: "prod",
    type: "ssh",
    hostId,
    connectionTarget: "prod.example.com",
    status: "connected",
    activePaneId: id,
    restore: {
      kind: "ssh",
      hostId,
      title: "prod",
      connectionTarget: "prod.example.com",
    },
  };
}

function leaf(id: string, sessionId: string): PaneNode {
  return { kind: "leaf", id, sessionId };
}

function tab(id: string, root: PaneNode, activePaneId: string): WorkspaceTab {
  return { id, root, activePaneId };
}

describe("serializeWorkspace", () => {
  it("captures each pane's restore descriptor and marks the active tab", () => {
    const sessions = [localSession("s1"), sshSession("s2", "host-1")];
    const tabs = [
      tab("t1", leaf("p1", "s1"), "p1"),
      tab(
        "t2",
        {
          kind: "split",
          id: "sp",
          direction: "row",
          children: [leaf("p2", "s2"), leaf("p3", "s1")],
          sizes: [60, 40],
        },
        "p2",
      ),
    ];

    const snap = serializeWorkspace(tabs, sessions, "t2");
    expect(snap.version).toBe(1);
    expect(snap.activeTabIndex).toBe(1);
    expect(snap.tabs).toHaveLength(2);
    expect(snap.tabs[0].root).toEqual({
      kind: "leaf",
      restore: { kind: "local" },
    });
    const split = snap.tabs[1].root;
    expect(split.kind).toBe("split");
    if (split.kind !== "split") return;
    expect(split.sizes).toEqual([60, 40]);
    expect(split.children[0]).toEqual({
      kind: "leaf",
      restore: sessions[1].restore,
    });
  });

  it("drops panes without a restore descriptor and collapses their split", () => {
    const sessions = [localSession("s1")]; // s2 intentionally missing/restore-less
    const tabs = [
      tab(
        "t1",
        {
          kind: "split",
          id: "sp",
          direction: "row",
          children: [leaf("p1", "s1"), leaf("p2", "s2")],
          sizes: [50, 50],
        },
        "p1",
      ),
    ];
    const snap = serializeWorkspace(tabs, sessions, "t1");
    // The split collapses to the single restorable leaf.
    expect(snap.tabs).toHaveLength(1);
    expect(snap.tabs[0].root).toEqual({
      kind: "leaf",
      restore: { kind: "local" },
    });
  });

  it("round-trips through parseSnapshot", () => {
    const sessions = [localSession("s1"), sshSession("s2", "host-1")];
    const tabs = [
      tab(
        "t1",
        {
          kind: "split",
          id: "sp",
          direction: "column",
          children: [leaf("p1", "s1"), leaf("p2", "s2")],
          sizes: [30, 70],
        },
        "p1",
      ),
    ];
    const snap = serializeWorkspace(tabs, sessions, "t1");
    const parsed = parseSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(parsed).toEqual(snap);
  });
});

describe("parseSnapshot fails closed", () => {
  it("returns null for non-objects and wrong versions", () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot("nope")).toBeNull();
    expect(parseSnapshot({ version: 2, tabs: [] })).toBeNull();
    expect(parseSnapshot({ version: 1 })).toBeNull();
  });

  it("rejects a tab whose root node is malformed", () => {
    const bad = {
      version: 1,
      activeTabIndex: 0,
      tabs: [{ root: { kind: "leaf", restore: { kind: "bogus" } } }],
    };
    expect(parseSnapshot(bad)).toBeNull();
  });

  it("rejects a split whose sizes length mismatches its children", () => {
    const bad = {
      version: 1,
      activeTabIndex: 0,
      tabs: [
        {
          root: {
            kind: "split",
            direction: "row",
            children: [
              { kind: "leaf", restore: { kind: "local" } },
              { kind: "leaf", restore: { kind: "local" } },
            ],
            sizes: [100],
          },
        },
      ],
    };
    expect(parseSnapshot(bad)).toBeNull();
  });

  it("requires hostId for ssh restore descriptors", () => {
    const bad = {
      version: 1,
      activeTabIndex: 0,
      tabs: [{ root: { kind: "leaf", restore: { kind: "ssh" } } }],
    };
    expect(parseSnapshot(bad)).toBeNull();
  });

  it("accepts a minimal valid snapshot and defaults activeTabIndex", () => {
    const ok = {
      version: 1,
      tabs: [{ root: { kind: "leaf", restore: { kind: "local" } } }],
    };
    const parsed = parseSnapshot(ok) as WorkspaceSnapshot;
    expect(parsed).not.toBeNull();
    expect(parsed.activeTabIndex).toBe(0);
    expect(parsed.tabs).toHaveLength(1);
  });
});

describe("startSnapshotPersistence close handling", () => {
  it("flushes the snapshot and lets the window close on a close request", async () => {
    vi.useFakeTimers();
    const writes: unknown[] = [];
    setInvoke((cmd, args) => {
      if (cmd === "settings_set") {
        if (args.key === SETTING_KEYS.workspaceSnapshot) writes.push(args.value);
        return undefined;
      }
      return undefined;
    });

    const stop = startSnapshotPersistence();
    // Let onCloseRequested's promise resolve so the listener is registered.
    await vi.runOnlyPendingTimersAsync();

    const win = getCurrentWindow();
    // The user clicks close -> the OS emits close-requested.
    await fireCloseRequested();
    // The handler prevents the first close, flushes, then schedules the real one.
    expect(win.destroy).not.toHaveBeenCalled();

    // Drain the deferred close (setTimeout(0)) and the async close() it issues.
    await vi.runOnlyPendingTimersAsync();

    // The snapshot was persisted before closing.
    expect(writes.length).toBeGreaterThan(0);
    // The listener was detached before re-issuing the close, so Windows won't
    // swallow it — the regression guard.
    expect(wasCloseListenerActiveAtClose()).toBe(false);
    // The window actually closed.
    expect(win.destroy).toHaveBeenCalled();

    stop();
    vi.useRealTimers();
  });
});
