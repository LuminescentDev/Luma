import { create } from "zustand";
import {
  sessionLogStart,
  sessionLogStop,
  type SessionLogMode,
} from "../lib/sessionLog";
import { terminalManager } from "../features/terminal/terminalManager";

/*
 * Runtime session-logging metadata, keyed by REACT session id (the value the
 * session store uses). The backend owns the actual byte capture; this store
 * only tracks which sessions are currently being logged so the UI can show a
 * recording indicator and the resolved path.
 *
 * The backend commands take the BACKEND session id (terminalManager's
 * backendId), which we resolve here — never the React id. Because logging is
 * runtime-only:
 *  - the backend auto-stops on session exit, and
 *  - a restart mints a new backendId,
 * the store marks a session inactive on exit / restart / close (driven from the
 * session store), so a stale indicator can never outlive the capture.
 */

export type SessionLogEntry = {
  active: boolean;
  mode: SessionLogMode;
  /** Resolved absolute path the backend is writing to. */
  path: string;
};

type SessionLogState = {
  logs: Record<string, SessionLogEntry>;
  /** Begin logging the React session. Resolves the backend id, starts the
   * backend capture, and records the resolved path. Returns that path; rejects
   * (with a Luma-shaped error) when the session is not ready or the backend
   * refuses. */
  start: (sessionId: string, mode: SessionLogMode) => Promise<string>;
  /** Stop logging the React session (no-op if it is not active). */
  stop: (sessionId: string) => Promise<void>;
  /** Mark a session's logging inactive without calling the backend (used when
   * the session exits/restarts and the backend has already stopped). */
  markInactive: (sessionId: string) => void;
};

export const useSessionLogStore = create<SessionLogState>((set, get) => ({
  logs: {},

  start: async (sessionId, mode) => {
    const backendId = terminalManager.getBackendId(sessionId);
    if (!backendId) {
      throw {
        category: "invalid-input",
        message: "This session is not ready for logging yet.",
      };
    }
    const path = await sessionLogStart(backendId, mode);
    set((state) => ({
      logs: { ...state.logs, [sessionId]: { active: true, mode, path } },
    }));
    return path;
  },

  stop: async (sessionId) => {
    const entry = get().logs[sessionId];
    if (!entry?.active) return;
    const backendId = terminalManager.getBackendId(sessionId);
    // The backend id can be gone (session exited between the click and here);
    // in that case the capture is already stopped, so just clear our state.
    if (backendId) {
      // Swallow "session logging is not active": the backend may have auto-
      // stopped just before this call; our optimistic clear below is correct.
      await sessionLogStop(backendId).catch(() => {});
    }
    get().markInactive(sessionId);
  },

  markInactive: (sessionId) =>
    set((state) => {
      if (!state.logs[sessionId]) return {};
      const logs = { ...state.logs };
      delete logs[sessionId];
      return { logs };
    }),
}));

/** Selector: the logging entry for a session, or undefined when not logging. */
export function selectSessionLog(
  state: SessionLogState,
  sessionId: string,
): SessionLogEntry | undefined {
  return state.logs[sessionId];
}
