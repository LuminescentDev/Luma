import { create } from "zustand";
import { closeServerStats } from "../lib/serverStats";

/*
 * Which host the server stats dashboard is showing. Snapshot data itself is
 * fetched by the screen (manual refresh + optional foreground interval) and
 * never lives here — this store only holds the selection so per-host actions
 * elsewhere in the app can point the dashboard at a host before opening it.
 */
type ServerStatsState = {
  hostId: string | null;
  hostName: string | null;
  /** Point the dashboard at a host (the screen fetches on mount). */
  select: (host: { id: string; name: string }) => void;
  /** Clear the selection and close the backend's cached SSH connection. */
  clear: () => void;
};

export const useServerStatsStore = create<ServerStatsState>((set, get) => ({
  hostId: null,
  hostName: null,
  select: (host) => {
    const previous = get().hostId;
    if (previous && previous !== host.id) {
      void closeServerStats(previous).catch(() => undefined);
    }
    set({ hostId: host.id, hostName: host.name });
  },
  clear: () => {
    const previous = get().hostId;
    if (previous) {
      void closeServerStats(previous).catch(() => undefined);
    }
    set({ hostId: null, hostName: null });
  },
}));
