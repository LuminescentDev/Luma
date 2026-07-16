import { create } from "zustand";
import type { TerminalSession } from "../types";
import type { ShellRef } from "../lib/terminal";
import { terminalManager } from "../features/terminal/terminalManager";
import { useUiStore } from "./uiStore";

/*
 * Session METADATA only. Terminal byte streams and xterm.js instances live in
 * terminalManager, entirely outside React.
 */
type SessionState = {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  openLocalSession: (ref?: ShellRef, title?: string) => Promise<void>;
  restartSession: (id: string) => Promise<void>;
  closeSession: (id: string) => void;
  setActiveSession: (id: string) => void;
};

function patchSession(
  sessions: TerminalSession[],
  id: string,
  patch: Partial<TerminalSession>,
): TerminalSession[] {
  return sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,

  openLocalSession: async (ref, title) => {
    const id = crypto.randomUUID();
    const session: TerminalSession = {
      id,
      title: title ?? "Terminal",
      type: "local",
      status: "connecting",
      activePaneId: id,
    };
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: id,
    }));

    try {
      const result = await terminalManager.createSession(id, ref, {
        onTitle: (nextTitle) =>
          set((state) => ({
            sessions: patchSession(state.sessions, id, { title: nextTitle }),
          })),
        onExit: (code) =>
          set((state) => ({
            sessions: patchSession(state.sessions, id, {
              status: "disconnected",
              exitCode: code,
            }),
          })),
        onSearchRequested: () => useUiStore.getState().setTerminalSearchOpen(true),
      });
      set((state) => ({
        sessions: patchSession(state.sessions, id, {
          status: "connected",
          title: title ?? result.shellName,
        }),
      }));
    } catch (error) {
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      set((state) => ({
        sessions: patchSession(state.sessions, id, {
          status: "error",
          errorMessage: message,
        }),
      }));
    }
  },

  restartSession: async (id) => {
    set((state) => ({
      sessions: patchSession(state.sessions, id, {
        status: "connecting",
        exitCode: undefined,
        errorMessage: undefined,
      }),
    }));
    try {
      const result = await terminalManager.restart(id);
      set((state) => ({
        sessions: patchSession(state.sessions, id, {
          status: "connected",
          title: result.shellName,
        }),
      }));
    } catch (error) {
      set((state) => ({
        sessions: patchSession(state.sessions, id, {
          status: "error",
          errorMessage: String(error),
        }),
      }));
    }
  },

  closeSession: (id) => {
    terminalManager.dispose(id);
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeSessionId =
        state.activeSessionId === id
          ? (sessions[sessions.length - 1]?.id ?? null)
          : state.activeSessionId;
      return { sessions, activeSessionId };
    });
  },

  setActiveSession: (id) => {
    if (get().activeSessionId !== id) {
      useUiStore.getState().setTerminalSearchOpen(false);
    }
    set({ activeSessionId: id });
  },
}));
