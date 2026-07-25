import { create } from "zustand";
import {
  snippetRunCancel,
  snippetRunHosts,
  type SnippetRunEvent,
} from "../lib/snippets";
import { parseLumaError } from "../lib/hosts";

/*
 * Multi-host snippet runner state. Reduces the per-host `SnippetRunEvent` stream
 * (see lib/snippets) into per-host status + captured output, keyed strictly by
 * hostId so output can never mix between hosts. One run is tracked at a time (the
 * dialog flow); `applyEvent` ignores events for any other runId.
 *
 * Nothing here touches terminalManager or terminal bytes — these are backend
 * exec tasks streamed over a Channel.
 */

export type HostRunStatus =
  | "pending"
  | "running"
  | "ok"
  | "failed"
  | "cancelled"
  | "unsupported";

export type HostRunState = {
  hostId: string;
  status: HostRunStatus;
  /** Captured stdout, tail-capped to DISPLAY_CAP_BYTES. */
  stdout: string;
  /** Captured stderr (shown visually distinct), tail-capped separately. */
  stderr: string;
  exitCode: number | null;
  errorCategory: string | null;
  errorMessage: string | null;
};

/** Client-side displayed-buffer cap per host/stream (~200 KB tail). The backend
 * already caps output at 1 MiB/host; this bounds what the UI retains. */
export const DISPLAY_CAP_BYTES = 200 * 1024;

/** The message the backend uses for a cancelled host (failed/connection-lost). */
const CANCELLED_MESSAGE = "Snippet run cancelled";

function capTail(existing: string, chunk: string): string {
  const combined = existing + chunk;
  return combined.length > DISPLAY_CAP_BYTES
    ? combined.slice(combined.length - DISPLAY_CAP_BYTES)
    : combined;
}

/** Classify a `failed` event into a terminal host status. */
function failedStatus(event: SnippetRunEvent): HostRunStatus {
  if (event.errorCategory === "unsupported") return "unsupported";
  if (event.errorMessage === CANCELLED_MESSAGE) return "cancelled";
  return "failed";
}

/** Pure reducer: apply one event to a per-host map. Exported for tests. Events
 * for hosts not in the map are ignored (defensive; the map is seeded on start). */
export function reduceEvent(
  hosts: Record<string, HostRunState>,
  event: SnippetRunEvent,
): Record<string, HostRunState> {
  const current = hosts[event.hostId];
  if (!current) return hosts;
  let next: HostRunState;
  switch (event.kind) {
    case "started":
      next = { ...current, status: "running" };
      break;
    case "stdout":
      next = { ...current, stdout: capTail(current.stdout, event.data ?? "") };
      break;
    case "stderr":
      next = { ...current, stderr: capTail(current.stderr, event.data ?? "") };
      break;
    case "finished":
      next = {
        ...current,
        status: event.exitCode && event.exitCode !== 0 ? "failed" : "ok",
        exitCode: event.exitCode ?? null,
      };
      break;
    case "failed":
      next = {
        ...current,
        status: failedStatus(event),
        errorCategory: event.errorCategory ?? null,
        errorMessage: event.errorMessage ?? null,
      };
      break;
    default:
      return hosts;
  }
  return { ...hosts, [event.hostId]: next };
}

function seedHosts(hostIds: string[]): Record<string, HostRunState> {
  const hosts: Record<string, HostRunState> = {};
  for (const hostId of hostIds) {
    hosts[hostId] = {
      hostId,
      status: "pending",
      stdout: "",
      stderr: "",
      exitCode: null,
      errorCategory: null,
      errorMessage: null,
    };
  }
  return hosts;
}

type SnippetHostRunState = {
  /** Launch request set when the user chooses "Run on multiple hosts…"; drives
   * the dialog open state. Null when the dialog is closed. */
  request: { command: string; snippetName: string } | null;

  /** Active run id (null before start / after reset). */
  runId: string | null;
  /** The command that is actually running (already rendered). */
  command: string;
  /** Ordered host ids for the current run. */
  hostIds: string[];
  /** Per-host reduced state, keyed by hostId. */
  hosts: Record<string, HostRunState>;
  /** True while at least one host has not reached a terminal state. */
  running: boolean;
  /** A launch error (e.g. the invoke was rejected before any host started). */
  launchError: string | null;

  /** Open the dialog with a rendered command (variables already substituted). */
  open: (command: string, snippetName: string) => void;
  /** Close the dialog and clear any finished run. */
  close: () => void;

  /** Start a run on the given hosts. Resets prior results. */
  start: (hostIds: string[], timeoutSecs?: number) => Promise<void>;
  /** Cancel the active run (best-effort). */
  cancel: () => void;
  /** Re-run only the hosts that failed / were cancelled / are unsupported. */
  rerunFailed: (timeoutSecs?: number) => Promise<void>;
  /** Apply a streamed event to the current run (ignores other runIds). */
  applyEvent: (event: SnippetRunEvent) => void;
  /** Clear the current run's results (keeps the dialog request). */
  reset: () => void;
};

/** Whether every host in the map has reached a terminal state. */
function allDone(hosts: Record<string, HostRunState>): boolean {
  return Object.values(hosts).every(
    (h) => h.status !== "pending" && h.status !== "running",
  );
}

export const useSnippetHostRunStore = create<SnippetHostRunState>((set, get) => ({
  request: null,
  runId: null,
  command: "",
  hostIds: [],
  hosts: {},
  running: false,
  launchError: null,

  open: (command, snippetName) => set({ request: { command, snippetName } }),

  close: () =>
    set({
      request: null,
      runId: null,
      command: "",
      hostIds: [],
      hosts: {},
      running: false,
      launchError: null,
    }),

  start: async (hostIds, timeoutSecs) => {
    const command = get().request?.command ?? get().command;
    if (!command || hostIds.length === 0) return;
    set({
      command,
      hostIds,
      hosts: seedHosts(hostIds),
      running: true,
      runId: null,
      launchError: null,
    });
    try {
      const handle = await snippetRunHosts(
        command,
        hostIds,
        (event) => get().applyEvent(event),
        timeoutSecs,
      );
      set({ runId: handle.runId });
    } catch (error) {
      const { message } = parseLumaError(error);
      set((state) => ({
        running: false,
        launchError: message,
        hosts: Object.fromEntries(
          Object.entries(state.hosts).map(([id, host]) => [
            id,
            { ...host, status: "failed" as HostRunStatus, errorMessage: message },
          ]),
        ),
      }));
    }
  },

  cancel: () => {
    const runId = get().runId;
    if (runId) void snippetRunCancel(runId).catch(() => {});
  },

  rerunFailed: async (timeoutSecs) => {
    const failedIds = get()
      .hostIds.filter((id) => {
        const status = get().hosts[id]?.status;
        return status === "failed" || status === "cancelled" || status === "unsupported";
      });
    if (failedIds.length === 0) return;
    await get().start(failedIds, timeoutSecs);
  },

  applyEvent: (event) => {
    const { runId } = get();
    // Ignore late events from a superseded run once a new runId is known.
    if (runId && event.runId !== runId) return;
    set((state) => {
      const hosts = reduceEvent(state.hosts, event);
      return { hosts, running: !allDone(hosts) };
    });
  },

  reset: () =>
    set({
      runId: null,
      command: "",
      hostIds: [],
      hosts: {},
      running: false,
      launchError: null,
    }),
}));
