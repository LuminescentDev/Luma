import { create } from "zustand";
import {
  listTunnels,
  startTunnel,
  stopTunnel,
  type PortForward,
} from "../lib/portForwards";
import { parseLumaError } from "../lib/hosts";

/*
 * Tracks running SSH tunnels started from the UI. The backend owns the actual
 * processes (and kills them on app exit); this store mirrors their state so
 * host panels and the title bar can show status and stop them independently.
 */

export type TunnelStatus = "running" | "stopped" | "error";

export type TunnelEntry = {
  tunnelId: string;
  portForwardId: string;
  hostId: string;
  status: TunnelStatus;
  errorMessage?: string;
};

type TunnelState = {
  /** Live tunnels keyed by tunnelId. */
  tunnels: Record<string, TunnelEntry>;
  /** Port-forward ids with an in-flight start request. */
  pending: Record<string, boolean>;
  /** Last start failure per port-forward id (pre-connect errors). */
  startErrors: Record<string, string>;
  start: (portForward: PortForward) => Promise<void>;
  stop: (tunnelId: string) => Promise<void>;
  clearError: (portForwardId: string) => void;
  hydrate: () => Promise<void>;
};

export const useTunnelStore = create<TunnelState>((set) => ({
  tunnels: {},
  pending: {},
  startErrors: {},

  start: async (portForward) => {
    set((state) => ({
      pending: { ...state.pending, [portForward.id]: true },
      startErrors: omit(state.startErrors, portForward.id),
    }));
    try {
      const { tunnelId } = await startTunnel(portForward.id, (exit) => {
        set((state) => {
          const entry = state.tunnels[tunnelId];
          if (!entry) return {};
          const status: TunnelStatus = exit.errorCategory ? "error" : "stopped";
          return {
            tunnels: {
              ...state.tunnels,
              [tunnelId]: {
                ...entry,
                status,
                errorMessage:
                  exit.errorMessage ?? exit.errorCategory ?? undefined,
              },
            },
          };
        });
      });
      set((state) => ({
        pending: omit(state.pending, portForward.id),
        tunnels: {
          ...state.tunnels,
          [tunnelId]: {
            tunnelId,
            portForwardId: portForward.id,
            hostId: portForward.hostId,
            status: "running",
          },
        },
      }));
    } catch (error) {
      const { message } = parseLumaError(error);
      set((state) => ({
        pending: omit(state.pending, portForward.id),
        startErrors: { ...state.startErrors, [portForward.id]: message },
      }));
    }
  },

  stop: async (tunnelId) => {
    await stopTunnel(tunnelId).catch(() => {});
    set((state) => ({ tunnels: omit(state.tunnels, tunnelId) }));
  },

  clearError: (portForwardId) =>
    set((state) => ({ startErrors: omit(state.startErrors, portForwardId) })),

  hydrate: async () => {
    try {
      const infos = await listTunnels();
      const tunnels: Record<string, TunnelEntry> = {};
      for (const info of infos) {
        tunnels[info.tunnelId] = {
          tunnelId: info.tunnelId,
          portForwardId: info.portForwardId,
          hostId: info.hostId,
          status: info.status === "running" ? "running" : "stopped",
        };
      }
      set({ tunnels });
    } catch {
      // Non-fatal: the panel simply starts with no known tunnels.
    }
  },
}));

function omit<T extends Record<string, unknown>>(record: T, key: string): T {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** Count of tunnels currently in the running state. */
export function selectRunningCount(state: TunnelState): number {
  return Object.values(state.tunnels).filter((t) => t.status === "running")
    .length;
}
