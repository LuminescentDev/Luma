import { create } from "zustand";
import { parseLumaError } from "../lib/hosts";
import { queryClient } from "../lib/queryClient";
import { SYNC_CONFIG_KEY } from "../hooks/useSync";
import {
  syncNow as runSyncNow,
  syncResolve as runSyncResolve,
  syncSetPassphrase,
  type Conflict,
  type ConflictResolution,
  type SyncReport,
} from "../lib/sync";

/*
 * Shared sync runtime state. Wraps sync_now / sync_resolve so the settings UI
 * and the title-bar indicator observe one source of truth. Pending conflicts
 * live only in backend memory across restarts, so this store simply mirrors the
 * most recent report.
 *
 * SECURITY: no secrets are ever held in this store. Passphrases pass through
 * `submitPassphrase` as a transient argument and are never persisted here.
 */

export type SyncRuntimeStatus = "idle" | "syncing" | "error" | "conflict";

/** Query keys refreshed after a pull applies remote changes. */
const PULL_INVALIDATION_KEYS = [
  ["hosts"],
  ["recent-hosts"],
  ["host-groups"],
  ["key-references"],
  ["identities"],
  ["profiles"],
  ["settings"],
  ["snippets"],
];

type SyncState = {
  status: SyncRuntimeStatus;
  /** Pending conflicts from the last sync/resolve (empty when none). */
  conflicts: Conflict[];
  /** The most recent successful report (for pulled/pushed/upToDate feedback). */
  lastReport: SyncReport | null;
  errorCategory: string | null;
  errorMessage: string | null;
  /** True when sync failed because no passphrase is loaded (vault-locked). */
  needsPassphrase: boolean;
  /** Whether the shared conflict-resolution dialog is open. */
  conflictDialogOpen: boolean;
  /** Whether the shared passphrase prompt is open. */
  passphraseDialogOpen: boolean;
  /** Set-passphrase / resolve in-flight flag distinct from top-level status. */
  busy: boolean;

  /** Run a sync. On vault-locked, opens the passphrase prompt automatically. */
  syncNow: () => Promise<void>;
  /** Submit resolutions for every displayed conflict in one call. */
  resolve: (resolutions: ConflictResolution[]) => Promise<void>;
  /** Load a passphrase (optionally remembering it) then retry sync once. */
  submitPassphrase: (passphrase: string, remember: boolean) => Promise<void>;
  /** Title-bar entry point: open conflicts if pending, otherwise sync. */
  activate: () => void;
  openConflicts: () => void;
  closeConflicts: () => void;
  openPassphrasePrompt: () => void;
  closePassphrasePrompt: () => void;
  clearError: () => void;
  /** Clear all runtime state (called when sync is disabled). */
  reset: () => void;
};

function applyReport(
  report: SyncReport,
  set: (partial: Partial<SyncState>) => void,
) {
  if (report.pulled) {
    for (const key of PULL_INVALIDATION_KEYS) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }
  // The config's lastSyncAt / lastRemoteVersion changed after any sync attempt.
  void queryClient.invalidateQueries({ queryKey: SYNC_CONFIG_KEY });

  if (report.conflicts.length > 0) {
    set({
      status: "conflict",
      conflicts: report.conflicts,
      lastReport: report,
      conflictDialogOpen: true,
      errorCategory: null,
      errorMessage: null,
    });
  } else {
    set({
      status: "idle",
      conflicts: [],
      lastReport: report,
      conflictDialogOpen: false,
      errorCategory: null,
      errorMessage: null,
    });
  }
}

function handleError(
  error: unknown,
  set: (partial: Partial<SyncState>) => void,
) {
  const { category, message } = parseLumaError(error);
  if (category === "vault-locked") {
    set({
      status: "error",
      needsPassphrase: true,
      passphraseDialogOpen: true,
      errorCategory: category,
      errorMessage: null,
    });
    return;
  }
  const friendly =
    category === "sync-conflict"
      ? "Remote changed during sync — try again."
      : message;
  set({ status: "error", errorCategory: category, errorMessage: friendly });
}

export const useSyncStore = create<SyncState>((set, get) => ({
  status: "idle",
  conflicts: [],
  lastReport: null,
  errorCategory: null,
  errorMessage: null,
  needsPassphrase: false,
  conflictDialogOpen: false,
  passphraseDialogOpen: false,
  busy: false,

  syncNow: async () => {
    if (get().status === "syncing") return;
    set({ status: "syncing", errorCategory: null, errorMessage: null });
    try {
      const report = await runSyncNow();
      applyReport(report, set);
    } catch (error) {
      handleError(error, set);
    }
  },

  resolve: async (resolutions) => {
    set({ busy: true, errorCategory: null, errorMessage: null });
    try {
      const report = await runSyncResolve(resolutions);
      applyReport(report, set);
    } catch (error) {
      handleError(error, set);
    } finally {
      set({ busy: false });
    }
  },

  submitPassphrase: async (passphrase, remember) => {
    set({ busy: true, errorCategory: null, errorMessage: null });
    try {
      await syncSetPassphrase(passphrase, remember);
      void queryClient.invalidateQueries({ queryKey: SYNC_CONFIG_KEY });
      set({
        needsPassphrase: false,
        passphraseDialogOpen: false,
        busy: false,
      });
      // Retry the sync once now that a passphrase is loaded.
      await get().syncNow();
    } catch (error) {
      handleError(error, set);
      set({ busy: false });
    }
  },

  activate: () => {
    const state = get();
    if (state.conflicts.length > 0) {
      set({ conflictDialogOpen: true });
      return;
    }
    if (state.needsPassphrase) {
      set({ passphraseDialogOpen: true });
      return;
    }
    void state.syncNow();
  },

  openConflicts: () => set({ conflictDialogOpen: true }),
  closeConflicts: () => set({ conflictDialogOpen: false }),
  openPassphrasePrompt: () => set({ passphraseDialogOpen: true }),
  closePassphrasePrompt: () => set({ passphraseDialogOpen: false }),
  clearError: () => set({ errorCategory: null, errorMessage: null }),

  reset: () =>
    set({
      status: "idle",
      conflicts: [],
      lastReport: null,
      errorCategory: null,
      errorMessage: null,
      needsPassphrase: false,
      conflictDialogOpen: false,
      passphraseDialogOpen: false,
      busy: false,
    }),
}));
