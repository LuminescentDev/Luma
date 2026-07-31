import { create } from "zustand";
import { fetchServerStats, type ServerStatsSnapshot } from "../lib/serverStats";
import { parseLumaError } from "../lib/hosts";
import {
  summarizeFleetHealth,
  type FleetHealth,
} from "../features/fleet/fleetHealth";

export type FleetEntry = {
  status: "checking" | "online" | "offline";
  snapshot: ServerStatsSnapshot | null;
  health: FleetHealth | null;
  latencyMs: number | null;
  error: string | null;
  checkedAtMs: number | null;
};

type FleetHost = { id: string };

type FleetState = {
  entries: Record<string, FleetEntry>;
  refreshing: boolean;
  lastRefreshedAtMs: number | null;
  refresh: (hosts: FleetHost[]) => Promise<void>;
};

const MAX_CONCURRENT_FETCHES = 4;
let refreshGeneration = 0;

export const useFleetStore = create<FleetState>((set, get) => ({
  entries: {},
  refreshing: false,
  lastRefreshedAtMs: null,
  refresh: async (hosts) => {
    const generation = ++refreshGeneration;
    const hostIds = new Set(hosts.map((host) => host.id));
    set((state) => ({
      refreshing: true,
      entries: Object.fromEntries(
        hosts.map((host) => [
          host.id,
          {
            ...(state.entries[host.id] ?? emptyEntry()),
            status: "checking" as const,
            error: null,
          },
        ]),
      ),
    }));

    let nextIndex = 0;
    const worker = async () => {
      while (generation === refreshGeneration) {
        const host = hosts[nextIndex++];
        if (!host) return;
        const startedAt = Date.now();
        try {
          const snapshot = await fetchServerStats(host.id);
          if (generation !== refreshGeneration) return;
          set((state) => ({
            entries: {
              ...state.entries,
              [host.id]: {
                status: "online",
                snapshot,
                health: summarizeFleetHealth(snapshot),
                latencyMs: Math.max(0, Date.now() - startedAt),
                error: null,
                checkedAtMs: Date.now(),
              },
            },
          }));
        } catch (error) {
          if (generation !== refreshGeneration) return;
          const parsed = parseLumaError(error);
          set((state) => ({
            entries: {
              ...state.entries,
              [host.id]: {
                ...(state.entries[host.id] ?? emptyEntry()),
                status: "offline",
                latencyMs: null,
                error: parsed.message,
                checkedAtMs: Date.now(),
              },
            },
          }));
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_FETCHES, hosts.length) },
        () => worker(),
      ),
    );
    if (generation === refreshGeneration) {
      // Favorites may have changed while the request was in flight.
      const entries = Object.fromEntries(
        Object.entries(get().entries).filter(([id]) => hostIds.has(id)),
      );
      set({ entries, refreshing: false, lastRefreshedAtMs: Date.now() });
    }
  },
}));

function emptyEntry(): FleetEntry {
  return {
    status: "checking",
    snapshot: null,
    health: null,
    latencyMs: null,
    error: null,
    checkedAtMs: null,
  };
}

