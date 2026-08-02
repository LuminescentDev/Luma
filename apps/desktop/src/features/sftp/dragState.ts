import type { SftpEntry } from "../../lib/sftp";
import type { PaneSide } from "../../stores/sftpStore";

/*
 * In-window drag payload for dragging file rows between the two SFTP panes.
 * dataTransfer.getData is unavailable during dragover (only types are), so we
 * keep the live payload in a module variable to drive drop-target styling and
 * the actual drop. This is app-local DnD only — no OS file drops.
 *
 * The payload identifies the source PANE, not local-vs-remote: either pane can
 * hold either kind of endpoint, including two different hosts.
 */

export type DragPayload = { side: PaneSide; entries: SftpEntry[] };

export const LUMA_DND_TYPE = "application/x-luma-files";

let current: DragPayload | null = null;

export function beginDrag(payload: DragPayload) {
  current = payload;
}

export function endDrag() {
  current = null;
}

export function peekDrag(): DragPayload | null {
  return current;
}
