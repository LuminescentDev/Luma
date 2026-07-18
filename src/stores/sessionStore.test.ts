import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke, invoke } from "../test/tauriMock";
import { useSessionStore } from "./sessionStore";
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
    await flush();
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
    await flush();
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
