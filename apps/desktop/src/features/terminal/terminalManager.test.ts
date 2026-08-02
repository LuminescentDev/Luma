import { describe, it, expect, vi } from "vitest";
import { setInvoke } from "../../test/tauriMock";
import { createdTerminals, type Terminal } from "../../test/xtermMock";
import {
  terminalManager,
  isSpawnAbandoned,
  type SessionExit,
} from "./terminalManager";

/** No-op callback bundle satisfying the manager's SessionCallbacks. */
function callbacks(
  onExit: (exit: SessionExit) => void = () => {},
  onSshPrompt: (prompt: {
    type: "credential";
    label: string;
    target?: string;
    secret?: boolean;
  }) => void = () => {},
) {
  return {
    onTitle: () => {},
    onExit,
    onSearchRequested: () => {},
    onSshAuthenticated: () => {},
    onSshPrompt,
    onSshProgress: () => {},
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

describe("terminalManager SSH credential prompts", () => {
  it("parses split embedded prompt markers and deduplicates repeats", async () => {
    const prompts: Array<{
      type: "credential";
      label: string;
      target?: string;
      secret?: boolean;
    }> = [];
    let dataChannel:
      | { onmessage: (message: string | number[] | ArrayBuffer) => void }
      | undefined;
    setInvoke((cmd, args) => {
      if (cmd === "ssh_spawn") {
        dataChannel = args.onData as typeof dataChannel;
        return { sessionId: "prompt-backend", title: "jump host" };
      }
      if (cmd === "ssh_disconnect") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    await terminalManager.createSession(
      "prompt-1",
      { kind: "ssh", hostId: "host-1" },
      callbacks(() => {}, (prompt) => prompts.push(prompt)),
    );

    const payload = JSON.stringify({
      label: 'Verification code "OTP":',
      secret: false,
      target: "alice@jump.example.com",
    });
    const marker = `__LUMA_SSH_PROMPT__${payload}\r\n`;
    const split = marker.indexOf("secret");
    dataChannel?.onmessage(marker.slice(0, split));
    expect(prompts).toEqual([]);

    dataChannel?.onmessage(marker.slice(split));
    expect(prompts).toEqual([
      {
        type: "credential",
        label: 'Verification code "OTP":',
        secret: false,
        target: "alice@jump.example.com",
      },
    ]);

    dataChannel?.onmessage(marker);
    expect(prompts).toHaveLength(1);
    terminalManager.dispose("prompt-1");
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

describe("terminalManager fit overflow", () => {
  /** Mount a session into a host of `hostHeight` px whose rendered grid measures
   * `renderedHeight` px, then fit. jsdom does no layout, so both heights are
   * stubbed: clientHeight on the host and the screen's bounding rect. */
  async function fitInto(
    id: string,
    hostHeight: number,
    renderedHeight: number,
    hostPaddingTop = 0,
  ): Promise<Terminal> {
    setInvoke((cmd) => {
      if (cmd === "pty_spawn") return { sessionId: `${id}-backend`, shellName: "bash" };
      if (cmd === "pty_kill") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    const startIndex = createdTerminals.length;
    await terminalManager.createSession(id, { kind: "local", ref: undefined }, callbacks());
    const term = createdTerminals[startIndex];

    const host = document.createElement("div");
    // The pane host reserves top padding (pl-2 pt-1.5); clientHeight includes it.
    if (hostPaddingTop) host.style.paddingTop = `${hostPaddingTop}px`;
    document.body.appendChild(host);
    Object.defineProperty(host, "clientHeight", {
      value: hostHeight,
      configurable: true,
    });
    terminalManager.attach(id, host);

    const screen = term.element?.querySelector(".xterm-screen") as HTMLElement;
    screen.getBoundingClientRect = () =>
      ({ height: renderedHeight }) as DOMRect;
    return term;
  }

  it("drops a row when the fitted grid renders past the container", async () => {
    // 24 rows measuring 3px taller than the space available clips the last line.
    const term = await fitInto("fit-over", 500, 503);
    term.resize(80, 24);

    terminalManager.fitSession("fit-over");

    expect(term.rows).toBe(23);
    expect(term.cols).toBe(80);

    terminalManager.dispose("fit-over");
  });

  it("keeps the grid when it fits, ignoring sub-pixel overflow", async () => {
    const term = await fitInto("fit-exact", 500, 500.4);
    term.resize(80, 24);

    terminalManager.fitSession("fit-exact");

    expect(term.rows).toBe(24);

    terminalManager.dispose("fit-exact");
  });

  it("drops a row when the grid overflows the host's padded content box", async () => {
    // clientHeight (500) counts the host's 6px top padding, so a grid rendering
    // 498px sits within clientHeight yet overflows the 494px content box the
    // terminal actually fills — its last line is clipped unless a row is dropped.
    const term = await fitInto("fit-pad", 500, 498, 6);
    term.resize(80, 24);

    terminalManager.fitSession("fit-pad");

    expect(term.rows).toBe(23);

    terminalManager.dispose("fit-pad");
  });

  it("never drops below a single row", async () => {
    const term = await fitInto("fit-tiny", 10, 40);
    term.resize(80, 1);

    terminalManager.fitSession("fit-tiny");

    expect(term.rows).toBe(1);

    terminalManager.dispose("fit-tiny");
  });
});

describe("terminalManager buffer snapshot", () => {
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

  it("serializes plain lines without escapes and drops trailing blanks", async () => {
    const term = await createLocal("buf-plain");
    term.setLine(0, "hello   ");
    term.setLine(1, "world");

    // Trailing unstyled blanks are dropped, and so are the empty viewport rows
    // below the last content line.
    expect(terminalManager.getBufferText("buf-plain")).toBe("hello\r\nworld");

    terminalManager.dispose("buf-plain");
  });

  it("emits SGR escapes so a replayed buffer keeps its colors", async () => {
    const term = await createLocal("buf-color");
    // "ab" red-on-default, "cd" plain.
    term.setLine(0, "abcd", [
      { fgPalette: 1 },
      { fgPalette: 1 },
      undefined,
      undefined,
    ]);

    // Leaving a styled run resets so attributes never leak into the next one.
    expect(terminalManager.getBufferText("buf-color")).toBe(
      "\x1b[38;5;1mab\x1b[0mcd",
    );

    terminalManager.dispose("buf-color");
  });

  it("unstyles interior blanks that separate styled runs", async () => {
    const term = await createLocal("buf-gap");
    term.setLine(0, "a b", [{ bgPalette: 4 }, undefined, { bgPalette: 4 }]);

    // The gap must not inherit the run's background, or the replayed line shows
    // a solid block where the original had none.
    expect(terminalManager.getBufferText("buf-gap")).toBe(
      "\x1b[48;5;4ma\x1b[0m \x1b[48;5;4mb\x1b[0m",
    );

    terminalManager.dispose("buf-gap");
  });

  it("clears a display session so re-applying a snapshot is idempotent", () => {
    const startIndex = createdTerminals.length;
    terminalManager.createDisplaySession("disp-reset");
    const term = createdTerminals[startIndex];
    const reset = vi.spyOn(term, "reset");
    const write = vi.spyOn(term, "write");

    terminalManager.resetOutput("disp-reset");
    terminalManager.writeOutput("disp-reset", "snapshot");

    expect(reset).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith("snapshot");

    terminalManager.dispose("disp-reset");
  });

  it("does not reset a backend session (its output comes from the PTY)", async () => {
    const term = await createLocal("buf-backend");
    const reset = vi.spyOn(term, "reset");

    terminalManager.resetOutput("buf-backend");

    expect(reset).not.toHaveBeenCalled();

    terminalManager.dispose("buf-backend");
  });
});

describe("terminalManager preview mirror", () => {
  /** Stub the PTY backend, create a local session, and return its terminal plus
   * the data channel the backend would push output through. */
  async function createLocalWithOutput(id: string): Promise<{
    term: Terminal;
    emit: (data: string) => void;
  }> {
    let dataChannel: { onmessage: (message: string) => void } | undefined;
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") {
        dataChannel = args.onData as typeof dataChannel;
        return { sessionId: `${id}-backend`, shellName: "bash" };
      }
      if (cmd === "pty_kill" || cmd === "pty_resize") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    const startIndex = createdTerminals.length;
    await terminalManager.createSession(id, { kind: "local", ref: undefined }, callbacks());
    return {
      term: createdTerminals[startIndex],
      emit: (data) => dataChannel?.onmessage(data),
    };
  }

  /** The terminal the mirror created (the most recent one). */
  function newestTerminal(): Terminal {
    return createdTerminals[createdTerminals.length - 1];
  }

  it("seeds the mirror with the source's buffer, then streams its live output", async () => {
    const { term, emit } = await createLocalWithOutput("mirror-src");
    term.setLine(0, "hello");
    term.setLine(1, "world");

    const stop = terminalManager.mirrorSession("preview:mirror-src", "mirror-src");
    const mirror = newestTerminal();

    expect(mirror.writes).toEqual(["hello\r\nworld"]);

    emit("later output");
    expect(mirror.writes).toEqual(["hello\r\nworld", "later output"]);

    stop();
    terminalManager.dispose("mirror-src");
  });

  it("seeds only the tail of a long buffer", async () => {
    const { term } = await createLocalWithOutput("mirror-tail");
    for (let line = 0; line < 10; line += 1) term.setLine(line, `line ${line}`);

    const stop = terminalManager.mirrorSession("preview:mirror-tail", "mirror-tail", {
      lines: 3,
    });

    expect(newestTerminal().writes).toEqual(["line 7\r\nline 8\r\nline 9"]);

    stop();
    terminalManager.dispose("mirror-tail");
  });

  it("is read-only, so a preview can never type into the source", async () => {
    await createLocalWithOutput("mirror-ro");

    const stop = terminalManager.mirrorSession("preview:mirror-ro", "mirror-ro");

    expect(newestTerminal().options.disableStdin).toBe(true);

    stop();
    terminalManager.dispose("mirror-ro");
  });

  it("stops streaming and disposes the mirror on teardown", async () => {
    const { emit } = await createLocalWithOutput("mirror-stop");
    const stop = terminalManager.mirrorSession("preview:mirror-stop", "mirror-stop");
    const mirror = newestTerminal();

    stop();
    mirror.writes.length = 0;
    emit("after teardown");

    expect(mirror.writes).toEqual([]);
    // The id is released, so re-mirroring the same session (scrolling the card
    // back into view) builds a fresh terminal instead of hitting the duplicate
    // guard and silently showing nothing.
    const restarted = terminalManager.mirrorSession("preview:mirror-stop", "mirror-stop");
    expect(newestTerminal()).not.toBe(mirror);

    restarted();
    terminalManager.dispose("mirror-stop");
  });

  it("no-ops for a session that does not exist yet", () => {
    const before = createdTerminals.length;

    const stop = terminalManager.mirrorSession("preview:absent", "absent");
    stop();

    expect(createdTerminals.length).toBe(before);
  });

  it("does not mirror twice into the same preview id", async () => {
    const { emit } = await createLocalWithOutput("mirror-dupe");
    const stop = terminalManager.mirrorSession("preview:mirror-dupe", "mirror-dupe");
    const mirror = newestTerminal();
    const after = createdTerminals.length;

    const second = terminalManager.mirrorSession("preview:mirror-dupe", "mirror-dupe");
    second();

    // The duplicate created nothing, and its teardown left the first mirror
    // alive rather than disposing a terminal it does not own.
    expect(createdTerminals.length).toBe(after);
    mirror.writes.length = 0;
    emit("still live");
    expect(mirror.writes).toEqual(["still live"]);

    stop();
    terminalManager.dispose("mirror-dupe");
  });
});
