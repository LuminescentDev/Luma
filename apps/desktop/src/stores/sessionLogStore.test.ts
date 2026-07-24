import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setInvoke, invoke } from "../test/tauriMock";
import { terminalManager, type SessionExit } from "../features/terminal/terminalManager";
import { useSessionLogStore } from "./sessionLogStore";

/** Minimal callback bundle satisfying the manager's SessionCallbacks. */
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

const created: string[] = [];

/** Spawn a managed local session so it has a backend id, and return its React id. */
async function spawn(reactId: string, backendId: string): Promise<void> {
  await terminalManager.createSession(
    reactId,
    { kind: "local", ref: undefined },
    callbacks(),
  );
  created.push(reactId);
  // Sanity: the backend id is what the logging commands must receive.
  expect(terminalManager.getBackendId(reactId)).toBe(backendId);
}

beforeEach(() => {
  useSessionLogStore.setState({ logs: {} });
});

afterEach(() => {
  for (const id of created.splice(0)) terminalManager.dispose(id);
});

describe("session logging store", () => {
  it("start resolves the backend id, records the path, and marks active", async () => {
    const seen: Record<string, unknown> = {};
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") return { sessionId: "backend-1", shellName: "bash" };
      if (cmd === "session_log_start") {
        Object.assign(seen, args);
        return "/logs/luma-1.log";
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await spawn("react-1", "backend-1");
    const path = await useSessionLogStore.getState().start("react-1", "raw");

    expect(path).toBe("/logs/luma-1.log");
    // The BACKEND id (not the React id) must reach the command.
    expect(seen.sessionId).toBe("backend-1");
    expect(seen.mode).toBe("raw");
    const entry = useSessionLogStore.getState().logs["react-1"];
    expect(entry).toMatchObject({ active: true, mode: "raw", path: "/logs/luma-1.log" });
  });

  it("rejects starting when the session has no live backend", async () => {
    setInvoke((cmd) => {
      throw new Error(`unexpected ${cmd}`);
    });
    await expect(
      useSessionLogStore.getState().start("ghost", "raw"),
    ).rejects.toMatchObject({ category: "invalid-input" });
    expect(useSessionLogStore.getState().logs["ghost"]).toBeUndefined();
  });

  it("stop calls the backend and clears the entry", async () => {
    let stopped: unknown;
    setInvoke((cmd, args) => {
      if (cmd === "pty_spawn") return { sessionId: "backend-2", shellName: "bash" };
      if (cmd === "session_log_start") return "/logs/luma-2.cast";
      if (cmd === "session_log_stop") {
        stopped = args.sessionId;
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await spawn("react-2", "backend-2");
    await useSessionLogStore.getState().start("react-2", "asciicast");
    await useSessionLogStore.getState().stop("react-2");

    expect(stopped).toBe("backend-2");
    expect(useSessionLogStore.getState().logs["react-2"]).toBeUndefined();
  });

  it("stop on a non-logging session is a no-op that never calls the backend", async () => {
    setInvoke((cmd) => {
      if (cmd === "pty_spawn") return { sessionId: "backend-3", shellName: "bash" };
      throw new Error(`unexpected ${cmd}`);
    });
    await spawn("react-3", "backend-3");
    await useSessionLogStore.getState().stop("react-3");
    expect(invoke).not.toHaveBeenCalledWith("session_log_stop", expect.anything());
  });

  it("markInactive drops the entry without touching the backend", async () => {
    useSessionLogStore.setState({
      logs: { s: { active: true, mode: "raw", path: "/logs/x.log" } },
    });
    useSessionLogStore.getState().markInactive("s");
    expect(useSessionLogStore.getState().logs["s"]).toBeUndefined();
  });
});
