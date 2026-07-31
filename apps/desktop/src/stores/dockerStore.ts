import { create } from "zustand";
import {
  dockerAction,
  dockerInspect,
  dockerList,
  dockerLogs,
  dockerStats,
  type DockerActionName,
  type DockerContainer,
  type DockerInspect,
  type DockerList,
  type DockerStat,
} from "../lib/docker";
import { parseLumaError } from "../lib/hosts";

/*
 * Docker state for one host at a time (the open dialog), like the web-preview,
 * multiplexer and repo stores.
 *
 * Three things are deliberately separate from the listing:
 *  - stats, because `docker stats --no-stream` samples twice and takes seconds,
 *    so it is fetched only when the user asks for it;
 *  - logs and inspect, which are per-container drill-downs;
 *  - MUTATIONS, which are gated behind `pending`. `requestAction` only records
 *    what was asked for — nothing reaches the host until `confirmAction` runs.
 *    That split is what makes the confirmation dialog load-bearing rather than
 *    decorative, and it is what the store tests assert.
 */

export type PendingAction = {
  container: DockerContainer;
  action: DockerActionName;
};

export type LogsView = {
  container: string;
  tail: number;
  loading: boolean;
  error: string | null;
  lines: string;
  truncated: boolean;
};

export type InspectView = {
  container: string;
  loading: boolean;
  error: string | null;
  data: DockerInspect | null;
};

type DockerStoreState = {
  /** Host the held listing belongs to; null when the dialog is closed. */
  hostId: string | null;
  hostLabel: string | null;
  list: DockerList | null;
  loading: boolean;
  error: string | null;

  stats: DockerStat[];
  statsLoaded: boolean;
  statsLoading: boolean;
  statsError: string | null;

  logs: LogsView | null;
  inspect: InspectView | null;

  /** The mutation awaiting confirmation. Nothing is sent while this is set. */
  pending: PendingAction | null;
  /** A confirmed mutation is in flight. */
  actionBusy: boolean;
  actionError: string | null;

  open: (hostId: string, hostLabel?: string) => void;
  refresh: () => Promise<void>;
  loadStats: () => Promise<void>;
  openLogs: (container: string, tail: number) => Promise<void>;
  closeLogs: () => void;
  openInspect: (container: string) => Promise<void>;
  closeInspect: () => void;
  requestAction: (container: DockerContainer, action: DockerActionName) => void;
  cancelAction: () => void;
  confirmAction: () => Promise<void>;
  reset: () => void;
};

const EMPTY = {
  list: null,
  loading: false,
  error: null,
  stats: [] as DockerStat[],
  statsLoaded: false,
  statsLoading: false,
  statsError: null,
  logs: null,
  inspect: null,
  pending: null,
  actionBusy: false,
  actionError: null,
};

export const useDockerStore = create<DockerStoreState>((set, get) => ({
  hostId: null,
  hostLabel: null,
  ...EMPTY,

  open: (hostId, hostLabel) =>
    set({ hostId, hostLabel: hostLabel ?? null, ...EMPTY }),

  refresh: async () => {
    const hostId = get().hostId;
    if (!hostId) return;
    // Stats and drill-downs describe containers that are about to be re-read.
    set({
      loading: true,
      error: null,
      stats: [],
      statsLoaded: false,
      statsError: null,
      actionError: null,
    });
    try {
      const list = await dockerList(hostId);
      // A dialog opened on another host may have superseded this fetch.
      if (get().hostId !== hostId) return;
      set({ list, loading: false });
    } catch (error) {
      if (get().hostId !== hostId) return;
      set({ loading: false, error: parseLumaError(error).message, list: null });
    }
  },

  loadStats: async () => {
    const hostId = get().hostId;
    if (!hostId || get().statsLoading) return;
    set({ statsLoading: true, statsError: null });
    try {
      const stats = await dockerStats(hostId);
      if (get().hostId !== hostId) return;
      set({ stats, statsLoaded: true, statsLoading: false });
    } catch (error) {
      if (get().hostId !== hostId) return;
      set({ statsLoading: false, statsError: parseLumaError(error).message });
    }
  },

  openLogs: async (container, tail) => {
    const hostId = get().hostId;
    if (!hostId) return;
    set({
      logs: {
        container,
        tail,
        loading: true,
        error: null,
        lines: "",
        truncated: false,
      },
    });
    try {
      const result = await dockerLogs(hostId, container, tail);
      const current = get().logs;
      // Superseded by a different container, a different tail size, or a close.
      if (
        get().hostId !== hostId ||
        current?.container !== container ||
        current.tail !== tail
      ) {
        return;
      }
      set({
        logs: {
          container,
          tail,
          loading: false,
          error: null,
          lines: result.lines,
          truncated: result.truncated,
        },
      });
    } catch (error) {
      const current = get().logs;
      if (
        get().hostId !== hostId ||
        current?.container !== container ||
        current.tail !== tail
      ) {
        return;
      }
      set({
        logs: {
          container,
          tail,
          loading: false,
          error: parseLumaError(error).message,
          lines: "",
          truncated: false,
        },
      });
    }
  },

  closeLogs: () => set({ logs: null }),

  openInspect: async (container) => {
    const hostId = get().hostId;
    if (!hostId) return;
    set({ inspect: { container, loading: true, error: null, data: null } });
    try {
      const data = await dockerInspect(hostId, container);
      if (get().hostId !== hostId || get().inspect?.container !== container) {
        return;
      }
      set({ inspect: { container, loading: false, error: null, data } });
    } catch (error) {
      if (get().hostId !== hostId || get().inspect?.container !== container) {
        return;
      }
      set({
        inspect: {
          container,
          loading: false,
          error: parseLumaError(error).message,
          data: null,
        },
      });
    }
  },

  closeInspect: () => set({ inspect: null }),

  // Records the intent ONLY. No invoke happens here — the dialog shows the
  // container and host name, and `confirmAction` is the sole path to the host.
  requestAction: (container, action) =>
    set({ pending: { container, action }, actionError: null }),

  cancelAction: () => set({ pending: null }),

  confirmAction: async () => {
    const { hostId, pending, actionBusy } = get();
    if (!hostId || !pending || actionBusy) return;
    set({ actionBusy: true, actionError: null });
    try {
      const result = await dockerAction(
        hostId,
        pending.container.name,
        pending.action,
      );
      if (get().hostId !== hostId) return;
      if (!result.success) {
        set({
          actionBusy: false,
          pending: null,
          // Docker's own one-line reason beats a generic failure message.
          actionError:
            result.output.length > 0
              ? result.output
              : `docker ${pending.action} exited with ${result.exitCode}`,
        });
        return;
      }
      set({ actionBusy: false, pending: null });
      // The state badge and status text are now stale by definition.
      await get().refresh();
    } catch (error) {
      if (get().hostId !== hostId) return;
      set({
        actionBusy: false,
        pending: null,
        actionError: parseLumaError(error).message,
      });
    }
  },

  reset: () => set({ hostId: null, hostLabel: null, ...EMPTY }),
}));
