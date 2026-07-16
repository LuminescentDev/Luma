import { create } from "zustand";
import type { TerminalSession } from "../types";

/*
 * Session METADATA only. Terminal byte streams and xterm.js instances live
 * outside React state entirely (wired up in Phase 2).
 */
type SessionState = {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  openLocalSession: () => void;
  closeSession: (id: string) => void;
  setActiveSession: (id: string) => void;
};

let localCounter = 0;

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  activeSessionId: null,

  openLocalSession: () => {
    localCounter += 1;
    const id = crypto.randomUUID();
    const session: TerminalSession = {
      id,
      title: localCounter > 1 ? `Local ${localCounter}` : "Local",
      type: "local",
      status: "connected",
      activePaneId: id,
    };
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: id,
    }));
  },

  closeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeSessionId =
        state.activeSessionId === id
          ? (sessions[sessions.length - 1]?.id ?? null)
          : state.activeSessionId;
      return { sessions, activeSessionId };
    }),

  setActiveSession: (id) => set({ activeSessionId: id }),
}));
