import { create } from "zustand";
import { parseLumaError } from "../lib/hosts";
import { queryClient } from "../lib/queryClient";
import {
  inferSeparator,
  joinPath,
  remoteJoin,
  sftpCancel,
  sftpConnect,
  sftpCopy,
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
 * holds session metadata, the two browser panes, and the transfer queue.
 *
 * Each pane points at an endpoint independently — this computer, a connected
 * host, or nothing yet — so files move local <-> host in either direction and
 * host -> host. Only one pane may be local at a time (there is no local-to-local
 * transfer), which also lets a single localPath serve whichever pane holds it.
 * Terminal sessions are entirely separate: transfers are backend tasks and
 * nothing here touches terminalManager.
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

export type PaneSide = "left" | "right";

/** What a browser pane is pointed at. */
export type PaneEndpoint =
  | { kind: "none" }
  | { kind: "local" }
  | { kind: "remote"; sessionId: string };

/** An endpoint that can take part in a transfer (a pane that is not empty). */
export type TransferEndpoint = Exclude<PaneEndpoint, { kind: "none" }>;

export const OTHER_SIDE: Record<PaneSide, PaneSide> = {
  left: "right",
  right: "left",
};

export type TransferKind = "up" | "down" | "copy";

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
  /** Source path, in the source endpoint's separator style. */
  sourcePath: string;
  /** Destination path, in the destination endpoint's separator style. */
  destPath: string;
  /** Session the bytes come from; null when the source is this computer. */
  sourceSessionId: string | null;
  /** Session the bytes go to; null when the destination is this computer. */
  destSessionId: string | null;
  /** True when this transfer's source is a directory (aggregate progress). */
  isDirectory: boolean;
  /** Destination directory whose listing to refresh when the transfer completes. */
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
  sourcePath: string;
  destPath: string;
  sourceSessionId: string | null;
  destSessionId: string | null;
  targetDir: string;
  isDirectory: boolean;
};

/** One transfer request covering every file dropped on / sent to a destination. */
export type TransferRequest = {
  source: TransferEndpoint;
  dest: TransferEndpoint;
  files: SftpEntry[];
  /** Destination directory the files land in. */
  destDir: string;
  /** Separator style of `destDir` (always "/" for a remote destination). */
  destSeparator: "/" | "\\";
};

type SideRecord<T> = Record<PaneSide, T>;

type SftpState = {
  sessions: Record<string, SftpSession>;
  /** What each pane is pointed at. */
  panes: SideRecord<PaneEndpoint>;
  /** In-flight connect per pane (hostId being connected). */
  connecting: SideRecord<string | null>;
  connectError: SideRecord<{ category: string; message: string } | null>;
  /** True once a screen has applied its default pane layout. */
  initialized: boolean;
  /** Which pane the single-pane mobile browser is showing. */
  mobileSide: PaneSide;

  /** Current local directory (canonical); null until the first listing. */
  localPath: string | null;

  /** Ordered transfer queue; finished rows persist until cleared. */
  transfers: TransferRecord[];

  /** Apply the default pane layout once. Desktop has a local pane; mobile does
   * not (the local_* commands are not registered there). */
  initPanes: (options: { localAvailable: boolean }) => void;
  connect: (hostId: string, side?: PaneSide) => Promise<void>;
  setMobileSide: (side: PaneSide) => void;
  /** Point a pane at this computer (rejected when the other pane is local). */
  setPaneLocal: (side: PaneSide) => void;
  /** Disconnect / empty a pane, closing its session if the other pane is not
   * also using it. */
  clearPane: (side: PaneSide) => Promise<void>;
  reconnect: (sessionId: string) => Promise<void>;
  clearConnectError: (side: PaneSide) => void;

  setRemotePath: (sessionId: string, path: string) => void;
  setLocalPath: (path: string) => void;
  /** Mark a session errored after a backend-initiated failure (e.g. sftp-failed). */
  markSessionError: (sessionId: string, category: string, message: string) => void;

  /** Queue a transfer of the given files between two endpoints. */
  transfer: (request: TransferRequest) => void;

  cancelTransfer: (transferId: string) => void;
  retryTransfer: (transferId: string) => void;
  clearFinished: () => void;
};

function invalidateTarget(record: TransferRecord) {
  const key = record.destSessionId
    ? ["sftp-list", record.destSessionId, record.targetDir]
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

/** True when the transfer reads from or writes to the given session. */
function touchesSession(record: TransferRecord, sessionId: string): boolean {
  return (
    record.sourceSessionId === sessionId || record.destSessionId === sessionId
  );
}

/** The pane holding a session, if any. */
function sideForSession(
  panes: SideRecord<PaneEndpoint>,
  sessionId: string,
): PaneSide | null {
  if (panes.left.kind === "remote" && panes.left.sessionId === sessionId) {
    return "left";
  }
  if (panes.right.kind === "remote" && panes.right.sessionId === sessionId) {
    return "right";
  }
  return null;
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
          sourcePath: "",
          destPath: "",
          sourceSessionId: null,
          destSessionId: null,
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

  /** Dispatch to the invoke matching the endpoint pair. */
  function invokeTransfer(meta: TransferMeta) {
    if (meta.kind === "up") {
      return sftpUpload(
        meta.destSessionId as string,
        meta.sourcePath,
        meta.destPath,
        applyProgress,
      );
    }
    if (meta.kind === "down") {
      return sftpDownload(
        meta.sourceSessionId as string,
        meta.sourcePath,
        meta.destPath,
        applyProgress,
      );
    }
    return sftpCopy(
      meta.sourceSessionId as string,
      meta.sourcePath,
      meta.destSessionId as string,
      meta.destPath,
      applyProgress,
    );
  }

  async function startTransfer(meta: TransferMeta) {
    try {
      const handle = await invokeTransfer(meta);
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

  /** The metadata needed to re-run or retry an existing row. */
  function metaOf(record: TransferRecord): TransferMeta {
    return {
      kind: record.kind,
      name: record.name,
      sourcePath: record.sourcePath,
      destPath: record.destPath,
      sourceSessionId: record.sourceSessionId,
      destSessionId: record.destSessionId,
      targetDir: record.targetDir,
      isDirectory: record.isDirectory,
    };
  }

  /** Retry an existing (backend-known) transfer via sftp_retry. Keeps the row
   * on failure with the returned error message. */
  async function retryExisting(record: TransferRecord) {
    const meta = metaOf(record);
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

  /** Detach a pane from its endpoint, returning the session that is now unused
   * and should be closed (null when the other pane still holds it). */
  function detachPane(side: PaneSide): string | null {
    const state = get();
    const endpoint = state.panes[side];
    set({ panes: { ...state.panes, [side]: { kind: "none" } } });
    if (endpoint.kind !== "remote") return null;
    const other = state.panes[OTHER_SIDE[side]];
    const stillUsed =
      other.kind === "remote" && other.sessionId === endpoint.sessionId;
    return stillUsed ? null : endpoint.sessionId;
  }

  /** Close a session and drop it from the store, cancelling its transfers. */
  async function closeSession(sessionId: string) {
    // Optimistically mark this session's running transfers cancelled — the
    // backend cancels them as it tears down the ssh child.
    set((state) => ({
      transfers: state.transfers.map((record) =>
        touchesSession(record, sessionId) && record.state === "running"
          ? { ...record, state: "cancelled" as TransferState }
          : record,
      ),
    }));
    await sftpDisconnect(sessionId).catch(() => {});
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { sessions };
    });
  }

  return {
    sessions: {},
    panes: { left: { kind: "none" }, right: { kind: "none" } },
    connecting: { left: null, right: null },
    connectError: { left: null, right: null },
    initialized: false,
    // Matches connect()'s default side, so a connection started elsewhere
    // (e.g. the command palette) lands on the pane mobile is showing.
    mobileSide: "right",
    localPath: null,
    transfers: [],

    initPanes: ({ localAvailable }) => {
      if (get().initialized) return;
      set((state) => ({
        initialized: true,
        panes: localAvailable
          ? { ...state.panes, left: { kind: "local" } }
          : state.panes,
      }));
    },

    connect: async (hostId, side = "right") => {
      set((state) => ({
        connecting: { ...state.connecting, [side]: hostId },
        connectError: { ...state.connectError, [side]: null },
      }));
      try {
        const { sftpSessionId, initialPath } = await sftpConnect(hostId);
        const released = detachPane(side);
        set((state) => ({
          connecting: { ...state.connecting, [side]: null },
          panes: {
            ...state.panes,
            [side]: { kind: "remote", sessionId: sftpSessionId },
          },
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
        if (released) await closeSession(released);
      } catch (error) {
        const parsed = parseLumaError(error);
        set((state) => ({
          connecting: { ...state.connecting, [side]: null },
          connectError: { ...state.connectError, [side]: parsed },
        }));
      }
    },

    setMobileSide: (side) => set({ mobileSide: side }),

    setPaneLocal: (side) => {
      // Only one pane may be local: there is no local-to-local transfer.
      if (get().panes[OTHER_SIDE[side]].kind === "local") return;
      const released = detachPane(side);
      set((state) => ({
        panes: { ...state.panes, [side]: { kind: "local" } },
        connectError: { ...state.connectError, [side]: null },
      }));
      if (released) void closeSession(released);
    },

    clearPane: async (side) => {
      const released = detachPane(side);
      set((state) => ({
        connectError: { ...state.connectError, [side]: null },
      }));
      if (released) await closeSession(released);
    },

    reconnect: async (sessionId) => {
      const session = get().sessions[sessionId];
      if (!session) return;
      const side = sideForSession(get().panes, sessionId) ?? "right";
      // Drop the dead session, then connect fresh to the same host in place.
      detachPane(side);
      await closeSession(sessionId);
      await get().connect(session.hostId, side);
    },

    clearConnectError: (side) =>
      set((state) => ({
        connectError: { ...state.connectError, [side]: null },
      })),

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

    transfer: ({ source, dest, files, destDir, destSeparator }) => {
      // Local to local is not a transfer the backend performs, and the UI keeps
      // both panes from being local at once.
      if (source.kind === "local" && dest.kind === "local") return;
      const sourceSessionId = source.kind === "remote" ? source.sessionId : null;
      const destSessionId = dest.kind === "remote" ? dest.sessionId : null;
      const kind: TransferKind =
        source.kind === "local" ? "up" : dest.kind === "local" ? "down" : "copy";
      // Files AND directories are accepted; the backend recurses directories.
      for (const file of files) {
        void startTransfer({
          kind,
          name: file.name,
          sourcePath: file.path,
          destPath:
            dest.kind === "remote"
              ? remoteJoin(destDir, file.name)
              : joinPath(destDir, file.name, destSeparator),
          sourceSessionId,
          destSessionId,
          targetDir: destDir,
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
        void startTransfer(metaOf(record));
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
    (t) => touchesSession(t, sessionId) && t.state === "running",
  ).length;
}

/** The session a pane is showing, or null when it is empty or local. */
export function selectPaneSession(
  state: SftpState,
  side: PaneSide,
): SftpSession | null {
  const endpoint = state.panes[side];
  return endpoint.kind === "remote"
    ? (state.sessions[endpoint.sessionId] ?? null)
    : null;
}

/** Derive the local separator from the current local path (defaults to "/"). */
export function localSeparator(localPath: string | null): "/" | "\\" {
  return localPath ? inferSeparator(localPath) : "/";
}
