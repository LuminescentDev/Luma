import { describe, it, expect, vi } from "vitest";
import { setInvoke } from "../../test/tauriMock";
import { createdTerminals, type Terminal } from "../../test/xtermMock";
import {
  terminalManager,
  isSpawnAbandoned,
  type SessionExit,
} from "./terminalManager";

/** No-op callback bundle satisfying the manager's SessionCallbacks. */
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

describe("terminalManager spawn races", () => {
  it("kills the backend that resolves after the session was disposed", async () => {
    const killed: string[] = [];
    let resolveSpawn: (() => void) | undefined;
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") {
        return new Promise((resolve) => {
          resolveSpawn = () =>
            resolve({ sessionId: "late-backend", shellName: "bash" });
        });
      }
      if (cmd === "pty_kill") {
        killed.push(args.sessionId as string);
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const promise = terminalManager.createSession(
      "disp-1",
      { kind: "local", ref: undefined },
      callbacks(),
    );
    // Dispose while the backend spawn is still in flight.
    terminalManager.dispose("disp-1");
    resolveSpawn?.();

    let disposeErr: unknown;
    await promise.catch((error: unknown) => {
      disposeErr = error;
    });
    expect(isSpawnAbandoned(disposeErr)).toBe(true);
    expect(killed).toContain("late-backend");
  });

  it("kills a superseded spawn when a restart happens mid-spawn", async () => {
    const killed: string[] = [];
    let resolveFirst: (() => void) | undefined;
    let firstStarted = false;
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") {
        if (!firstStarted) {
          firstStarted = true;
          return new Promise((resolve) => {
            resolveFirst = () =>
              resolve({ sessionId: "backend-old", shellName: "bash" });
          });
        }
        return { sessionId: "backend-new", shellName: "bash" };
      }
      if (cmd === "pty_kill") {
        killed.push(args.sessionId as string);
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const first = terminalManager.createSession(
      "restart-1",
      { kind: "local", ref: undefined },
      callbacks(),
    );
    // Restart before the first spawn resolves: this bumps the generation and
    // installs backend-new.
    const restarted = terminalManager.restart("restart-1");
    await restarted;
    resolveFirst?.();

    let staleErr: unknown;
    await first.catch((error: unknown) => {
      staleErr = error;
    });
    expect(isSpawnAbandoned(staleErr)).toBe(true);
    // The orphaned first backend must be killed; the winning one must not.
    expect(killed).toContain("backend-old");
    expect(killed).not.toContain("backend-new");

    terminalManager.dispose("restart-1");
  });

  it("does not resurrect a session whose restart spawn exits immediately", async () => {
    const exits: SessionExit[] = [];
    // First spawn stays alive; the restart spawn exits before its invoke resolves.
    let started = 0;
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") {
        started += 1;
        if (started === 2) {
          (args.onExit as { onmessage: (code: number | null) => void }).onmessage(
            0,
          );
        }
        return { sessionId: `backend-${started}`, shellName: "bash" };
      }
      if (cmd === "pty_kill") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    await terminalManager.createSession(
      "restart-2",
      { kind: "local", ref: undefined },
      callbacks((exit) => exits.push(exit)),
    );
    await terminalManager.restart("restart-2");
    await tick();

    // The restart's backend exited during spawn; exactly one exit reported.
    expect(exits).toHaveLength(1);
    expect(exits[0].code).toBe(0);

    terminalManager.dispose("restart-2");
  });
});

describe("terminalManager input flow", () => {
  it("serializes writes and coalesces input that arrives during IPC", async () => {
    const writes: string[] = [];
    const pendingResolvers: Array<() => void> = [];
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") {
        return { sessionId: "input-backend", shellName: "bash" };
      }
      if (cmd === "pty_write") {
        writes.push(args.data as string);
        return new Promise<void>((resolve) => pendingResolvers.push(resolve));
      }
      if (cmd === "pty_kill") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    await terminalManager.createSession(
      "input-1",
      { kind: "local", ref: undefined },
      callbacks(),
    );

    terminalManager.sendInput("input-1", "a");
    terminalManager.sendInput("input-1", "b");
    terminalManager.sendInput("input-1", "\x7f");
    expect(writes).toEqual(["a"]);

    pendingResolvers.shift()?.();
    await tick();
    expect(writes).toEqual(["a", "b\x7f"]);

    pendingResolvers.shift()?.();
    await tick();
    terminalManager.dispose("input-1");
  });
});

describe("terminalManager broadcast groups", () => {
  it("fans keystrokes out to every group member, once each, through the coalescing lane", async () => {
    const writes: Record<string, string[]> = {};
    let spawnCount = 0;
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") {
        spawnCount += 1;
        return { sessionId: `bc-backend-${spawnCount}`, shellName: "bash" };
      }
      if (cmd === "pty_write") {
        const id = args.sessionId as string;
        (writes[id] ??= []).push(args.data as string);
        return undefined;
      }
      if (cmd === "pty_kill") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    // Backend ids are assigned in creation order (bc-a -> 1, bc-b -> 2, bc-c -> 3).
    const startIndex = createdTerminals.length;
    await terminalManager.createSession("bc-a", { kind: "local", ref: undefined }, callbacks());
    await terminalManager.createSession("bc-b", { kind: "local", ref: undefined }, callbacks());
    await terminalManager.createSession("bc-c", { kind: "local", ref: undefined }, callbacks());
    const termA = createdTerminals[startIndex];
    const [backendA, backendB, backendC] = ["bc-backend-1", "bc-backend-2", "bc-backend-3"];

    // Group all three: typing into A fans the SAME byte out to B and C, and A
    // receives it exactly once (peers are the group minus self).
    terminalManager.setBroadcastGroup(["bc-a", "bc-b", "bc-c"]);
    termA.emitData("x");
    await tick();
    expect(writes[backendA]).toEqual(["x"]);
    expect(writes[backendB]).toEqual(["x"]);
    expect(writes[backendC]).toEqual(["x"]);

    // Exclude C (redefine the group without it): C stops receiving input.
    terminalManager.setBroadcastGroup(["bc-a", "bc-b"]);
    termA.emitData("y");
    await tick();
    expect(writes[backendA]).toEqual(["x", "y"]);
    expect(writes[backendB]).toEqual(["x", "y"]);
    expect(writes[backendC]).toEqual(["x"]); // unchanged

    // Disposing a member disbands a two-pane group; A then types only to itself.
    terminalManager.dispose("bc-b");
    termA.emitData("z");
    await tick();
    expect(writes[backendA]).toEqual(["x", "y", "z"]);
    expect(writes[backendB]).toEqual(["x", "y"]); // disposed, no new writes

    terminalManager.dispose("bc-a");
    terminalManager.dispose("bc-c");
  });

  it("stops fan-out once broadcast is disabled by clearing every former member", async () => {
    const writes: Record<string, string[]> = {};
    let spawnCount = 0;
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") {
        spawnCount += 1;
        return { sessionId: `off-backend-${spawnCount}`, shellName: "bash" };
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
    await terminalManager.createSession("off-a", { kind: "local", ref: undefined }, callbacks());
    await terminalManager.createSession("off-b", { kind: "local", ref: undefined }, callbacks());
    const termA = createdTerminals[startIndex];
    const [backendA, backendB] = ["off-backend-1", "off-backend-2"];

    // Enable broadcast: typing into A fans out to B.
    terminalManager.setBroadcastGroup(["off-a", "off-b"]);
    termA.emitData("x");
    await tick();
    expect(writes[backendA]).toEqual(["x"]);
    expect(writes[backendB]).toEqual(["x"]);

    // Disable broadcast. The store computes an empty membership and, rather than
    // calling setBroadcastGroup([]) (which cannot find the shared peer set to
    // detach through an empty list), clears each former member individually so no
    // stale broadcastPeers set survives. Typing into A must no longer reach B.
    terminalManager.clearBroadcastGroup("off-a");
    terminalManager.clearBroadcastGroup("off-b");
    termA.emitData("y");
    await tick();
    expect(writes[backendA]).toEqual(["x", "y"]);
    expect(writes[backendB]).toEqual(["x"]); // unchanged: fan-out stopped

    terminalManager.dispose("off-a");
    terminalManager.dispose("off-b");
  });

  it("never delivers input to an excluded session even when it is the origin", async () => {
    const writes: Record<string, string[]> = {};
    let spawnCount = 0;
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") {
        spawnCount += 1;
        return { sessionId: `ex-backend-${spawnCount}`, shellName: "bash" };
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
    await terminalManager.createSession("ex-a", { kind: "local", ref: undefined }, callbacks());
    await terminalManager.createSession("ex-b", { kind: "local", ref: undefined }, callbacks());
    const termB = createdTerminals[startIndex + 1];

    // Group only A; B is excluded. B still echoes its own keystrokes locally but
    // must not fan anything out (it has no peers) and A must not receive them.
    terminalManager.setBroadcastGroup(["ex-a"]); // fewer than two -> no group
    termB.emitData("q");
    await tick();
    expect(writes["ex-backend-1"]).toBeUndefined(); // A untouched
    expect(writes["ex-backend-2"]).toEqual(["q"]); // B typed to itself only

    terminalManager.dispose("ex-a");
    terminalManager.dispose("ex-b");
  });
});

describe("terminalManager shell integration", () => {
  /** Stub the PTY backend and create a local session, returning its terminal. */
  async function createLocal(id: string): Promise<Terminal> {
    setInvoke((cmd) => {
      if (cmd === "pty_spawn") return { sessionId: `${id}-backend`, shellName: "bash" };
      if (cmd === "pty_kill") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    const startIndex = createdTerminals.length;
    await terminalManager.createSession(id, { kind: "local", ref: undefined }, callbacks());
    return createdTerminals[startIndex];
  }

  it("records a command mark with exit code for an A/B/C/D sequence", async () => {
    const term = await createLocal("si-mark");
    term.markerLine = 0;
    term.emitOsc(133, "A"); // prompt start
    term.emitOsc(133, "B"); // command start (no state)
    term.markerLine = 1;
    term.emitOsc(133, "C"); // output start
    term.markerLine = 5;
    term.emitOsc(133, "D;1"); // finished, nonzero exit

    const marks = terminalManager.getCommandMarks("si-mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].line).toBe(0);
    expect(marks[0].exitCode).toBe(1);
    expect(marks[0].failed).toBe(true);

    terminalManager.dispose("si-mark");
  });

  it("does not flag a successful command as failed", async () => {
    const term = await createLocal("si-ok");
    term.markerLine = 0;
    term.emitOsc(133, "A");
    term.markerLine = 1;
    term.emitOsc(133, "C");
    term.markerLine = 2;
    term.emitOsc(133, "D;0");

    const marks = terminalManager.getCommandMarks("si-ok");
    expect(marks).toHaveLength(1);
    expect(marks[0].exitCode).toBe(0);
    expect(marks[0].failed).toBe(false);

    terminalManager.dispose("si-ok");
  });

  it("caps the retained marks at 500", async () => {
    const term = await createLocal("si-cap");
    for (let i = 0; i < 600; i++) {
      term.markerLine = i;
      term.emitOsc(133, "A");
    }
    const marks = terminalManager.getCommandMarks("si-cap");
    expect(marks).toHaveLength(500);
    // The oldest were dropped: lines start at 100, end at 599.
    expect(marks[0].line).toBe(100);
    expect(marks[marks.length - 1].line).toBe(599);

    terminalManager.dispose("si-cap");
  });

  it("filters out marks whose marker was disposed by scrollback trim", async () => {
    const term = await createLocal("si-disp");
    term.markerLine = 0;
    term.emitOsc(133, "A");
    term.markerLine = 1;
    term.emitOsc(133, "A");
    term.markerLine = 2;
    term.emitOsc(133, "A");

    // xterm disposes markers when their line leaves the scrollback; simulate the
    // middle one being trimmed.
    term.markers[1].dispose();

    const marks = terminalManager.getCommandMarks("si-disp");
    expect(marks.map((mark) => mark.line)).toEqual([0, 2]);

    terminalManager.dispose("si-disp");
  });

  it("parses OSC 7 (Windows + POSIX) and OSC 1337 CurrentDir into getCwd", async () => {
    const term = await createLocal("si-cwd");
    expect(terminalManager.getCwd("si-cwd")).toBeNull();

    term.emitOsc(7, "file://myhost/C:/Users/me");
    expect(terminalManager.getCwd("si-cwd")).toBe("C:/Users/me");

    term.emitOsc(7, "file://myhost/home/me");
    expect(terminalManager.getCwd("si-cwd")).toBe("/home/me");

    term.emitOsc(1337, "CurrentDir=/var/log");
    expect(terminalManager.getCwd("si-cwd")).toBe("/var/log");

    // Non-CurrentDir OSC 1337 subcommands are ignored (cwd unchanged).
    term.emitOsc(1337, "SetMark");
    expect(terminalManager.getCwd("si-cwd")).toBe("/var/log");

    terminalManager.dispose("si-cwd");
  });

  it("copies the last command's output between the C and D marks", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const term = await createLocal("si-copy");
    term.markerLine = 0;
    term.emitOsc(133, "A");
    term.markerLine = 1;
    term.emitOsc(133, "C"); // output starts on line 1
    term.setLine(1, "hello");
    term.setLine(2, "world");
    term.markerLine = 3;
    term.emitOsc(133, "D;0"); // output ends before line 3

    const copied = terminalManager.copyLastCommandOutput("si-copy");
    expect(copied).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello\nworld");

    terminalManager.dispose("si-copy");
  });

  it("jumps the viewport to the previous/next prompt mark", async () => {
    const term = await createLocal("si-jump");
    term.markerLine = 2;
    term.emitOsc(133, "A");
    term.markerLine = 10;
    term.emitOsc(133, "A");

    term.viewportY = 20;
    terminalManager.jumpToPrompt("si-jump", "previous");
    expect(term.scrolledTo).toBe(10);

    term.viewportY = 5;
    terminalManager.jumpToPrompt("si-jump", "next");
    expect(term.scrolledTo).toBe(10);

    term.viewportY = 0;
    terminalManager.jumpToPrompt("si-jump", "previous"); // nothing before line 0
    expect(term.scrolledTo).toBe(10); // unchanged

    terminalManager.dispose("si-jump");
  });

  it("degrades gracefully with no marks (actions are no-ops)", async () => {
    const term = await createLocal("si-none");
    expect(terminalManager.hasCommandMarks("si-none")).toBe(false);
    expect(terminalManager.getCwd("si-none")).toBeNull();
    expect(terminalManager.copyLastCommandOutput("si-none")).toBe(false);
    expect(terminalManager.copyCwd("si-none")).toBe(false);
    terminalManager.jumpToPrompt("si-none", "next");
    expect(term.scrolledTo).toBeNull();

    terminalManager.dispose("si-none");
  });
});
