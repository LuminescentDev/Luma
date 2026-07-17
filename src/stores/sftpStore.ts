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
  sftpUpload,
  type SftpEntry,
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

export type TransferRecord = {
  transferId: string;
  kind: TransferKind;
  name: string;
  localPath: string;
  remotePath: string;
  sessionId: string;
  /** Directory whose listing to refresh when the transfer completes. */
  targetDir: string;
  transferred: number;
  total: number | null;
  state: TransferState;
  errorMessage: string | null;
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

export const useSftpStore = create<SftpState>((set, get) => {
  /** Apply a streamed progress event to the matching (or a stub) record. */
  function applyProgress(progress: TransferProgress) {
    set((state) => {
      const now = Date.now();
      let touched: TransferRecord | null = null;
      let found = false;
      const transfers = state.transfers.map((record) => {
        if (record.transferId !== progress.transferId) return record;
        found = true;
        const elapsed = (now - record.lastTickAt) / 1000;
        const delta = progress.transferred - record.lastTickBytes;
        const rate =
          elapsed > 0 && delta > 0 ? delta / elapsed : record.rate;
        touched = {
          ...record,
          transferred: progress.transferred,
          total: progress.total ?? record.total,
          state: progress.state,
          errorMessage: progress.errorMessage,
          lastTickAt: now,
          lastTickBytes: progress.transferred,
          rate,
        };
        return touched;
      });
      if (!found) {
        // Progress arrived before the invoke resolved: create a stub whose
        // metadata is filled in by registerTransfer once the id is known.
        touched = {
          transferId: progress.transferId,
          kind: "up",
          name: "",
          localPath: "",
          remotePath: "",
          sessionId: "",
          targetDir: "",
          transferred: progress.transferred,
          total: progress.total,
          state: progress.state,
          errorMessage: progress.errorMessage,
          startedAt: now,
          lastTickAt: now,
          lastTickBytes: progress.transferred,
          rate: 0,
        };
        return { transfers: [...transfers, touched] };
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

  /** Merge full metadata into a record once the transferId is known. */
  function registerTransfer(transferId: string, meta: TransferMeta) {
    set((state) => {
      const existing = state.transfers.find((t) => t.transferId === transferId);
      if (existing) {
        return {
          transfers: state.transfers.map((record) =>
            record.transferId === transferId
              ? { ...record, ...meta, transferId }
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

  /** Add a synthetic failed row when the invoke itself rejects (pre-start). */
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
      for (const file of files) {
        if (file.kind === "dir") continue; // directory transfer out of scope for v1
        void startTransfer({
          kind: "up",
          name: file.name,
          localPath: file.path,
          remotePath: remoteJoin(remoteDir, file.name),
          sessionId,
          targetDir: remoteDir,
        });
      }
    },

    download: (sessionId, files, localDir, localSeparator) => {
      for (const file of files) {
        if (file.kind === "dir") continue;
        void startTransfer({
          kind: "down",
          name: file.name,
          localPath: joinPath(localDir, file.name, localSeparator),
          remotePath: file.path,
          sessionId,
          targetDir: localDir,
        });
      }
    },

    cancelTransfer: (transferId) => {
      void sftpCancel(transferId).catch(() => {});
    },

    retryTransfer: (transferId) => {
      const record = get().transfers.find((t) => t.transferId === transferId);
      if (!record) return;
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
      });
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
