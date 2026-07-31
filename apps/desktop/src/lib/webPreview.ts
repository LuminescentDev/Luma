import { invoke } from "@tauri-apps/api/core";

/*
 * Typed invoke wrappers for automatic web-server discovery and preview.
 * Discovery enumerates listening TCP sockets on a host over SSH; opening a
 * preview creates a local forward bound to 127.0.0.1 on an OS-assigned port.
 * Preview tunnels are ordinary tunnels on the backend, so they appear in
 * `tunnels_list` with a `web-preview:` port-forward id and are killed on exit.
 */

/** Synthetic port-forward id prefix the backend gives preview tunnels. */
export const PREVIEW_FORWARD_PREFIX = "web-preview:";

export type WebListener = {
  port: number;
  bindAddress: string;
  pid: number | null;
  process: string | null;
  /** Friendly classification ("vite", "next", …) or null when unknown. */
  kind: string | null;
};

export type WebPreviewDiscovery = {
  listeners: WebListener[];
};

export type WebPreview = {
  tunnelId: string;
  hostId: string;
  localPort: number;
  port: number;
  remoteBind: string;
};

export function discoverWebServers(hostId: string): Promise<WebPreviewDiscovery> {
  return invoke<WebPreviewDiscovery>("web_preview_discover", { hostId });
}

export function openWebPreview(
  hostId: string,
  port: number,
  remoteBind?: string | null,
): Promise<WebPreview> {
  return invoke<WebPreview>("web_preview_open", { hostId, port, remoteBind });
}

export function closeWebPreview(tunnelId: string): Promise<void> {
  return invoke<void>("web_preview_close", { tunnelId });
}

export function listWebPreviews(): Promise<WebPreview[]> {
  return invoke<WebPreview[]>("web_previews_list");
}

/** Local URL a preview is reachable at. Always loopback. */
export function previewUrl(preview: WebPreview): string {
  return `http://127.0.0.1:${preview.localPort}/`;
}

/** True for tunnels created by the web-preview flow. */
export function isPreviewForward(portForwardId: string): boolean {
  return portForwardId.startsWith(PREVIEW_FORWARD_PREFIX);
}
