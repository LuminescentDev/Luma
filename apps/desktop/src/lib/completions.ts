import { invoke } from "@tauri-apps/api/core";

/** One remembered command line for a scope. */
export type CommandHistoryEntry = {
  command: string;
  useCount: number;
  lastUsedAt: number;
};

/**
 * Record an executed command line. Returns whether it was stored — the backend
 * silently drops lines that start with a space, look secret-bearing, or are
 * empty/oversized.
 */
export function recordCommandHistory(scopeKey: string, command: string): Promise<boolean> {
  return invoke<boolean>("command_history_record", { scopeKey, command });
}

/** Prefix-matched history for a scope, most-used first. */
export function queryCommandHistory(
  scopeKey: string,
  prefix: string,
  limit?: number,
): Promise<CommandHistoryEntry[]> {
  return invoke<CommandHistoryEntry[]>("command_history_query", {
    scopeKey,
    prefix,
    limit: limit ?? null,
  });
}

/** Names on the remote host's `$PATH` (SSH hosts only). */
export function fetchRemoteExecutables(hostId: string): Promise<string[]> {
  return invoke<string[]>("shell_completions_executables", { hostId });
}

/** Entries of one remote directory; directories carry a trailing `/`. */
export function fetchRemotePaths(hostId: string, dir: string): Promise<string[]> {
  return invoke<string[]>("shell_completions_paths", { hostId, dir });
}
