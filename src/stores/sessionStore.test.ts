import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke, invoke } from "../test/tauriMock";
import { useSessionStore } from "./sessionStore";
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
