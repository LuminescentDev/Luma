import { create } from "zustand";
import {
  listMultiplexerSessions,
  type MultiplexerAttach,
  type MultiplexerDiscovery,
  type MultiplexerKind,
  type MultiplexerSession,
} from "../lib/multiplexer";
import { parseLumaError } from "../lib/hosts";
import { getAllSettings, setSetting } from "../lib/settings";
import { SETTING_KEYS } from "../types";

/*
 * Remote multiplexer (tmux / zellij) workspace state.
 *
 * Two halves, deliberately separate:
 *  - Discovery for the currently open dialog (one host at a time, like the
 *    web-preview store).
 *  - Per-host "resume this workspace on connect" preferences, persisted
 *    device-local through the existing generic settings commands (the same
 *    mechanism keymap/appearance/templates use — no new persistence layer).
 *
 * The store never builds attach COMMANDS: it only carries
 * { multiplexer, sessionName } and the backend turns that into a validated
 * `tmux attach` / `zellij attach` invocation.
 */

/** Workspace remembered for a host, replayed on the next connect. */
export type ResumeEntry = { multiplexer: MultiplexerKind; sessionName: string };

type MultiplexerState = {
  /** Host whose discovery results are currently held. */
  hostId: string | null;
  discovery: MultiplexerDiscovery | null;
  loading: boolean;
  error: string | null;
  /** hostId -> workspace to re-attach automatically on the next connect. */
  resume: Record<string, ResumeEntry>;
  resumeLoaded: boolean;

  discover: (hostId: string) => Promise<void>;
  /** Load persisted resume preferences once (called from app init). */
  loadResume: () => Promise<void>;
  /** Turn "resume on connect" on (with the given workspace) or off for a host. */
  setResume: (hostId: string, entry: ResumeEntry | null) => Promise<void>;
  clearError: () => void;
};

/** Parse the persisted resume map, dropping anything malformed. Never throws. */
export function parseResumeMap(raw: unknown): Record<string, ResumeEntry> {
  if (!raw || typeof raw !== "object") return {};
  const entries: Record<string, ResumeEntry> = {};
  for (const [hostId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { multiplexer, sessionName } = value as Partial<ResumeEntry>;
    if (multiplexer !== "tmux" && multiplexer !== "zellij") continue;
    if (typeof sessionName !== "string" || sessionName.length === 0) continue;
    entries[hostId] = { multiplexer, sessionName };
  }
  return entries;
}

export const useMultiplexerStore = create<MultiplexerState>((set, get) => ({
  hostId: null,
  discovery: null,
  loading: false,
  error: null,
  resume: {},
  resumeLoaded: false,

  discover: async (hostId) => {
    set({ hostId, loading: true, error: null, discovery: null });
    try {
      const discovery = await listMultiplexerSessions(hostId);
      // A later discovery for another host may have superseded this one.
      if (get().hostId !== hostId) return;
      set({ discovery, loading: false });
    } catch (error) {
      if (get().hostId !== hostId) return;
      const { message } = parseLumaError(error);
      set({ loading: false, error: message, discovery: null });
    }
  },

  loadResume: async () => {
    try {
      const settings = await getAllSettings();
      set({
        resume: parseResumeMap(settings[SETTING_KEYS.multiplexerResume]),
        resumeLoaded: true,
      });
    } catch {
      // First run or unreadable settings: no host resumes anything.
      set({ resumeLoaded: true });
    }
  },

  setResume: async (hostId, entry) => {
    const resume = { ...get().resume };
    if (entry) resume[hostId] = entry;
    else delete resume[hostId];
    set({ resume });
    try {
      await setSetting(SETTING_KEYS.multiplexerResume, resume);
    } catch {
      // Persistence is best-effort; the in-memory preference still applies for
      // this run, matching how the other preference stores behave.
    }
  },

  clearError: () => set({ error: null }),
}));

/** The workspace to auto-attach for a host, or undefined when resume is off.
 * Read imperatively by the session store when a connect has no explicit
 * workspace of its own. */
export function resumeAttachFor(hostId: string): MultiplexerAttach | undefined {
  const entry = useMultiplexerStore.getState().resume[hostId];
  if (!entry) return undefined;
  return {
    multiplexer: entry.multiplexer,
    sessionName: entry.sessionName,
    // Resuming must not fail because the workspace ended: recreate it.
    create: true,
  };
}

/** Discovered sessions of one multiplexer, attached ones first, then by name.
 * Takes just the session list so callers can memoize on it. */
export function selectSessionsByKind(
  sessions: MultiplexerSession[] | undefined,
  kind: MultiplexerKind,
): MultiplexerSession[] {
  return (sessions ?? [])
    .filter((session) => session.kind === kind)
    .sort((left, right) => {
      if (left.attached !== right.attached) return left.attached ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}
