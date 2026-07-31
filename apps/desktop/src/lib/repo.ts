import { invoke } from "@tauri-apps/api/core";

/*
 * Typed invoke wrappers for the remote repository browser (git status, diffs,
 * file contents) of a terminal session's working directory.
 *
 * Everything runs over the host's existing SSH configuration through one
 * batched `sh -c` script per call (same convention as server_stats /
 * web_preview / multiplexer). The directory and the file paths are sent
 * base64-encoded and re-validated in Rust, so no value from here can ever be
 * re-parsed as shell syntax on the remote host.
 */

/** Working-tree status of one path, as reported by `git status --porcelain=v1 -z`. */
export type RepoFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted";

export type RepoEntry = {
  /** Repository-root-relative path (the NEW path for renames and copies). */
  path: string;
  status: RepoFileStatus;
  /** Source path for renames and copies, otherwise null. */
  oldPath: string | null;
};

export type RepoStatus = {
  /** False when the directory is not inside a work tree — everything else is
   * then empty and the UI says so instead of showing an error. */
  isRepo: boolean;
  /** Absolute path of the work-tree root; all entry paths are relative to it. */
  root: string | null;
  /** Branch name, or the short commit sha when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  /** Commits on HEAD that the upstream lacks; null when there is no upstream. */
  ahead: number | null;
  /** Commits on the upstream that HEAD lacks; null when there is no upstream. */
  behind: number | null;
  staged: RepoEntry[];
  unstaged: RepoEntry[];
  untracked: RepoEntry[];
};

export type RepoDiff = {
  /** Unified patch text; empty when the file has no diff of that kind. */
  patch: string;
  /** The patch hit the size cap and was cut short. */
  truncated: boolean;
  /** The patch was synthesised from an untracked file's contents (all-added). */
  untracked: boolean;
};

export type RepoFile = {
  content: string;
  truncated: boolean;
};

export function repoStatus(hostId: string, cwd: string): Promise<RepoStatus> {
  return invoke<RepoStatus>("repo_status", { hostId, cwd });
}

export function repoDiff(
  hostId: string,
  cwd: string,
  path: string,
  staged: boolean,
): Promise<RepoDiff> {
  return invoke<RepoDiff>("repo_diff", { hostId, cwd, path, staged });
}

export function repoFile(
  hostId: string,
  cwd: string,
  path: string,
  rev?: string,
): Promise<RepoFile> {
  return invoke<RepoFile>("repo_file", { hostId, cwd, path, rev: rev ?? null });
}

/** Drop the cached SSH connection this host's repository views were using. */
export function repoClose(hostId: string): Promise<void> {
  return invoke<void>("repo_close", { hostId });
}

/** Single-character glyph shown next to a file, mirroring git's status letters. */
export function statusGlyph(status: RepoFileStatus): string {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "typechange":
      return "T";
    case "untracked":
      return "?";
    case "conflicted":
      return "U";
  }
}

/** Human label for a status, used for tooltips and screen readers. */
export function statusLabel(status: RepoFileStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Total number of changed paths, for the dialog's dirty indicator. */
export function changedCount(status: RepoStatus | null): number {
  if (!status) return 0;
  return status.staged.length + status.unstaged.length + status.untracked.length;
}
