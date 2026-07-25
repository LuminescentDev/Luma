import { Channel, invoke } from "@tauri-apps/api/core";

/*
 * Typed invoke wrappers for the Phase 6 SFTP backend, mirroring the style of
 * src/lib/ssh.ts and src/lib/portForwards.ts. All types are camelCase; optional
 * fields arrive as `null`. The frontend has NO filesystem access of its own —
 * even "local" browsing goes through backend commands. Secrets are never
 * handled here.
 *
 * Transfers stream a Channel<TransferProgress>. After a transfer starts, runtime
 * errors arrive on that channel as the single terminal event (the invoke itself
 * resolves with the transferId). The backend forgets finished transfers, so the
 * store retains them for the visible queue.
 */

export type SftpKind = "file" | "dir" | "symlink" | "other";

export type SftpEntry = {
  name: string;
  /** Canonical absolute path, using the scope's separator style. */
  path: string;
  kind: SftpKind;
  size: number | null;
  /** Unix seconds, or null when the backend could not read it. */
  modifiedAt: number | null;
  /** Permission string (e.g. "rwxr-xr-x") on remote; often null locally. */
  permissions: string | null;
};

export type DirectoryListing = {
  /** Canonical path the backend resolved (may differ from the requested one). */
  path: string;
  entries: SftpEntry[];
};

export type TransferState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  /** Only used on per-entry ("entry") events for skipped symlinks. */
  | "skipped";

/**
 * Which facet of a directory transfer an event describes. Absent entirely for
 * single-file jobs, whose events carry only the original five fields (legacy).
 *  - "file": progress of the file currently being transferred, plus an
 *    aggregate snapshot of the whole job.
 *  - "aggregate": overall progress; `transferred`=bytesDone, `total`=totalBytes.
 *  - "entry": a per-entry outcome (skipped symlink or failed entry); `filePath`
 *    is the entry's path relative to the transfer root, always using "/".
 */
export type TransferProgressKind = "file" | "aggregate" | "entry";

/** Whole-job snapshot carried on directory "file" events. */
export type TransferAggregate = {
  totalBytes: number;
  bytesDone: number;
  totalFiles: number;
  filesDone: number;
  currentFilePath: string | null;
};

export type TransferProgress = {
  transferId: string;
  transferred: number;
  total: number | null;
  state: TransferState;
  errorMessage: string | null;
  /** Absent on single-file (legacy) events; set on every directory event. */
  progressKind?: TransferProgressKind;
  /** Relative "/"-separated path: current file on "file", entry on "entry". */
  filePath?: string;
  /** Whole-job snapshot; present on directory "file" events. */
  aggregate?: TransferAggregate;
  /** Byte offset a resumed file started at, present on the FIRST "file" (and
   * single-file running) event of a resumed transfer — `transferred` begins at
   * this offset. Absent for transfers that started from the beginning. */
  resumedFrom?: number;
};

export type SftpSessionInfo = { sftpSessionId: string; hostId: string };
export type SftpConnectResult = { sftpSessionId: string; initialPath: string };
export type TransferHandle = { transferId: string };

// Session lifecycle ----------------------------------------------------------

export function sftpConnect(hostId: string): Promise<SftpConnectResult> {
  return invoke<SftpConnectResult>("sftp_connect", { hostId });
}

export function sftpDisconnect(sftpSessionId: string): Promise<void> {
  return invoke<void>("sftp_disconnect", { sftpSessionId });
}

export function sftpSessions(): Promise<SftpSessionInfo[]> {
  return invoke<SftpSessionInfo[]>("sftp_sessions", {});
}

// Remote operations ----------------------------------------------------------

export function sftpList(sessionId: string, path: string): Promise<DirectoryListing> {
  return invoke<DirectoryListing>("sftp_list", { sessionId, path });
}

export function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return invoke<void>("sftp_mkdir", { sessionId, path });
}

export function sftpRename(sessionId: string, from: string, to: string): Promise<void> {
  return invoke<void>("sftp_rename", { sessionId, from, to });
}

export function sftpDelete(
  sessionId: string,
  path: string,
  recursive: boolean,
): Promise<void> {
  return invoke<void>("sftp_delete", { sessionId, path, recursive });
}

// Local operations (backend-mediated; the frontend has no fs access) ---------

export function localList(path: string | null): Promise<DirectoryListing> {
  return invoke<DirectoryListing>("local_list", { path });
}

export function localMkdir(path: string): Promise<void> {
  return invoke<void>("local_mkdir", { path });
}

export function localRename(from: string, to: string): Promise<void> {
  return invoke<void>("local_rename", { from, to });
}

export function localDelete(path: string, recursive: boolean): Promise<void> {
  return invoke<void>("local_delete", { path, recursive });
}

// Transfers ------------------------------------------------------------------

export function sftpUpload(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onProgress: (progress: TransferProgress) => void,
): Promise<TransferHandle> {
  const channel = new Channel<TransferProgress>();
  channel.onmessage = onProgress;
  return invoke<TransferHandle>("sftp_upload", {
    sessionId,
    localPath,
    remotePath,
    onProgress: channel,
  });
}

export function sftpDownload(
  sessionId: string,
  remotePath: string,
  localPath: string,
  onProgress: (progress: TransferProgress) => void,
): Promise<TransferHandle> {
  const channel = new Channel<TransferProgress>();
  channel.onmessage = onProgress;
  return invoke<TransferHandle>("sftp_download", {
    sessionId,
    remotePath,
    localPath,
    onProgress: channel,
  });
}

export function sftpCancel(transferId: string): Promise<void> {
  return invoke<void>("sftp_cancel", { transferId });
}

/**
 * Retry the failed / incomplete entries of a finished transfer. Returns a NEW
 * transferId that owns the retry — the caller must rebind its queue row to it
 * for any subsequent cancel or progress handling. Rejects with invalid-input
 * "unknown transfer", "transfer is still running", or "transfer has no failed
 * or incomplete entries to retry".
 */
export function sftpRetry(
  transferId: string,
  onProgress: (progress: TransferProgress) => void,
): Promise<TransferHandle> {
  const channel = new Channel<TransferProgress>();
  channel.onmessage = onProgress;
  return invoke<TransferHandle>("sftp_retry", {
    transferId,
    onProgress: channel,
  });
}

// Formatting + path helpers --------------------------------------------------

const BYTE_UNITS = ["KiB", "MiB", "GiB", "TiB", "PiB"];

/** Human-readable byte size. Defensive against null / negative / non-finite. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

/** Format a transfer rate in bytes/second. */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Format a unix-seconds timestamp defensively (null / bogus -> em dash). */
export function formatModified(unixSeconds: number | null | undefined): string {
  if (unixSeconds == null || !Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return "—";
  }
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  const now = Date.now();
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString(undefined, {
    year: sameYear ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Passthrough for the backend permission string (null -> em dash). */
export function formatPermissions(permissions: string | null | undefined): string {
  return permissions && permissions.length > 0 ? permissions : "—";
}

/**
 * Infer the separator style of a canonical path. Remote paths are always "/";
 * local paths use whatever the backend's canonical form returned (Windows uses
 * "\"). We never assume "/" for local paths.
 */
export function inferSeparator(path: string): "/" | "\\" {
  return path.includes("\\") ? "\\" : "/";
}

/** Join a directory and a child name using the given separator. */
export function joinPath(base: string, name: string, separator: "/" | "\\"): string {
  if (base.endsWith(separator)) return `${base}${name}`;
  return `${base}${separator}${name}`;
}

/** Join within the remote scope (always "/"). */
export function remoteJoin(base: string, name: string): string {
  return joinPath(base, name, "/");
}

/**
 * Parent of a canonical path, or null when already at a root. Derived purely by
 * string operations on the canonical path so it works for both "/" (remote /
 * unix) and "\" (Windows) styles, including drive roots like "C:\".
 */
export function parentPath(path: string, separator: "/" | "\\"): string | null {
  const trimmed = path.replace(/[/\\]+$/, "");
  const index = trimmed.lastIndexOf(separator);
  if (index < 0) return null;
  if (separator === "/") {
    return index === 0 ? "/" : trimmed.slice(0, index);
  }
  const parent = trimmed.slice(0, index);
  if (parent === "") return null;
  // Keep the trailing separator for a drive root ("C:" -> "C:\").
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${separator}`;
  return parent;
}

/**
 * Split a canonical path into clickable breadcrumb segments. Each segment
 * carries the absolute path to navigate to when clicked.
 */
export function breadcrumbSegments(
  path: string,
  separator: "/" | "\\",
): { label: string; path: string }[] {
  const segments: { label: string; path: string }[] = [];
  if (separator === "/") {
    segments.push({ label: "/", path: "/" });
    const parts = path.split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = `${acc}/${part}`;
      segments.push({ label: part, path: acc });
    }
    return segments;
  }
  // Windows-style: first part is the drive ("C:").
  const parts = path.split("\\").filter(Boolean);
  let acc = "";
  parts.forEach((part, i) => {
    if (i === 0) {
      acc = `${part}\\`;
      segments.push({ label: part, path: acc });
    } else {
      acc = acc.endsWith("\\") ? `${acc}${part}` : `${acc}\\${part}`;
      segments.push({ label: part, path: acc });
    }
  });
  if (segments.length === 0) segments.push({ label: path, path });
  return segments;
}
