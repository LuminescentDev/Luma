import { describe, it, expect, beforeEach, vi } from "vitest";
import { setInvoke, invoke } from "../test/tauriMock";
import { useSessionStore } from "./sessionStore";
import { terminalManager } from "../features/terminal/terminalManager";
import { createdTerminals } from "../test/xtermMock";
import { collectLeaves } from "../features/terminal/paneTree";
import { serializeNode } from "../features/terminal/sessionSnapshot";
import { buildHostGroupLayout, parseTemplates } from "./templateStore";
import type { SshExitPayload } from "../lib/ssh";

/** Fire a Channel's onmessage as the "backend" would. */
function fire<T>(channel: unknown, payload: T): void {
  (channel as { onmessage: (message: T) => void }).onmessage(payload);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await tick();
}

/**
 * Poll until `predicate()` is truthy, then return. Fails loudly if the bounded
 * timeout elapses first. Used instead of a fixed number of `flush()` ticks: the
 * SSH open path awaits `requestAnimationFrame` (waitForPaneLayout) before it runs
 * the host-key preflight that sets `connectionPrompt`, so the number of macrotask
 * ticks needed is not fixed and a hard-coded count races the rAF under load.
 */
async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${message}`);
    await tick();
  }
}

function latestSession() {
  const { sessions } = useSessionStore.getState();
  return sessions[sessions.length - 1];
}

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    tabs: [],
    activeTabId: null,
    activeSessionId: null,
  });
});

describe("exit before spawn resolution never leaves a connected ghost", () => {
  it("local: exit fired before pty_spawn resolves ends disconnected", async () => {
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") {
        fire<number | null>(args.onExit, 0);
        return { sessionId: "backend-local", shellName: "bash" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useSessionStore.getState().openLocalSession();
    const session = latestSession();
    expect(session.status).toBe("disconnected");
    expect(session.status).not.toBe("connected");
  });

  it("serial: exit fired before serial_spawn resolves ends disconnected", async () => {
    setInvoke((cmd, args) => {
      if (cmd === "serial_spawn") {
        fire<number | null>(args.onExit, null);
        return { sessionId: "backend-serial", portName: "COM3" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useSessionStore
      .getState()
      .openSerialSession({ path: "COM3", baudRate: 115200 });
    const session = latestSession();
    expect(session.status).toBe("disconnected");
  });

  it("ssh: exit fired before ssh_spawn resolves ends in error, never connected", async () => {
    setInvoke((cmd, args) => {
      if (cmd === "ssh_host_key_status") {
        return { status: "known", scannedKeys: [], knownKeys: [] };
      }
      if (cmd === "ssh_spawn") {
        fire<SshExitPayload>(args.onExit, {
          code: null,
          errorCategory: "auth-failed",
          errorMessage: "Permission denied",
        });
        return { sessionId: "backend-ssh", title: "prod" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useSessionStore.getState().openSshSession("host-1", "prod", "prod.example.com");
    const session = latestSession();
    expect(session.status).toBe("error");
    expect(session.errorCategory).toBe("auth-failed");
    expect(session.status).not.toBe("connected");
  });

  it("local: a healthy spawn (no early exit) reaches connected", async () => {
    setInvoke((cmd) => {
      if (cmd === "pty_spawn") return { sessionId: "b", shellName: "bash" };
      throw new Error(`unexpected ${cmd}`);
    });
    await useSessionStore.getState().openLocalSession();
    expect(latestSession().status).toBe("connected");
  });
});

describe("SSH host-key preflight decisions", () => {
  it("known host proceeds straight to ssh_spawn", async () => {
    setInvoke((cmd) => {
      if (cmd === "ssh_host_key_status") {
        return { status: "known", scannedKeys: [], knownKeys: [] };
      }
      if (cmd === "ssh_spawn") return { sessionId: "b", title: "prod" };
      throw new Error(`unexpected ${cmd}`);
    });
    await useSessionStore.getState().openSshSession("host-1", "prod", "prod.example.com");
    expect(invoke).toHaveBeenCalledWith("ssh_spawn", expect.anything());
    // SSH stays "connecting" until the authentication marker; never auto-connected.
    expect(latestSession().status).toBe("connecting");
  });

  it("unknown host waits, then trustHostKey trusts the scan and spawns", async () => {
    setInvoke((cmd) => {
      if (cmd === "ssh_host_key_status") {
        return {
          status: "unknown",
          scannedKeys: [{ keyType: "ssh-ed25519", fingerprint: "SHA256:aaa" }],
          knownKeys: [],
        };
      }
      if (cmd === "ssh_host_key_trust") {
        return { status: "known", scannedKeys: [], knownKeys: [] };
      }
      if (cmd === "ssh_spawn") return { sessionId: "b", title: "prod" };
      throw new Error(`unexpected ${cmd}`);
    });

    const done = useSessionStore.getState().openSshSession("host-1", "prod", "prod.example.com");
    await waitFor(
      () => latestSession()?.connectionPrompt?.type === "host-key",
      "SSH session reaches the host-key preflight prompt",
    );
    const pending = latestSession();
    expect(pending.connectionPrompt?.type).toBe("host-key");
    expect(invoke).not.toHaveBeenCalledWith("ssh_spawn", expect.anything());

    useSessionStore.getState().trustHostKey(pending.id);
    await done;

    expect(invoke).toHaveBeenCalledWith("ssh_host_key_trust", expect.anything());
    expect(invoke).toHaveBeenCalledWith("ssh_spawn", expect.anything());
  });

  it("unknown host cancelled via closeSession never spawns", async () => {
    setInvoke((cmd) => {
      if (cmd === "ssh_host_key_status") {
        return {
          status: "unknown",
          scannedKeys: [{ keyType: "ssh-ed25519", fingerprint: "SHA256:bbb" }],
          knownKeys: [],
        };
      }
      if (cmd === "ssh_spawn") return { sessionId: "b", title: "prod" };
      throw new Error(`unexpected ${cmd}`);
    });

    const done = useSessionStore.getState().openSshSession("host-1", "prod", "prod.example.com");
    await waitFor(
      () => latestSession()?.connectionPrompt?.type === "host-key",
      "SSH session reaches the host-key preflight prompt",
    );
    const pending = latestSession();
    expect(pending.connectionPrompt?.type).toBe("host-key");

    useSessionStore.getState().closeSession(pending.id);
    await done;

    expect(invoke).not.toHaveBeenCalledWith("ssh_spawn", expect.anything());
    // The session (and its tab) were removed by the cancel.
    expect(
      useSessionStore.getState().sessions.some((s) => s.id === pending.id),
    ).toBe(false);
  });

  it("changed host key is a blocking error and never spawns", async () => {
    setInvoke((cmd) => {
      if (cmd === "ssh_host_key_status") {
        return {
          status: "changed",
          scannedKeys: [{ keyType: "ssh-ed25519", fingerprint: "SHA256:new" }],
          knownKeys: [{ keyType: "ssh-ed25519", fingerprint: "SHA256:old" }],
        };
      }
      if (cmd === "ssh_spawn") return { sessionId: "b", title: "prod" };
      throw new Error(`unexpected ${cmd}`);
    });

    await useSessionStore.getState().openSshSession("host-1", "prod", "prod.example.com");
    const session = latestSession();
    expect(session.status).toBe("error");
    expect(session.errorCategory).toBe("host-key-changed");
    expect(session.hostKeyScanned?.[0].fingerprint).toBe("SHA256:new");
    expect(session.hostKeyKnown?.[0].fingerprint).toBe("SHA256:old");
    expect(invoke).not.toHaveBeenCalledWith("ssh_spawn", expect.anything());
  });
});

describe("SSH auto-reconnect engine", () => {
  it("schedules a reconnect on a transient failure and stopReconnect ends it", async () => {
    setInvoke((cmd, args) => {
      if (cmd === "ssh_host_key_status") {
        return { status: "known", scannedKeys: [], knownKeys: [] };
      }
      if (cmd === "ssh_spawn") {
        fire<SshExitPayload>(args.onExit, {
          code: null,
          errorCategory: "timeout",
          errorMessage: "connection timed out",
        });
        return { sessionId: "backend-ssh", title: "prod" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useSessionStore.getState().openSshSession("host-1", "prod", "prod.example.com");
    const session = latestSession();
    // A transient SSH failure enters the reconnecting state (attempt 1) rather
    // than a terminal error.
    expect(session.connectionState).toBe("reconnecting");
    expect(session.reconnectAttempt).toBe(1);
    expect(typeof session.nextRetryAt).toBe("number");

    // Stopping abandons the run and leaves a failed session (no more retries).
    useSessionStore.getState().stopReconnect(session.id);
    const stopped = latestSession();
    expect(stopped.connectionState).toBe("failed");
    expect(stopped.status).toBe("error");
  });

  it("does not auto-reconnect an auth failure", async () => {
    setInvoke((cmd, args) => {
      if (cmd === "ssh_host_key_status") {
        return { status: "known", scannedKeys: [], knownKeys: [] };
      }
      if (cmd === "ssh_spawn") {
        fire<SshExitPayload>(args.onExit, {
          code: null,
          errorCategory: "auth-failed",
          errorMessage: "Permission denied",
        });
        return { sessionId: "backend-ssh", title: "prod" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useSessionStore.getState().openSshSession("host-1", "prod", "prod.example.com");
    const session = latestSession();
    expect(session.status).toBe("error");
    expect(session.connectionState).toBe("failed");
    expect(session.reconnectAttempt).toBeUndefined();
  });
});

/** Answer pty_spawn for local sessions/splits used by the grouping tests. */
function mockLocalSpawn(): void {
  setInvoke((cmd) => {
    if (cmd === "pty_spawn") return { sessionId: "b", shellName: "bash" };
    throw new Error(`unexpected ${cmd}`);
  });
}

/** Answer the SSH preflight + spawn (host always known) for the SSH tests. */
function mockSshSpawn(): void {
  setInvoke((cmd) => {
    if (cmd === "ssh_host_key_status") {
      return { status: "known", scannedKeys: [], knownKeys: [] };
    }
    if (cmd === "ssh_spawn") return { sessionId: "b", title: "host" };
    throw new Error(`unexpected ${cmd}`);
  });
}

describe("mergeTabs", () => {
  it("merges two single-pane tabs into one 2-pane tab, preserving ids", async () => {
    mockLocalSpawn();
    const store = useSessionStore.getState();
    await store.openLocalSession();
    await store.openLocalSession();

    const before = useSessionStore.getState();
    const [tab1, tab2] = before.tabs;
    const leaf1 = collectLeaves(tab1.root)[0];
    const leaf2 = collectLeaves(tab2.root)[0];

    // Drag tab2 (source) onto tab1 (target).
    useSessionStore.getState().mergeTabs(tab2.id, tab1.id);

    const after = useSessionStore.getState();
    expect(after.tabs).toHaveLength(1);
    const merged = after.tabs[0];
    expect(merged.id).toBe(tab1.id); // target keeps its id
    expect(after.activeTabId).toBe(tab1.id);
    // Sessions untouched by the merge.
    expect(after.sessions).toHaveLength(2);

    const leaves = collectLeaves(merged.root);
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.id).sort()).toEqual(
      [leaf1.id, leaf2.id].sort(),
    );
    expect(leaves.map((l) => l.sessionId).sort()).toEqual(
      [leaf1.sessionId, leaf2.sessionId].sort(),
    );
    // Focus follows the dragged (source) tab's active pane.
    expect(merged.activePaneId).toBe(leaf2.id);
    expect(after.activeSessionId).toBe(leaf2.sessionId);
  });

  it("merges a single tab into a multi-pane tab (grows the group)", async () => {
    mockLocalSpawn();
    const store = useSessionStore.getState();
    await store.openLocalSession(); // tab1
    await store.splitActivePane("row"); // tab1 now has 2 panes
    await store.openLocalSession(); // tab2 (single pane)

    const before = useSessionStore.getState();
    const tab1 = before.tabs[0];
    const tab2 = before.tabs[1];

    useSessionStore.getState().mergeTabs(tab2.id, tab1.id);

    const after = useSessionStore.getState();
    expect(after.tabs).toHaveLength(1);
    expect(collectLeaves(after.tabs[0].root)).toHaveLength(3);
  });

  it("honors directional placement when dropping on a workspace zone", async () => {
    mockLocalSpawn();
    await useSessionStore.getState().openLocalSession();
    await useSessionStore.getState().openLocalSession();
    const [target, source] = useSessionStore.getState().tabs;
    const targetLeaf = collectLeaves(target.root)[0];
    const sourceLeaf = collectLeaves(source.root)[0];

    useSessionStore
      .getState()
      .mergeTabs(source.id, target.id, "column", "before");

    const root = useSessionStore.getState().tabs[0].root;
    expect(root.kind).toBe("split");
    if (root.kind !== "split") return;
    expect(root.direction).toBe("column");
    expect(collectLeaves(root.children[0]).map((leaf) => leaf.id)).toEqual([
      sourceLeaf.id,
    ]);
    expect(collectLeaves(root.children[1]).map((leaf) => leaf.id)).toEqual([
      targetLeaf.id,
    ]);
  });

  it("grafts a dragged tab beside a specific pane for nested layouts", async () => {
    mockLocalSpawn();
    await useSessionStore.getState().openLocalSession();
    await useSessionStore.getState().splitActivePane("row");
    await useSessionStore.getState().openLocalSession();
    const [target, source] = useSessionStore.getState().tabs;
    const targetPanes = collectLeaves(target.root);
    const sourcePane = collectLeaves(source.root)[0];

    useSessionStore
      .getState()
      .mergeTabs(source.id, target.id, "column", "before", targetPanes[0].id);

    const root = useSessionStore.getState().tabs[0].root;
    expect(root.kind).toBe("split");
    if (root.kind !== "split") return;
    expect(root.direction).toBe("row");
    expect(root.children[0].kind).toBe("split");
    if (root.children[0].kind !== "split") return;
    expect(root.children[0].direction).toBe("column");
    expect(collectLeaves(root.children[0]).map((leaf) => leaf.id)).toEqual([
      sourcePane.id,
      targetPanes[0].id,
    ]);
    expect(collectLeaves(root.children[1]).map((leaf) => leaf.id)).toEqual([
      targetPanes[1].id,
    ]);
  });

  it("is a no-op for identical or unknown ids", async () => {
    mockLocalSpawn();
    await useSessionStore.getState().openLocalSession();
    await useSessionStore.getState().openLocalSession();
    const before = useSessionStore.getState();
    const tab1 = before.tabs[0];

    useSessionStore.getState().mergeTabs(tab1.id, tab1.id);
    expect(useSessionStore.getState().tabs).toHaveLength(2);

    useSessionStore.getState().mergeTabs("nope", tab1.id);
    expect(useSessionStore.getState().tabs).toHaveLength(2);

    useSessionStore.getState().mergeTabs(tab1.id, "nope");
    expect(useSessionStore.getState().tabs).toHaveLength(2);
  });
});

describe("broadcast input", () => {
  it("enables broadcast for a multi-pane tab and pushes full membership", async () => {
    mockLocalSpawn();
    const setGroup = vi.spyOn(terminalManager, "setBroadcastGroup");
    const store = useSessionStore.getState();
    await store.openLocalSession();
    await store.splitActivePane("row");

    const tab = useSessionStore.getState().tabs[0];
    const sessionIds = collectLeaves(tab.root).map((l) => l.sessionId);

    setGroup.mockClear();
    useSessionStore.getState().toggleBroadcast(tab.id);

    expect(useSessionStore.getState().tabs[0].broadcastEnabled).toBe(true);
    expect(setGroup).toHaveBeenLastCalledWith(sessionIds);
    setGroup.mockRestore();
  });

  it("excludes a pane from the broadcast membership", async () => {
    mockLocalSpawn();
    const setGroup = vi.spyOn(terminalManager, "setBroadcastGroup");
    const store = useSessionStore.getState();
    await store.openLocalSession();
    await store.splitActivePane("row");

    const tab = useSessionStore.getState().tabs[0];
    const [a, b] = collectLeaves(tab.root).map((l) => l.sessionId);
    useSessionStore.getState().toggleBroadcast(tab.id);

    setGroup.mockClear();
    useSessionStore.getState().setPaneBroadcast(tab.id, b, false);

    expect(useSessionStore.getState().tabs[0].broadcastExcluded).toContain(b);
    expect(setGroup).toHaveBeenLastCalledWith([a]);
    setGroup.mockRestore();
  });

  it("a new split pane joins an already-broadcasting tab", async () => {
    mockLocalSpawn();
    const store = useSessionStore.getState();
    await store.openLocalSession();
    await store.splitActivePane("row");
    const tab = useSessionStore.getState().tabs[0];
    useSessionStore.getState().toggleBroadcast(tab.id);

    const setGroup = vi.spyOn(terminalManager, "setBroadcastGroup");
    await useSessionStore.getState().splitActivePane("row");

    const after = useSessionStore.getState().tabs[0];
    const sessionIds = collectLeaves(after.root).map((l) => l.sessionId);
    expect(sessionIds).toHaveLength(3);
    expect(setGroup).toHaveBeenLastCalledWith(sessionIds);
    setGroup.mockRestore();
  });

  it("disables broadcast when the tab drops back to a single pane", async () => {
    mockLocalSpawn();
    const store = useSessionStore.getState();
    await store.openLocalSession();
    await store.splitActivePane("row");
    const tab = useSessionStore.getState().tabs[0];
    useSessionStore.getState().toggleBroadcast(tab.id);
    expect(useSessionStore.getState().tabs[0].broadcastEnabled).toBe(true);

    const leaves = collectLeaves(useSessionStore.getState().tabs[0].root);
    useSessionStore.getState().closeSession(leaves[0].sessionId);

    expect(useSessionStore.getState().tabs[0].broadcastEnabled).toBe(false);
  });

  it("stops fan-out through the real manager once broadcast is toggled off", async () => {
    // Unique backend id per spawn plus per-backend write capture so we can assert
    // real fan-out through the un-mocked terminalManager (only invoke is mocked).
    const writes: Record<string, string[]> = {};
    let spawnCount = 0;
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") {
        spawnCount += 1;
        return { sessionId: `toff-backend-${spawnCount}`, shellName: "bash" };
      }
      if (cmd === "pty_write") {
        const id = args.sessionId as string;
        (writes[id] ??= []).push(args.data as string);
        return undefined;
      }
      if (cmd === "pty_kill") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    const startIndex = createdTerminals.length;
    const store = useSessionStore.getState();
    await store.openLocalSession();
    await store.splitActivePane("row"); // second pane -> second backend
    const termA = createdTerminals[startIndex];
    const [backendA, backendB] = ["toff-backend-1", "toff-backend-2"];

    const tab = useSessionStore.getState().tabs[0];
    useSessionStore.getState().toggleBroadcast(tab.id);
    expect(useSessionStore.getState().tabs[0].broadcastEnabled).toBe(true);

    // Broadcast on: typing into A fans out to B.
    termA.emitData("x");
    await flush();
    expect(writes[backendA]).toEqual(["x"]);
    expect(writes[backendB]).toEqual(["x"]);

    // Toggle broadcast OFF. syncBroadcast now computes an empty membership; the
    // regression is that it must disband the group (clear every former member)
    // rather than call setBroadcastGroup([]) and leave a stale shared peer set.
    useSessionStore.getState().toggleBroadcast(tab.id);
    expect(useSessionStore.getState().tabs[0].broadcastEnabled).toBe(false);

    termA.emitData("y");
    await flush();
    expect(writes[backendA]).toEqual(["x", "y"]);
    expect(writes[backendB]).toEqual(["x"]); // B no longer receives fan-out

    const leaves = collectLeaves(useSessionStore.getState().tabs[0].root);
    for (const leaf of leaves) useSessionStore.getState().closeSession(leaf.sessionId);
  });

  it("toggleActiveBroadcast is a no-op on a single-pane tab", async () => {
    mockLocalSpawn();
    await useSessionStore.getState().openLocalSession();
    useSessionStore.getState().toggleActiveBroadcast();
    expect(useSessionStore.getState().tabs[0].broadcastEnabled).toBeFalsy();
  });
});

describe("splitActivePaneWith", () => {
  it("splits an SSH pane with a DIFFERENT host, spawning the second host", async () => {
    mockSshSpawn();
    await useSessionStore
      .getState()
      .openSshSession("host-1", "prod", "prod.example.com");
    await useSessionStore.getState().splitActivePaneWith("row", {
      kind: "ssh",
      hostId: "host-2",
      title: "stg",
      connectionTarget: "stg.example.com",
    });

    const state = useSessionStore.getState();
    expect(state.tabs).toHaveLength(1);
    const leaves = collectLeaves(state.tabs[0].root);
    expect(leaves).toHaveLength(2);
    const hostIds = leaves.map(
      (l) => state.sessions.find((s) => s.id === l.sessionId)?.hostId,
    );
    expect(new Set(hostIds)).toEqual(new Set(["host-1", "host-2"]));
  });
});

describe("openTemplate / host groups", () => {
  it("opens a host group as ONE grouped tab with a leaf per host", async () => {
    mockSshSpawn();
    const root = buildHostGroupLayout([
      { id: "h1", name: "a", hostname: "a.example.com" },
      { id: "h2", name: "b", hostname: "b.example.com" },
      { id: "h3", name: "c", hostname: "c.example.com" },
    ])!;

    useSessionStore.getState().openTemplate(root);
    await flush();

    const state = useSessionStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(collectLeaves(state.tabs[0].root)).toHaveLength(3);
    const spawnCalls = invoke.mock.calls.filter(
      (call) => call[0] === "ssh_spawn",
    ).length;
    expect(spawnCalls).toBe(3);
  });

  it("round-trips a saved tab: serialize -> validate -> reopen with fresh ids", async () => {
    mockLocalSpawn();
    const store = useSessionStore.getState();
    await store.openLocalSession();
    await store.splitActivePane("row");

    const state = useSessionStore.getState();
    const sourceTab = state.tabs[0];
    const root = serializeNode(sourceTab.root, state.sessions);
    expect(root).not.toBeNull();

    // The serialized shape validates as persisted template storage.
    const parsed = parseTemplates({
      version: 1,
      templates: [{ id: "1", name: "t", createdAt: "x", root }],
    });
    expect(parsed).toHaveLength(1);

    const origLeafIds = collectLeaves(sourceTab.root).map((l) => l.id);
    useSessionStore.getState().openTemplate(parsed[0].root);
    await flush();

    const after = useSessionStore.getState();
    expect(after.tabs).toHaveLength(2);
    const newTab = after.tabs[after.tabs.length - 1];
    const newLeaves = collectLeaves(newTab.root);
    expect(newLeaves).toHaveLength(2);
    // Fresh pane ids — no id is reused from the source tab.
    expect(newLeaves.some((l) => origLeafIds.includes(l.id))).toBe(false);
    // Every leaf was spawned (2 original + 2 restored local panes).
    const spawnCalls = invoke.mock.calls.filter(
      (call) => call[0] === "pty_spawn",
    ).length;
    expect(spawnCalls).toBe(4);
  });
});
