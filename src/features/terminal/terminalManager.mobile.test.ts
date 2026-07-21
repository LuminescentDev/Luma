import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke } from "../../test/tauriMock";
import { createdTerminals } from "../../test/xtermMock";
import { terminalManager, applyModifier, type SessionExit } from "./terminalManager";
import { useCapabilityStore } from "../../stores/capabilityStore";

function callbacks(onExit: (exit: SessionExit) => void = () => {}) {
  return {
    onTitle: () => {},
    onExit,
    onSearchRequested: () => {},
    onSshAuthenticated: () => {},
    onSshPrompt: () => {},
    onSshProgress: () => {},
    onSshIssue: () => {},
    onRemoteOs: () => {},
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  // Force the mobile capability shape so SSH I/O routes through the embedded-SSH
  // commands (ssh_write / ssh_disconnect) instead of the desktop pty_* ones.
  useCapabilityStore.setState({
    capabilities: {
      os: "android",
      isMobile: true,
      features: {
        localTerminal: false,
        serial: false,
        systemSsh: false,
        sftp: true,
        portForwarding: false,
        updater: false,
        biometrics: false,
        windowControls: false,
        folderSync: false,
        dragAndDrop: false,
      },
    },
    loaded: true,
  });
});

describe("terminalManager mobile SSH I/O routing", () => {
  it("writes SSH input via ssh_write and disconnects via ssh_disconnect on mobile", async () => {
    const writes: Array<{ sessionId: string; data: string }> = [];
    const disconnected: string[] = [];
    setInvoke((cmd, args) => {
      if (cmd === "ssh_spawn") return { sessionId: "ssh-backend-1", title: "host" };
      if (cmd === "ssh_write") {
        writes.push({ sessionId: args.sessionId as string, data: args.data as string });
        return null;
      }
      if (cmd === "ssh_disconnect") {
        disconnected.push(args.sessionId as string);
        return null;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const startIndex = createdTerminals.length;
    await terminalManager.createSession(
      "m-ssh",
      { kind: "ssh", hostId: "host-1" },
      callbacks(),
    );
    const term = createdTerminals[startIndex];

    term.emitData("x");
    await tick();
    expect(writes).toEqual([{ sessionId: "ssh-backend-1", data: "x" }]);

    terminalManager.dispose("m-ssh");
    expect(disconnected).toEqual(["ssh-backend-1"]);
  });

  it("never calls pty_* for an SSH session on mobile", async () => {
    const seen: string[] = [];
    setInvoke((cmd, args) => {
      seen.push(cmd);
      if (cmd === "ssh_spawn") return { sessionId: "ssh-backend-2", title: "host" };
      if (cmd === "ssh_write") return null;
      if (cmd === "ssh_disconnect") return null;
      if (cmd.startsWith("pty_")) throw new Error(`pty command used on mobile: ${cmd} ${JSON.stringify(args)}`);
      throw new Error(`unexpected ${cmd}`);
    });

    const startIndex = createdTerminals.length;
    await terminalManager.createSession(
      "m-ssh-2",
      { kind: "ssh", hostId: "host-2" },
      callbacks(),
    );
    createdTerminals[startIndex].emitData("ls\r");
    await tick();
    terminalManager.dispose("m-ssh-2");
    expect(seen.some((cmd) => cmd.startsWith("pty_"))).toBe(false);
  });

  it("applies a one-shot sticky Ctrl to the next typed character", async () => {
    const writes: string[] = [];
    setInvoke((cmd, args) => {
      if (cmd === "ssh_spawn") return { sessionId: "ssh-backend-3", title: "host" };
      if (cmd === "ssh_write") {
        writes.push(args.data as string);
        return null;
      }
      if (cmd === "ssh_disconnect") return null;
      throw new Error(`unexpected ${cmd}`);
    });

    const startIndex = createdTerminals.length;
    await terminalManager.createSession(
      "m-ssh-3",
      { kind: "ssh", hostId: "host-3" },
      callbacks(),
    );
    const term = createdTerminals[startIndex];

    let consumed = false;
    terminalManager.setPendingModifier("m-ssh-3", "ctrl", () => {
      consumed = true;
    });
    expect(terminalManager.pendingModifier("m-ssh-3")).toBe("ctrl");

    term.emitData("c"); // becomes Ctrl+C (\x03)
    await tick();
    expect(writes).toEqual(["\x03"]);
    expect(consumed).toBe(true);
    // Modifier released; the next character is literal.
    expect(terminalManager.pendingModifier("m-ssh-3")).toBeNull();
    term.emitData("d");
    await tick();
    expect(writes).toEqual(["\x03", "d"]);

    terminalManager.dispose("m-ssh-3");
  });
});

describe("applyModifier", () => {
  it("maps Ctrl+letter to the control code", () => {
    expect(applyModifier("ctrl", "c")).toBe("\x03");
    expect(applyModifier("ctrl", "C")).toBe("\x03");
    expect(applyModifier("ctrl", "a")).toBe("\x01");
  });

  it("prefixes ESC for Alt/meta", () => {
    expect(applyModifier("alt", "b")).toBe("\x1bb");
  });

  it("passes through characters with no Ctrl mapping", () => {
    expect(applyModifier("ctrl", "1")).toBe("1");
  });
});
