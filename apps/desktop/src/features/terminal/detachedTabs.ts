import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cursorPosition, monitorFromPoint } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { collectLeaves } from "./paneTree";
import { terminalManager } from "./terminalManager";
import { useSessionStore } from "../../stores/sessionStore";
import { useTabDragStore } from "../../stores/tabDragStore";
import type { TerminalSession, WorkspaceTab } from "../../types";

export type DetachedTabSnapshot = {
  tab: WorkspaceTab;
  sessions: TerminalSession[];
  buffers: Record<string, string>;
  /** Grid size of each source terminal. The display copy is resized to this
   * BEFORE the buffer replays so lines wrap at their original width. */
  dims: Record<string, { cols: number; rows: number }>;
};

type DetachedEntry = {
  tabId: string;
  sessionIds: string[];
  label: string;
  unlistenInput: UnlistenFn;
  unlistenReady: UnlistenFn;
  unlistenResize: UnlistenFn;
  unsubscribeOutput: Array<() => void>;
};

const detached = new Map<string, DetachedEntry>();
const listeners = new Set<() => void>();
let version = 0;

export function subscribeDetachedTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function detachedTabIds(): Set<string> {
  return new Set(detached.keys());
}

export function detachedTabsVersion(): number {
  return version;
}

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** The OS window label for a tab's detached window. Sanitizes the tab id to the
 * charset Tauri window labels allow; the single source of truth so the spawn and
 * the acknowledgement address the same window. */
export function detachedWindowLabel(tabId: string): string {
  return `detached-${tabId.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

/** Where the torn-off window sits relative to the pointer (logical px): the
 * cursor lands on the window's tab strip, like Chrome. */
const DETACH_GRAB_OFFSET = { x: 120, y: 20 };

/** The window position (physical px) that puts the tab-strip grab point under
 * the global cursor. Physical coordinates are the only representation that is
 * unambiguous across monitors: each monitor has its own scale factor, and
 * logical positions are relative to the wrong monitor when the cursor has moved
 * to another screen. Falls back to null when the cursor can't be read. Used for
 * the spawn position and by TabBar's per-pointermove repositioning during a
 * live tear-off drag. */
export async function windowPositionUnderCursor(): Promise<PhysicalPosition | null> {
  return (await cursorSpawnPlacement())?.position ?? null;
}

/** The tear-off position plus the scale factor of the monitor it lands on, so
 * callers that need LOGICAL coordinates (the WebviewWindow constructor takes
 * logical x/y) can convert without reading the cursor a second time. */
async function cursorSpawnPlacement(): Promise<{
  position: PhysicalPosition;
  scale: number;
} | null> {
  try {
    const cursor = await cursorPosition();
    // The grab offset is in logical px; convert it using the scale factor of
    // the monitor the CURSOR is on (the window spawns there, not necessarily on
    // the monitor the main window occupies).
    const monitor = await monitorFromPoint(cursor.x, cursor.y).catch(() => null);
    const scale = monitor?.scaleFactor ?? window.devicePixelRatio ?? 1;
    return {
      position: new PhysicalPosition(
        Math.round(cursor.x - DETACH_GRAB_OFFSET.x * scale),
        Math.round(cursor.y - DETACH_GRAB_OFFSET.y * scale),
      ),
      scale,
    };
  } catch {
    return null;
  }
}

export async function detachTab(
  tabId: string,
  options?: {
    /** The pointer is still held mid-gesture (live tear-off): spawn unfocused
     * so the focus steal cannot disturb the main window's pointer capture —
     * the caller keeps moving this window from its own pointermove stream and
     * focuses it when the pointer is released. */
    continueDrag?: boolean;
  },
): Promise<WebviewWindow | null> {
  if (detached.has(tabId)) return null;
  const state = useSessionStore.getState();
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return null;
  const leaves = collectLeaves(tab.root);
  const sessionIds = leaves.map((leaf) => leaf.sessionId);
  const sessions = state.sessions.filter((candidate) => sessionIds.includes(candidate.id));
  if (sessions.length !== sessionIds.length) return null;

  const label = detachedWindowLabel(tabId);
  const activeSessionId = leaves.find((leaf) => leaf.id === tab.activePaneId)?.sessionId;
  const title = sessions.find((session) => session.id === activeSessionId)?.title || "Terminal";
  const continueDrag = options?.continueDrag ?? false;
  // Read the cursor BEFORE creating the window so the spawn position is known
  // up front and the window is created already visible at the right spot.
  // Spawning hidden and doing created → cursor read → setPosition → show costs
  // several serial IPC round trips, which the user sees as the torn-off window
  // taking a beat to appear.
  const spawnAt = await cursorSpawnPlacement();
  // The constructor takes LOGICAL x/y, so convert using the scale factor of the
  // monitor the window is landing on.
  const spawnLogical = spawnAt?.position.toLogical(spawnAt.scale) ?? null;
  const win = new WebviewWindow(label, {
    url: `/?detached=${encodeURIComponent(tabId)}&title=${encodeURIComponent(title)}`,
    title,
    width: 860,
    height: 560,
    minWidth: 420,
    minHeight: 260,
    decorations: false,
    ...(spawnLogical
      ? { x: spawnLogical.x, y: spawnLogical.y }
      : { center: true }),
    // During a live tear-off the main window still holds pointer capture and
    // moves this window itself; stealing focus mid-gesture would break that
    // capture. The caller focuses the window when the pointer is released.
    focus: !continueDrag,
  });

  const unlistenInput = await listen<{ sessionId: string; data: string }>("detached-terminal-input", (event) => {
    if (sessionIds.includes(event.payload.sessionId)) {
      terminalManager.injectInput(event.payload.sessionId, event.payload.data);
    }
  });
  const unlistenResize = await listen<{ sessionId: string; cols: number; rows: number }>(
    "detached-terminal-resize",
    (event) => {
      if (!sessionIds.includes(event.payload.sessionId)) return;
      // Mirror the detached window's grid onto the hidden source terminal; its
      // onResize handler then propagates the size to the backend PTY, so the
      // shell reflows for the window the user is actually looking at.
      terminalManager.resizeTerminal(
        event.payload.sessionId,
        event.payload.cols,
        event.payload.rows,
      );
    },
  );
  const unlistenReady = await listen<string>("detached-terminal-ready", (event) => {
    if (event.payload !== tabId) return;
    const buffers = Object.fromEntries(
      sessionIds.map((sessionId) => [sessionId, terminalManager.getBufferText(sessionId)]),
    );
    const dims = Object.fromEntries(
      sessionIds.flatMap((sessionId) => {
        const size = terminalManager.getDimensions(sessionId);
        return size ? [[sessionId, size] as const] : [];
      }),
    );
    const snapshot: DetachedTabSnapshot = { tab, sessions, buffers, dims };
    void emitTo(label, "detached-terminal-snapshot", snapshot);
    for (const unsubscribe of entry.unsubscribeOutput) unsubscribe();
    entry.unsubscribeOutput = sessionIds.map((sessionId) =>
      terminalManager.subscribeOutput(sessionId, (data) => {
        void emitTo(label, "detached-terminal-output", {
          sessionId,
          data: Array.from(data),
        });
      }),
    );
  });
  const entry: DetachedEntry = { tabId, sessionIds, label, unlistenInput, unlistenReady, unlistenResize, unsubscribeOutput: [] };
  detached.set(tabId, entry);
  const nextTab = state.tabs.find((candidate) => candidate.id !== tabId && !detached.has(candidate.id));
  if (state.activeTabId === tabId && nextTab) state.setActiveTab(nextTab.id);
  for (const sessionId of sessionIds) terminalManager.detach(sessionId);
  changed();

  void win.once("tauri://destroyed", () => attachTab(tabId));
  return win;
}

export function attachTab(
  tabId: string,
  options?: {
    /** Skip activating the tab. Used when a live drag re-docks mid-gesture:
     * the tab returns to the strip as the dimmed drag source, and activation
     * waits for pointer release so crossing the frame commits nothing. */
    activate?: boolean;
  },
): void {
  const entry = detached.get(tabId);
  if (!entry) return;
  for (const unsubscribe of entry.unsubscribeOutput) unsubscribe();
  entry.unlistenInput();
  entry.unlistenReady();
  entry.unlistenResize();
  detached.delete(tabId);
  changed();
  // Drop any placeholder this tab was showing for a drag driven by its own
  // (now gone) window, so a window destroyed mid-hover can't leave the strip
  // stuck with a dimmed, non-interactive tab.
  const drag = useTabDragStore.getState();
  if (drag.external && drag.sourceTabId === tabId) drag.clear();
  if (options?.activate !== false) useSessionStore.getState().setActiveTab(tabId);
}
