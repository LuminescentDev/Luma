import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  closeWebPreview,
  discoverWebServers,
  listWebPreviews,
  openWebPreview,
  previewUrl,
  type WebListener,
  type WebPreview,
} from "../lib/webPreview";
import { parseLumaError } from "../lib/hosts";

/*
 * Web-server discovery and preview state. The backend owns the preview tunnels
 * (they ride the normal tunnel lifecycle and are killed on app exit); this
 * store mirrors them so the dialog can list open previews and close them.
 *
 * The tunnels themselves are keyed per host and port, but each one remembers
 * the terminal session that opened it so `closeForSession` can tear it down
 * when that pane closes — a forward from this device into a remote host must
 * not outlive the session the user started it from. Previews recovered by
 * `hydrate` have no known owner and stay up until closed explicitly.
 */

type WebPreviewState = {
  /** Host whose discovery results are currently held. */
  hostId: string | null;
  listeners: WebListener[];
  discovering: boolean;
  discoverError: string | null;
  /** Open previews keyed by tunnelId. */
  previews: Record<string, WebPreview>;
  /** Terminal session that opened each preview, keyed by tunnelId. */
  owners: Record<string, string>;
  /** Remote ports with an in-flight open request. */
  opening: Record<number, boolean>;
  openError: string | null;
  discover: (hostId: string) => Promise<void>;
  open: (
    hostId: string,
    port: number,
    remoteBind?: string | null,
    sessionId?: string | null,
  ) => Promise<WebPreview | null>;
  launch: (preview: WebPreview) => Promise<void>;
  close: (tunnelId: string) => Promise<void>;
  /** Close every preview opened from a terminal session that is going away. */
  closeForSession: (sessionId: string) => Promise<void>;
  hydrate: () => Promise<void>;
  clearErrors: () => void;
};

export const useWebPreviewStore = create<WebPreviewState>((set, get) => ({
  hostId: null,
  listeners: [],
  discovering: false,
  discoverError: null,
  previews: {},
  owners: {},
  opening: {},
  openError: null,

  discover: async (hostId) => {
    set({
      hostId,
      discovering: true,
      discoverError: null,
      listeners: [],
    });
    try {
      const { listeners } = await discoverWebServers(hostId);
      // A later discovery for another host may have superseded this one.
      if (get().hostId !== hostId) return;
      set({ listeners, discovering: false });
    } catch (error) {
      if (get().hostId !== hostId) return;
      const { message } = parseLumaError(error);
      set({ discovering: false, discoverError: message, listeners: [] });
    }
  },

  open: async (hostId, port, remoteBind, sessionId) => {
    set((state) => ({
      opening: { ...state.opening, [port]: true },
      openError: null,
    }));
    try {
      const preview = await openWebPreview(hostId, port, remoteBind ?? null);
      set((state) => ({
        opening: omitPort(state.opening, port),
        previews: { ...state.previews, [preview.tunnelId]: preview },
        owners: sessionId
          ? { ...state.owners, [preview.tunnelId]: sessionId }
          : state.owners,
      }));
      await get().launch(preview);
      return preview;
    } catch (error) {
      const { message } = parseLumaError(error);
      set((state) => ({
        opening: omitPort(state.opening, port),
        openError: message,
      }));
      return null;
    }
  },

  // Opening the browser is best-effort: the tunnel stays up and the dialog
  // still shows the copyable local URL if the system handler fails.
  launch: async (preview) => {
    try {
      await openUrl(previewUrl(preview));
    } catch (error) {
      const { message } = parseLumaError(error);
      set({ openError: `Could not open the browser: ${message}` });
    }
  },

  close: async (tunnelId) => {
    await closeWebPreview(tunnelId).catch(() => {});
    set((state) => {
      if (!(tunnelId in state.previews) && !(tunnelId in state.owners)) {
        return {};
      }
      const previews = { ...state.previews };
      delete previews[tunnelId];
      const owners = { ...state.owners };
      delete owners[tunnelId];
      return { previews, owners };
    });
  },

  closeForSession: async (sessionId) => {
    const doomed = Object.entries(get().owners)
      .filter(([, owner]) => owner === sessionId)
      .map(([tunnelId]) => tunnelId);
    await Promise.all(doomed.map((tunnelId) => get().close(tunnelId)));
  },

  hydrate: async () => {
    try {
      const previews = await listWebPreviews();
      set({
        previews: Object.fromEntries(
          previews.map((preview) => [preview.tunnelId, preview]),
        ),
      });
    } catch {
      // Non-fatal: the dialog simply starts with no known previews.
    }
  },

  clearErrors: () => set({ discoverError: null, openError: null }),
}));

function omitPort(
  record: Record<number, boolean>,
  port: number,
): Record<number, boolean> {
  if (!(port in record)) return record;
  const next = { ...record };
  delete next[port];
  return next;
}

/** Previews for one host, sorted by remote port. Takes just the record so
 * callers can memoize on it instead of on the whole store snapshot. */
export function selectPreviewsForHost(
  state: Pick<WebPreviewState, "previews">,
  hostId: string | null,
): WebPreview[] {
  return Object.values(state.previews)
    .filter((preview) => !hostId || preview.hostId === hostId)
    .sort((left, right) => left.port - right.port);
}
