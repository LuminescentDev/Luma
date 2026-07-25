import type { SftpEntry } from "../../lib/sftp";

/*
 * In-window drag payload for dragging file rows between the two SFTP panes.
 * dataTransfer.getData is unavailable during dragover (only types are), so we
 * keep the live payload in a module variable to drive drop-target styling and
 * the actual drop. This is app-local DnD only — no OS file drops.
 */

export type PaneScope = "local" | "remote";

export type DragPayload = { scope: PaneScope; entries: SftpEntry[] };

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
