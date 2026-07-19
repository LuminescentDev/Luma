import { create } from "zustand";
import { parseLumaError } from "../lib/hosts";
import { queryClient } from "../lib/queryClient";
import {
  inferSeparator,
  joinPath,
  remoteJoin,
  sftpCancel,
  sftpConnect,
  sftpDisconnect,
  sftpDownload,
  sftpRetry,
  sftpUpload,
  type SftpEntry,
  type TransferAggregate,
  type TransferProgress,
  type TransferState,
} from "../lib/sftp";

/*
 * SFTP runtime state. Directory listings live in TanStack Query (keys
 * ["sftp-list", sessionId, path] and ["local-list", path]); this store only
 * holds session metadata, the current paths, and the transfer queue.
 *
 * v1 shows ONE active SFTP session at a time — the shape supports many sessions
 * (keyed by sftpSessionId) but the UI only exposes a single active one and a
 * host picker to swap. Terminal sessions are entirely separate: transfers are
 * backend tasks and nothing here touches terminalManager.
 */

export type SftpSessionStatus = "connecting" | "connected" | "error";

export type SftpSession = {
  sftpSessionId: string;
  hostId: string;
  status: SftpSessionStatus;
  /** Current remote directory (canonical). */
  remotePath: string;
  errorCategory: string | null;
  errorMessage: string | null;
};

export type TransferKind = "up" | "down";

/** A per-entry outcome recorded from a directory job's "entry" events: a skipped
 * symlink or a failed individual file. `path` is relative to the transfer root. */
export type TransferEntryOutcome = {
  path: string;
  state: "skipped" | "failed";
  errorMessage: string | null;
};

export type TransferRecord = {
  transferId: string;
  kind: TransferKind;
  name: string;
  localPath: string;
  remotePath: string;
  sessionId: string;
  /** True when this transfer's source is a directory (aggregate progress). */
  isDirectory: boolean;
  /** Directory whose listing to refresh when the transfer completes. */
  targetDir: string;
  transferred: number;
  total: number | null;
  state: TransferState;
  errorMessage: string | null;
  /** Whole-job snapshot for directory transfers (null for single files). */
  aggregate: TransferAggregate | null;
  /** Skipped / failed per-entry outcomes from a directory job's entry events. */
  entries: TransferEntryOutcome[];
  /** Byte offset a resumed transfer started at (from a `resumedFrom` progress
   * event), or null when it started from the beginning. Drives the "resumed" tag. */
  resumedFrom: number | null;
  startedAt: number;
  /** For a simple live speed readout (bytes/sec), updated on each event. */
  lastTickAt: number;
  lastTickBytes: number;
  rate: number;
};

/** Metadata for one queued transfer, known before the invoke resolves. */
type TransferMeta = {
  kind: TransferKind;
  name: string;
  localPath: string;
  remotePath: string;
  sessionId: string;
  targetDir: string;
  isDirectory: boolean;
};

type SftpState = {
  sessions: Record<string, SftpSession>;
  /** The session currently shown in the dual-pane browser. */
  activeSessionId: string | null;
  /** In-flight connect for the host picker (hostId being connected). */
  connectingHostId: string | null;
  connectError: { category: string; message: string } | null;

  /** Current local directory (canonical); null until the first listing. */
  localPath: string | null;

  /** Ordered transfer queue; finished rows persist until cleared. */
  transfers: TransferRecord[];

  connect: (hostId: string) => Promise<void>;
  disconnect: (sessionId: string) => Promise<void>;
  reconnect: (sessionId: string) => Promise<void>;
  clearConnectError: () => void;

  setRemotePath: (sessionId: string, path: string) => void;
  setLocalPath: (path: string) => void;
  /** Mark a session errored after a backend-initiated failure (e.g. sftp-failed). */
  markSessionError: (sessionId: string, category: string, message: string) => void;

  /** Upload the given local files into a remote directory. */
  upload: (sessionId: string, files: SftpEntry[], remoteDir: string) => void;
  /** Download the given remote files into a local directory. */
  download: (
    sessionId: string,
    files: SftpEntry[],
    localDir: string,
    localSeparator: "/" | "\\",
  ) => void;

  cancelTransfer: (transferId: string) => void;
  retryTransfer: (transferId: string) => void;
  clearFinished: () => void;
};

function invalidateTarget(record: TransferRecord) {
  const key =
    record.kind === "up"
      ? ["sftp-list", record.sessionId, record.targetDir]
      : ["local-list", record.targetDir];
  void queryClient.invalidateQueries({ queryKey: key });
}

const isTerminal = (state: TransferState) => state !== "running";

/** Whole-job byte total for a record, preferring the aggregate snapshot so
 * directory rows show overall (not current-file) progress. */
function overallBytes(
  record: Pick<TransferRecord, "transferred" | "aggregate">,
): number {
  return record.aggregate ? record.aggregate.bytesDone : record.transferred;
}

export const useSftpStore = create<SftpState>((set, get) => {
  /**
   * Apply a streamed progress event to the matching (or a stub) record.
   *
   * Single-file jobs emit only the original five fields (progressKind absent)
   * and are handled exactly as before. Directory jobs additionally emit:
   *  - "file": current-file progress + an aggregate snapshot (drives the row).
   *  - "aggregate": overall progress (transferred=bytesDone, total=totalBytes).
   *  - "entry": a skipped symlink or failed entry — recorded in `entries`
   *    WITHOUT touching the row's running state or byte counters.
   */
  function applyProgress(progress: TransferProgress) {
    // Per-entry outcomes are collected into the row's detail list; they never
    // move the aggregate progress or flip the job's own state.
    if (progress.progressKind === "entry") {
      set((state) => ({
        transfers: state.transfers.map((record) =>
          record.transferId === progress.transferId
            ? {
                ...record,
                isDirectory: true,
                entries: [
                  ...record.entries,
                  {
                    path: progress.filePath ?? "",
                    state: progress.state === "skipped" ? "skipped" : "failed",
                    errorMessage: progress.errorMessage,
                  },
                ],
              }
            : record,
        ),
      }));
      return;
    }

    const isDirEvent = progress.progressKind !== undefined;

    set((state) => {
      const now = Date.now();
      let found = false;
      const transfers = state.transfers.map((record) => {
        if (record.transferId !== progress.transferId) return record;
        found = true;
        // Directory rows track overall bytes (from the aggregate snapshot or an
        // "aggregate" event); single-file rows track the file's own bytes. An
        // "aggregate" event carries no snapshot object, so fold its byte totals
        // into the retained snapshot to keep the text line and bar in sync.
        let aggregate = progress.aggregate ?? record.aggregate;
        if (progress.progressKind === "aggregate" && aggregate) {
          aggregate = {
            ...aggregate,
            bytesDone: progress.transferred,
            totalBytes: progress.total ?? aggregate.totalBytes,
          };
        }
        const nextBytes =
          progress.progressKind === "aggregate"
            ? progress.transferred
            : aggregate
              ? aggregate.bytesDone
              : progress.transferred;
        const nextTotal =
          progress.progressKind === "aggregate"
            ? (progress.total ?? record.total)
            : aggregate
              ? aggregate.totalBytes
              : (progress.total ?? record.total);
        const prevBytes = overallBytes(record);
        const elapsed = (now - record.lastTickAt) / 1000;
        const delta = nextBytes - prevBytes;
        const rate = elapsed > 0 && delta > 0 ? delta / elapsed : record.rate;
        return {
          ...record,
          isDirectory: record.isDirectory || isDirEvent,
          transferred: nextBytes,
          total: nextTotal,
          state: progress.state,
          errorMessage: progress.errorMessage,
          aggregate,
          // A resumed transfer reports its starting offset once; keep it sticky.
          resumedFrom: progress.resumedFrom ?? record.resumedFrom,
          lastTickAt: now,
          lastTickBytes: nextBytes,
          rate,
        };
      });
      if (!found) {
        // Progress arrived before the invoke resolved: create a stub whose
        // metadata is filled in by registerTransfer once the id is known.
        const aggregate = progress.aggregate ?? null;
        const stub: TransferRecord = {
          transferId: progress.transferId,
          kind: "up",
          name: "",
          localPath: "",
          remotePath: "",
          sessionId: "",
          isDirectory: isDirEvent,
          targetDir: "",
          transferred: aggregate ? aggregate.bytesDone : progress.transferred,
          total: aggregate ? aggregate.totalBytes : progress.total,
          state: progress.state,
          errorMessage: progress.errorMessage,
          aggregate,
          entries: [],
          resumedFrom: progress.resumedFrom ?? null,
          startedAt: now,
          lastTickAt: now,
          lastTickBytes: aggregate ? aggregate.bytesDone : progress.transferred,
          rate: 0,
        };
        return { transfers: [...transfers, stub] };
      }
      return { transfers };
    });
    if (isTerminal(progress.state)) {
      const record = get().transfers.find(
        (t) => t.transferId === progress.transferId,
      );
      if (record && record.targetDir) invalidateTarget(record);
    }
  }

  /** Merge full metadata into a record once the transferId is known. `meta`
   * never overwrites the streamed progress fields a stub may already hold. */
  function registerTransfer(transferId: string, meta: TransferMeta) {
    set((state) => {
      const existing = state.transfers.find((t) => t.transferId === transferId);
      if (existing) {
        return {
          transfers: state.transfers.map((record) =>
            record.transferId === transferId
              ? {
                  ...record,
                  ...meta,
                  transferId,
                  // A stub already flagged as a directory (progressKind seen)
                  // stays one even if meta's inference disagrees.
                  isDirectory: record.isDirectory || meta.isDirectory,
                }
              : record,
          ),
        };
      }
      const now = Date.now();
      const record: TransferRecord = {
        transferId,
        ...meta,
        transferred: 0,
        total: null,
        state: "running",
        errorMessage: null,
        aggregate: null,
        entries: [],
        resumedFrom: null,
        startedAt: now,
        lastTickAt: now,
        lastTickBytes: 0,
        rate: 0,
      };
      return { transfers: [...state.transfers, record] };
    });
    const record = get().transfers.find((t) => t.transferId === transferId);
    if (record && isTerminal(record.state) && record.targetDir) {
      invalidateTarget(record);
    }
  }

  /** Add a synthetic failed row when the invoke itself rejects (pre-start).
   * These rows have no backend transfer, so retry re-runs the whole job. */
  function addFailedRecord(meta: TransferMeta, message: string) {
    const now = Date.now();
    set((state) => ({
      transfers: [
        ...state.transfers,
        {
          transferId: `failed-${now}-${Math.random().toString(36).slice(2)}`,
          ...meta,
          transferred: 0,
          total: null,
          state: "failed",
          errorMessage: message,
          aggregate: null,
          entries: [],
          resumedFrom: null,
          startedAt: now,
          lastTickAt: now,
          lastTickBytes: 0,
          rate: 0,
        },
      ],
    }));
  }

  async function startTransfer(meta: TransferMeta) {
    try {
      const handle =
        meta.kind === "up"
          ? await sftpUpload(
              meta.sessionId,
              meta.localPath,
              meta.remotePath,
              applyProgress,
            )
          : await sftpDownload(
              meta.sessionId,
              meta.remotePath,
              meta.localPath,
              applyProgress,
            );
      registerTransfer(handle.transferId, meta);
    } catch (error) {
      const { message } = parseLumaError(error);
      addFailedRecord(meta, message);
    }
  }

  /** Rebind a queue row to the NEW transferId returned by sftp_retry, resetting
   * its progress. Merges into any stub the retry's early progress created. */
  function rebindRetry(oldId: string, newId: string, meta: TransferMeta) {
    set((state) => {
      const now = Date.now();
      const stub = state.transfers.find((t) => t.transferId === newId);
      if (stub) {
        return {
          transfers: state.transfers
            .filter((t) => t.transferId !== oldId)
            .map((record) =>
              record.transferId === newId
                ? {
                    ...record,
                    ...meta,
                    transferId: newId,
                    isDirectory: record.isDirectory || meta.isDirectory,
                  }
                : record,
            ),
        };
      }
      return {
        transfers: state.transfers.map((record) =>
          record.transferId === oldId
            ? {
                ...record,
                ...meta,
                transferId: newId,
                transferred: 0,
                total: null,
                state: "running" as TransferState,
                errorMessage: null,
                aggregate: null,
                entries: [],
                resumedFrom: null,
                startedAt: now,
                lastTickAt: now,
                lastTickBytes: 0,
                rate: 0,
              }
            : record,
        ),
      };
    });
  }

  /** Retry an existing (backend-known) transfer via sftp_retry. Keeps the row
   * on failure with the returned error message. */
  async function retryExisting(record: TransferRecord) {
    const meta: TransferMeta = {
      kind: record.kind,
      name: record.name,
      localPath: record.localPath,
      remotePath: record.remotePath,
      sessionId: record.sessionId,
      targetDir: record.targetDir,
      isDirectory: record.isDirectory,
    };
    try {
      const handle = await sftpRetry(record.transferId, applyProgress);
      rebindRetry(record.transferId, handle.transferId, meta);
    } catch (error) {
      const { message } = parseLumaError(error);
      set((state) => ({
        transfers: state.transfers.map((t) =>
          t.transferId === record.transferId
            ? { ...t, state: "failed" as TransferState, errorMessage: message }
            : t,
        ),
      }));
    }
  }

  return {
    sessions: {},
    activeSessionId: null,
    connectingHostId: null,
    connectError: null,
    localPath: null,
    transfers: [],

    connect: async (hostId) => {
      set({ connectingHostId: hostId, connectError: null });
      try {
        const { sftpSessionId, initialPath } = await sftpConnect(hostId);
        set((state) => ({
          connectingHostId: null,
          activeSessionId: sftpSessionId,
          sessions: {
            ...state.sessions,
            [sftpSessionId]: {
              sftpSessionId,
              hostId,
              status: "connected",
              remotePath: initialPath,
              errorCategory: null,
              errorMessage: null,
            },
          },
        }));
      } catch (error) {
        const parsed = parseLumaError(error);
        set({ connectingHostId: null, connectError: parsed });
      }
    },

    disconnect: async (sessionId) => {
      // Optimistically mark this session's running transfers cancelled — the
      // backend cancels them as it tears down the ssh child.
      set((state) => ({
        transfers: state.transfers.map((record) =>
          record.sessionId === sessionId && record.state === "running"
            ? { ...record, state: "cancelled" as TransferState }
            : record,
        ),
      }));
      await sftpDisconnect(sessionId).catch(() => {});
      set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[sessionId];
        const remaining = Object.keys(sessions);
        return {
          sessions,
          activeSessionId:
            state.activeSessionId === sessionId
              ? (remaining[0] ?? null)
              : state.activeSessionId,
        };
      });
    },

    reconnect: async (sessionId) => {
      const session = get().sessions[sessionId];
      if (!session) return;
      // Drop the dead session, then connect fresh to the same host.
      set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[sessionId];
        return {
          sessions,
          activeSessionId:
            state.activeSessionId === sessionId ? null : state.activeSessionId,
        };
      });
      await get().connect(session.hostId);
    },

    clearConnectError: () => set({ connectError: null }),

    setRemotePath: (sessionId, path) =>
      set((state) => {
        const session = state.sessions[sessionId];
        if (!session) return {};
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...session, remotePath: path },
          },
        };
      }),

    setLocalPath: (path) => set({ localPath: path }),

    markSessionError: (sessionId, category, message) =>
      set((state) => {
        const session = state.sessions[sessionId];
        if (!session) return {};
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...session,
              status: "error",
              errorCategory: category,
              errorMessage: message,
            },
          },
        };
      }),

    upload: (sessionId, files, remoteDir) => {
      // Files AND directories are accepted; the backend recurses directories.
      for (const file of files) {
        void startTransfer({
          kind: "up",
          name: file.name,
          localPath: file.path,
          remotePath: remoteJoin(remoteDir, file.name),
          sessionId,
          targetDir: remoteDir,
          isDirectory: file.kind === "dir",
        });
      }
    },

    download: (sessionId, files, localDir, localSeparator) => {
      for (const file of files) {
        void startTransfer({
          kind: "down",
          name: file.name,
          localPath: joinPath(localDir, file.name, localSeparator),
          remotePath: file.path,
          sessionId,
          targetDir: localDir,
          isDirectory: file.kind === "dir",
        });
      }
    },

    cancelTransfer: (transferId) => {
      void sftpCancel(transferId).catch(() => {});
    },

    retryTransfer: (transferId) => {
      const record = get().transfers.find((t) => t.transferId === transferId);
      if (!record) return;
      // Rows from a pre-start invoke rejection have no backend transfer, so the
      // whole job is re-run. Rows the backend knows retry only their failed /
      // incomplete entries via sftp_retry (which mints a new transferId).
      if (transferId.startsWith("failed-")) {
        set((state) => ({
          transfers: state.transfers.filter((t) => t.transferId !== transferId),
        }));
        void startTransfer({
          kind: record.kind,
          name: record.name,
          localPath: record.localPath,
          remotePath: record.remotePath,
          sessionId: record.sessionId,
          targetDir: record.targetDir,
          isDirectory: record.isDirectory,
        });
        return;
      }
      void retryExisting(record);
    },

    clearFinished: () =>
      set((state) => ({
        transfers: state.transfers.filter((t) => t.state === "running"),
      })),
  };
});

/** Count of transfers currently running (for the title-bar badge). */
export function selectActiveTransferCount(state: SftpState): number {
  return state.transfers.filter((t) => t.state === "running").length;
}

/** True when any transfer for the given session is still running. */
export function selectRunningForSession(
  transfers: TransferRecord[],
  sessionId: string,
): number {
  return transfers.filter(
    (t) => t.sessionId === sessionId && t.state === "running",
  ).length;
}

/** Convenience selector for the active session record. */
export function selectActiveSession(state: SftpState): SftpSession | null {
  return state.activeSessionId
    ? (state.sessions[state.activeSessionId] ?? null)
    : null;
}

/** Derive the local separator from the current local path (defaults to "/"). */
export function localSeparator(localPath: string | null): "/" | "\\" {
  return localPath ? inferSeparator(localPath) : "/";
}
