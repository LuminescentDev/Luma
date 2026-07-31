import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke } from "../test/tauriMock";
import {
  parseResumeMap,
  resumeAttachFor,
  selectSessionsByKind,
  useMultiplexerStore,
} from "./multiplexerStore";
import { SETTING_KEYS } from "../types";
import type { MultiplexerSession } from "../lib/multiplexer";

function session(
  overrides: Partial<MultiplexerSession> = {},
): MultiplexerSession {
  return {
    kind: "tmux",
    name: "main",
    windows: null,
    windowCount: 2,
    attached: false,
    activityTs: 1_700_000_000,
    createdTs: 1_699_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  useMultiplexerStore.setState({
    hostId: null,
    discovery: null,
    loading: false,
    error: null,
    resume: {},
    resumeLoaded: false,
  });
});

describe("multiplexer store", () => {
  it("discover stores the host's workspaces", async () => {
    const seen: Record<string, unknown> = {};
    setInvoke((cmd, args) => {
      expect(cmd).toBe("multiplexer_list");
      Object.assign(seen, args);
      return {
        tmuxAvailable: true,
        zellijAvailable: false,
        sessions: [session()],
      };
    });

    await useMultiplexerStore.getState().discover("host-1");

    expect(seen).toEqual({ hostId: "host-1" });
    const state = useMultiplexerStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.discovery?.tmuxAvailable).toBe(true);
    expect(state.discovery?.zellijAvailable).toBe(false);
    expect(state.discovery?.sessions).toEqual([session()]);
  });

  it("discover surfaces a failure and keeps no stale results", async () => {
    useMultiplexerStore.setState({
      discovery: { tmuxAvailable: true, zellijAvailable: true, sessions: [] },
    });
    setInvoke(() => {
      throw { category: "ssh-error", message: "host unreachable" };
    });

    await useMultiplexerStore.getState().discover("host-1");

    const state = useMultiplexerStore.getState();
    expect(state.loading).toBe(false);
    expect(state.discovery).toBeNull();
    expect(state.error).toContain("host unreachable");
  });

  it("discover ignores a result superseded by another host", async () => {
    setInvoke(() => {
      // Another host's dialog took over while this request was in flight.
      useMultiplexerStore.setState({ hostId: "host-2" });
      return { tmuxAvailable: true, zellijAvailable: true, sessions: [session()] };
    });

    await useMultiplexerStore.getState().discover("host-1");

    expect(useMultiplexerStore.getState().discovery).toBeNull();
  });

  it("setResume persists one workspace per host and clears it again", async () => {
    const writes: unknown[] = [];
    setInvoke((cmd, args) => {
      expect(cmd).toBe("settings_set");
      expect(args.key).toBe(SETTING_KEYS.multiplexerResume);
      writes.push(args.value);
      return null;
    });

    await useMultiplexerStore
      .getState()
      .setResume("host-1", { multiplexer: "tmux", sessionName: "main" });
    expect(useMultiplexerStore.getState().resume["host-1"]).toEqual({
      multiplexer: "tmux",
      sessionName: "main",
    });
    // Resume recreates the workspace so a connect never fails on a dead name.
    expect(resumeAttachFor("host-1")).toEqual({
      multiplexer: "tmux",
      sessionName: "main",
      create: true,
    });

    await useMultiplexerStore
      .getState()
      .setResume("host-1", { multiplexer: "zellij", sessionName: "deploy" });
    expect(useMultiplexerStore.getState().resume["host-1"].multiplexer).toBe(
      "zellij",
    );

    await useMultiplexerStore.getState().setResume("host-1", null);
    expect(useMultiplexerStore.getState().resume["host-1"]).toBeUndefined();
    expect(resumeAttachFor("host-1")).toBeUndefined();
    expect(writes).toHaveLength(3);
    expect(writes[2]).toEqual({});
  });

  it("setResume keeps the preference for this run when the write fails", async () => {
    setInvoke(() => {
      throw new Error("settings unavailable");
    });

    await useMultiplexerStore
      .getState()
      .setResume("host-1", { multiplexer: "tmux", sessionName: "main" });

    expect(resumeAttachFor("host-1")?.sessionName).toBe("main");
  });

  it("loadResume hydrates from settings and drops malformed entries", async () => {
    setInvoke((cmd) => {
      expect(cmd).toBe("settings_get_all");
      return {
        [SETTING_KEYS.multiplexerResume]: {
          "host-1": { multiplexer: "tmux", sessionName: "main" },
          "host-2": { multiplexer: "screen", sessionName: "x" },
          "host-3": { multiplexer: "zellij" },
          "host-4": "nonsense",
        },
      };
    });

    await useMultiplexerStore.getState().loadResume();

    const state = useMultiplexerStore.getState();
    expect(state.resumeLoaded).toBe(true);
    expect(Object.keys(state.resume)).toEqual(["host-1"]);
  });

  it("loadResume tolerates unreadable settings", async () => {
    setInvoke(() => {
      throw new Error("no settings");
    });

    await useMultiplexerStore.getState().loadResume();

    expect(useMultiplexerStore.getState().resumeLoaded).toBe(true);
    expect(useMultiplexerStore.getState().resume).toEqual({});
  });

  it("parseResumeMap rejects non-object input", () => {
    expect(parseResumeMap(null)).toEqual({});
    expect(parseResumeMap("nope")).toEqual({});
    expect(parseResumeMap({ h: { multiplexer: "tmux", sessionName: "" } })).toEqual(
      {},
    );
  });

  it("selects one multiplexer's sessions, attached first then by name", () => {
    const sessions = [
      session({ name: "zeta" }),
      session({ name: "alpha" }),
      session({ name: "omega", attached: true }),
      session({ kind: "zellij", name: "other" }),
    ];

    expect(selectSessionsByKind(sessions, "tmux").map((s) => s.name)).toEqual([
      "omega",
      "alpha",
      "zeta",
    ]);
    expect(selectSessionsByKind(sessions, "zellij").map((s) => s.name)).toEqual([
      "other",
    ]);
    expect(selectSessionsByKind(undefined, "tmux")).toEqual([]);
  });
});
