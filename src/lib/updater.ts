import { check as pluginCheck, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

/**
 * Thin wrappers around `tauri-plugin-updater`. All calls can reject in
 * local/dev builds because `tauri.conf.json` ships a PLACEHOLDER updater pubkey
 * and endpoint (CI injects the real values). Callers MUST treat any rejection
 * as a non-fatal "couldn't check" and never block startup on it.
 */

/** Update metadata surfaced to the UI once an update is found. */
export type UpdateInfo = {
  /** The version available to install. */
  version: string;
  /** The version currently running. */
  currentVersion: string;
  /** Release notes / changelog body, when the manifest provides one. */
  notes: string | null;
};

/** A found update plus the handle used to download and install it. */
export type FoundUpdate = {
  update: Update;
  info: UpdateInfo;
};

/**
 * Ask the configured update endpoint whether a newer version exists.
 * Resolves to the update handle + metadata, or `null` when up to date.
 * Rejects when the endpoint/pubkey is unreachable or invalid (dev builds).
 */
export async function checkForUpdate(): Promise<FoundUpdate | null> {
  const update = await pluginCheck();
  if (!update) return null;
  return {
    update,
    info: {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body?.trim() ? update.body.trim() : null,
    },
  };
}

/** Current app version from the Tauri runtime (best-effort). */
export { getVersion };

/**
 * Restart the app to finish applying an installed update. Authorized by the
 * `process:allow-restart` capability. Rejects when the runtime can't restart
 * (e.g. missing capability, non-Tauri context); callers MUST treat a rejection
 * as non-fatal and fall back to asking the user to restart manually. Never
 * exits the process — only relaunches.
 */
export async function relaunchApp(): Promise<void> {
  await relaunch();
}

/** Compact human-readable byte size for download progress. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
