import { invoke } from "@tauri-apps/api/core";

/*
 * Typed invoke wrappers for the Phase 5 encryption + sync backend. All types are
 * camelCase; optional fields arrive as `null`. Command errors reject with the
 * shared { category, message } shape — parse them with parseLumaError.
 *
 * Secrets (passphrases, passwords, tokens) only ever flow *into* these calls
 * from transient form state. Nothing here returns or caches a secret.
 */

/**
 * Device-local settings key for the opt-in "include private keys in sync"
 * preference. Stored as a JSON boolean via settings_set; defaults to false when
 * unset. Enabling it only takes effect while the vault is unlocked at sync time.
 */
export const SYNC_INCLUDE_PRIVATE_KEYS_KEY = "sync.includePrivateKeys";

/** Object-count breakdown returned by export/import/preview. */
export type ObjectCounts = {
  hosts: number;
  hostGroups: number;
  keyReferences: number;
  identities: number;
  terminalProfiles: number;
  snippets: number;
  settings: number;
  tombstones: number;
};

export type ConflictObjectType =
  | "host"
  | "host_group"
  | "key_reference"
  | "identity"
  | "terminal_profile"
  | "snippet"
  | "setting";

export type Conflict = {
  objectType: ConflictObjectType;
  objectId: string;
  label: string;
  /** Unix seconds, or null when unknown. */
  localUpdatedAt: number | null;
  /** Unix seconds, or null when unknown. */
  remoteUpdatedAt: number | null;
};

export type ConflictResolutionChoice = "keep-local" | "take-remote";

export type ConflictResolution = {
  objectType: ConflictObjectType;
  objectId: string;
  resolution: ConflictResolutionChoice;
};

export type SyncProvider =
  | "local-folder"
  | "webdav"
  | "github-gist"
  | "icloud-drive";

export type SyncConfig = {
  enabled: boolean;
  provider: SyncProvider | null;
  folderPath: string | null;
  url: string | null;
  username: string | null;
  gistId: string | null;
  /** Unix seconds of the last successful sync, or null. */
  lastSyncAt: number | null;
  lastRemoteVersion: string | null;
  passphraseRemembered: boolean;
};

export type SyncConfigureInput =
  | { provider: "local-folder"; folderPath: string }
  | { provider: "webdav"; url: string; username: string; password: string }
  | { provider: "github-gist"; token: string; gistId: string | null }
  | { provider: "icloud-drive" };

export type SyncReport = {
  pulled: boolean;
  pushed: boolean;
  conflicts: Conflict[];
  upToDate: boolean;
  /** Private keys decrypted+imported during this sync (0 unless key sync is on). */
  privateKeysApplied: number;
  /** Private keys that could not be included because the vault was locked. */
  privateKeysSkippedLocked: number;
};

export type ExportResult = {
  path: string;
  objectCounts: ObjectCounts;
};

export type ImportPreview = {
  objectCounts: ObjectCounts;
  conflicts: Conflict[];
};

export type ImportApplyResult = {
  applied: ObjectCounts;
  keptLocal: ObjectCounts;
  conflicts: Conflict[];
  /** Private keys decrypted+imported during this import (0 unless included). */
  privateKeysApplied: number;
  /** Private keys that could not be imported because the vault was locked. */
  privateKeysSkippedLocked: number;
};

// Export / import -----------------------------------------------------------

export function exportEncrypted(path: string, passphrase: string): Promise<ExportResult> {
  return invoke<ExportResult>("export_encrypted", { path, passphrase });
}

export function importPreview(path: string, passphrase: string): Promise<ImportPreview> {
  return invoke<ImportPreview>("import_preview", { path, passphrase });
}

export function importApply(
  path: string,
  passphrase: string,
  resolutions: ConflictResolution[],
): Promise<ImportApplyResult> {
  return invoke<ImportApplyResult>("import_apply", { path, passphrase, resolutions });
}

// Sync ----------------------------------------------------------------------

export function syncGetConfig(): Promise<SyncConfig> {
  return invoke<SyncConfig>("sync_get_config", {});
}

export function syncConfigure(input: SyncConfigureInput): Promise<null> {
  return invoke<null>("sync_configure", { input });
}

export function syncSetPassphrase(passphrase: string, remember: boolean): Promise<null> {
  return invoke<null>("sync_set_passphrase", { passphrase, remember });
}

export function syncDisable(): Promise<null> {
  return invoke<null>("sync_disable", {});
}

export function syncNow(): Promise<SyncReport> {
  return invoke<SyncReport>("sync_now", {});
}

export function syncResolve(resolutions: ConflictResolution[]): Promise<SyncReport> {
  return invoke<SyncReport>("sync_resolve", { resolutions });
}

/** Sum every object count into a single total (for compact summaries). */
export function totalObjectCount(counts: ObjectCounts): number {
  return (
    counts.hosts +
    counts.hostGroups +
    counts.keyReferences +
    counts.identities +
    counts.terminalProfiles +
    counts.snippets +
    counts.settings +
    counts.tombstones
  );
}

/**
 * Format a unix-seconds timestamp as a coarse relative string ("5 minutes
 * ago"). Defensive against null / non-finite inputs — no date library.
 */
export function formatRelativeTime(unixSeconds: number | null | undefined): string {
  if (unixSeconds == null || !Number.isFinite(unixSeconds)) return "never";
  const deltaMs = Date.now() - unixSeconds * 1000;
  if (deltaMs < 0) return "just now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** Truncate a remote-version string for compact display. */
export function truncateVersion(version: string | null | undefined, max = 12): string {
  if (!version) return "—";
  return version.length > max ? `${version.slice(0, max)}…` : version;
}

/** Human labels for sync conflict object types (singular). */
export const CONFLICT_TYPE_LABELS: Record<ConflictObjectType, string> = {
  host: "Host",
  host_group: "Host group",
  key_reference: "Key reference",
  identity: "Identity",
  terminal_profile: "Terminal profile",
  snippet: "Snippet",
  setting: "Setting",
};
