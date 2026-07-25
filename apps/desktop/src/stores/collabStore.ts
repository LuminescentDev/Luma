import { create } from "zustand";
import {
  collabAuthStatus,
  parseCollaborationError,
  type CollabAuthStatus,
} from "../lib/collab";
import {
  getCollabState,
  getCollabStates,
  setCollabObserver,
  type CollabRuntimeState,
} from "../features/collaboration/collabClient";

/*
 * React-facing collaboration metadata: authentication status plus a mirror of
 * the non-React collab client's runtime state (connection status, room, roles,
 * presence, control lease). Terminal bytes never live here — they flow entirely
 * inside collabClient ↔ terminalManager. No secrets are held in this store.
 */

type CollabStoreState = {
  auth: CollabAuthStatus | null;
  authLoading: boolean;
  authError: string | null;
  runtime: CollabRuntimeState;
  runtimes: CollabRuntimeState[];
  wired: boolean;

  /** Wire the client → store observer once (no network). Safe to call on launch. */
  wire: () => void;
  /** Wire the observer and load the current auth status (network). */
  hydrate: () => Promise<void>;
  refreshAuthStatus: () => Promise<void>;
};

export const useCollabStore = create<CollabStoreState>((set, get) => ({
  auth: null,
  authLoading: false,
  authError: null,
  runtime: getCollabState(),
  runtimes: getCollabStates(),
  wired: false,

  wire: () => {
    if (get().wired) return;
    setCollabObserver((runtimes) => {
      const runtime = runtimes.find((candidate) => candidate.mode === "viewing")
        ?? runtimes[0]
        ?? getCollabState();
      set({ runtime, runtimes });
    });
    set({ wired: true, runtime: getCollabState(), runtimes: getCollabStates() });
  },

  hydrate: async () => {
    get().wire();
    await get().refreshAuthStatus();
  },

  refreshAuthStatus: async () => {
    set({ authLoading: true, authError: null });
    try {
      const auth = await collabAuthStatus();
      set({ auth, authLoading: false });
    } catch (error) {
      set({
        authLoading: false,
        authError: parseCollaborationError(error).message,
      });
    }
  },
}));
