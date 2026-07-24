import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdate, relaunchApp, type UpdateInfo } from "../lib/updater";

/**
 * Shared updater state for the launch banner, the Settings "Updates" section,
 * and the command palette. All check/install work is wrapped so a rejecting
 * `check()` (expected in dev/local builds with the PLACEHOLDER pubkey) is
 * surfaced as a friendly, non-fatal message and never crashes the app.
 */

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  /** Installed to disk; auto-relaunch is scheduled/in progress. */
  | "installed"
  /** Installed, but the automatic relaunch failed — user must restart manually. */
  | "restart-failed"
  | "error";

/**
 * Grace period between a successful install and the automatic relaunch, so the
 * user sees the "Update installed — restarting…" message instead of the window
 * vanishing abruptly. A "Restart now" action lets them skip the wait.
 */
const RESTART_DELAY_MS = 2000;

/** Pending auto-relaunch timer, tracked so "Restart now" can pre-empt it. */
let relaunchTimer: ReturnType<typeof setTimeout> | null = null;

type UpdaterState = {
  status: UpdaterStatus;
  /** Metadata for the available update, when one was found. */
  info: UpdateInfo | null;
  /** Handle used to download + install; held between check and install. */
  update: Update | null;
  /** Unix seconds of the last completed check (success or handled failure). */
  lastCheckedAt: number | null;
  /** User-facing error for the manual flow. */
  errorMessage: string | null;
  /** Bytes downloaded so far during an install. */
  downloadedBytes: number;
  /** Total download size, when the server reported a content length. */
  totalBytes: number | null;
  /** Whether the non-intrusive launch banner should be shown. */
  notificationVisible: boolean;
  /** Guards the automatic launch check so it never nags twice per launch. */
  autoChecked: boolean;
  /** True once a relaunch has been triggered, to avoid firing it twice. */
  relaunching: boolean;

  /** Manual/automatic check. `silent` = automatic launch check. */
  check: (options?: { silent?: boolean }) => Promise<void>;
  /** Download + install the found update, then auto-relaunch to apply it. */
  install: () => Promise<void>;
  /**
   * Relaunch to finish applying an installed update. Cancels the pending
   * auto-relaunch delay and fires immediately. Falls back to manual-restart
   * messaging if `relaunch()` rejects.
   */
  restart: () => Promise<void>;
  /** Run the single silent launch check (idempotent per launch). */
  autoCheck: () => Promise<void>;
  /** Hide the launch banner without touching the underlying update. */
  dismissNotification: () => void;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: "idle",
  info: null,
  update: null,
  lastCheckedAt: null,
  errorMessage: null,
  downloadedBytes: 0,
  totalBytes: null,
  notificationVisible: false,
  autoChecked: false,
  relaunching: false,

  check: async ({ silent = false } = {}) => {
    const status = get().status;
    if (status === "checking" || status === "downloading") return;
    set({ status: "checking", errorMessage: null });
    try {
      const found = await checkForUpdate();
      if (found) {
        set({
          status: "available",
          info: found.info,
          update: found.update,
          lastCheckedAt: nowSeconds(),
          errorMessage: null,
          // Only the automatic launch check raises the banner; the manual flow
          // shows results inline in Settings.
          notificationVisible: silent ? true : get().notificationVisible,
        });
      } else {
        set({
          status: "up-to-date",
          info: null,
          update: null,
          lastCheckedAt: nowSeconds(),
          errorMessage: null,
        });
      }
    } catch {
      // Dev/local builds ship a PLACEHOLDER key/endpoint, so check() rejects.
      // Silent (launch) checks stay a no-op; manual checks show a soft error.
      if (silent) {
        set({ status: "idle", lastCheckedAt: nowSeconds() });
      } else {
        set({
          status: "error",
          errorMessage: "Couldn't check for updates. Try again later.",
          lastCheckedAt: nowSeconds(),
        });
      }
    }
  },

  install: async () => {
    const update = get().update;
    if (!update || get().status === "downloading") return;
    set({
      status: "downloading",
      downloadedBytes: 0,
      totalBytes: null,
      errorMessage: null,
    });
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            set({
              totalBytes: event.data.contentLength ?? null,
              downloadedBytes: 0,
            });
            break;
          case "Progress":
            set((s) => ({ downloadedBytes: s.downloadedBytes + event.data.chunkLength }));
            break;
          case "Finished":
            break;
        }
      });
      // Installed to disk. Move to the "installed" state so the UI can announce
      // "restarting…", then auto-relaunch after a brief, non-abrupt delay. Only
      // reached on a genuinely successful install (download errors throw above).
      set({ status: "installed", relaunching: false, errorMessage: null });
      if (relaunchTimer) clearTimeout(relaunchTimer);
      relaunchTimer = setTimeout(() => {
        relaunchTimer = null;
        void get().restart();
      }, RESTART_DELAY_MS);
    } catch {
      set({
        status: "error",
        errorMessage: "The update couldn't be installed. Try again later.",
      });
    }
  },

  restart: async () => {
    // Only meaningful once an update has actually been installed.
    if (get().status !== "installed" && get().status !== "restart-failed") return;
    if (get().relaunching) return;
    if (relaunchTimer) {
      clearTimeout(relaunchTimer);
      relaunchTimer = null;
    }
    set({ status: "installed", relaunching: true, errorMessage: null });
    try {
      // On success the process restarts and this frame never returns. Never
      // calls `exit` — only relaunch, per the authorized capability.
      await relaunchApp();
    } catch {
      // Relaunch unavailable/failed: keep the update (already installed) and
      // fall back to asking the user to restart manually, with a retry button.
      set({
        status: "restart-failed",
        relaunching: false,
        errorMessage:
          "Update installed — please restart Luma to finish updating.",
      });
    }
  },

  autoCheck: async () => {
    if (get().autoChecked) return;
    set({ autoChecked: true });
    await get().check({ silent: true });
  },

  dismissNotification: () => set({ notificationVisible: false }),
}));
