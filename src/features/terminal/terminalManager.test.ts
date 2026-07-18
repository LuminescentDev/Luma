import { describe, it, expect } from "vitest";
import { setInvoke } from "../../test/tauriMock";
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
