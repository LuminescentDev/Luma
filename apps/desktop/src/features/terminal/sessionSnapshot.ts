import type {
  PaneNode,
  RestoreDescriptor,
  SplitDirection,
  TerminalSession,
  WorkspaceTab,
} from "../../types";
import { SETTING_KEYS } from "../../types";
import { setSetting } from "../../lib/settings";
import { useSessionStore } from "../../stores/sessionStore";
import { getCurrentWindow } from "@tauri-apps/api/window";

/*
 * Versioned, metadata-only snapshot of the workspace: every tab, its split-pane
 * layout (structure + sizes), and each pane's RestoreDescriptor (how to
 * re-spawn it). Terminal bytes and scrollback are NEVER captured — restore
 * re-runs the descriptor from scratch. Because the snapshot is written
 * continuously (debounced), an unexpected crash simply leaves the latest
 * snapshot on disk, which is restored on the next launch (that is the crash
 * recovery).
 */

/** A pane-tree leaf carries its RestoreDescriptor instead of a live sessionId. */
export type SnapshotPaneNode =
  | { kind: "leaf"; restore: RestoreDescriptor }
  | {
      kind: "split";
      direction: SplitDirection;
      children: SnapshotPaneNode[];
      sizes: number[];
    };

export type SnapshotTab = { root: SnapshotPaneNode };

export type WorkspaceSnapshot = {
  version: 1;
  tabs: SnapshotTab[];
  activeTabIndex: number;
};

const SNAPSHOT_VERSION = 1 as const;
const DEBOUNCE_MS = 500;

function restoreFor(
  sessions: TerminalSession[],
  sessionId: string,
): RestoreDescriptor | undefined {
  return sessions.find((s) => s.id === sessionId)?.restore;
}

/**
 * Convert a live pane tree into its snapshot form. Leaves whose session has no
 * restore descriptor are dropped and their splits collapse (mirrors removeLeaf
 * so the remaining layout stays valid). Returns null when the whole subtree has
 * nothing restorable.
 */
export function serializeNode(
  node: PaneNode,
  sessions: TerminalSession[],
): SnapshotPaneNode | null {
  if (node.kind === "leaf") {
    const restore = restoreFor(sessions, node.sessionId);
    return restore ? { kind: "leaf", restore } : null;
  }

  const children: SnapshotPaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const serialized = serializeNode(child, sessions);
    if (serialized) {
      children.push(serialized);
      sizes.push(node.sizes[i]);
    }
  });

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];

  const total = sizes.reduce((a, b) => a + b, 0);
  const normalized =
    total > 0
      ? sizes.map((s) => (s / total) * 100)
      : children.map(() => 100 / children.length);
  return { kind: "split", direction: node.direction, children, sizes: normalized };
}

/** Serialize the workspace (tabs + active tab + each pane's restore descriptor)
 * into a versioned snapshot. Reads only the slices that matter, so writing it
 * back can never rewrite terminal content. */
export function serializeWorkspace(
  tabs: WorkspaceTab[],
  sessions: TerminalSession[],
  activeTabId: string | null,
): WorkspaceSnapshot {
  const snapTabs: SnapshotTab[] = [];
  let activeTabIndex = 0;
  for (const tab of tabs) {
    const root = serializeNode(tab.root, sessions);
    if (!root) continue;
    if (tab.id === activeTabId) activeTabIndex = snapTabs.length;
    snapTabs.push({ root });
  }
  return { version: SNAPSHOT_VERSION, tabs: snapTabs, activeTabIndex };
}

// --- Validation (first-run / corrupt snapshots must fail closed) ---

function isRestoreDescriptor(value: unknown): value is RestoreDescriptor {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "local") return true; // ref is optional
  if (kind === "ssh") {
    // hostId is required; the display strings are optional so pre-existing
    // snapshots (hostId only) still validate. When present they must be strings.
    const ssh = value as {
      hostId?: unknown;
      title?: unknown;
      connectionTarget?: unknown;
      tabColor?: unknown;
    };
    if (typeof ssh.hostId !== "string") return false;
    if (ssh.title !== undefined && typeof ssh.title !== "string") return false;
    if (ssh.connectionTarget !== undefined && typeof ssh.connectionTarget !== "string") {
      return false;
    }
    // tabColor is optional; when present it must be a string or null.
    if (ssh.tabColor !== undefined && ssh.tabColor !== null && typeof ssh.tabColor !== "string") {
      return false;
    }
    return true;
  }
  if (kind === "serial") {
    const config = (value as { config?: unknown }).config;
    return (
      !!config &&
      typeof config === "object" &&
      typeof (config as { path?: unknown }).path === "string" &&
      typeof (config as { baudRate?: unknown }).baudRate === "number"
    );
  }
  return false;
}

export function isSnapshotNode(value: unknown): value is SnapshotPaneNode {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "leaf") {
    return isRestoreDescriptor((value as { restore?: unknown }).restore);
  }
  if (kind === "split") {
    const children = (value as { children?: unknown }).children;
    const sizes = (value as { sizes?: unknown }).sizes;
    const direction = (value as { direction?: unknown }).direction;
    return (
      (direction === "row" || direction === "column") &&
      Array.isArray(children) &&
      children.length > 0 &&
      children.every(isSnapshotNode) &&
      Array.isArray(sizes) &&
      sizes.length === children.length
    );
  }
  return false;
}

/** Parse a raw settings value into a validated snapshot, or null when it is
 * absent, the wrong version, or malformed. Never throws. */
export function parseSnapshot(raw: unknown): WorkspaceSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as {
    version?: unknown;
    tabs?: unknown;
    activeTabIndex?: unknown;
  };
  if (record.version !== SNAPSHOT_VERSION || !Array.isArray(record.tabs)) {
    return null;
  }
  const tabs: SnapshotTab[] = [];
  for (const tab of record.tabs) {
    const root = (tab as { root?: unknown })?.root;
    if (!isSnapshotNode(root)) return null;
    tabs.push({ root });
  }
  const activeTabIndex =
    typeof record.activeTabIndex === "number" ? record.activeTabIndex : 0;
  return { version: SNAPSHOT_VERSION, tabs, activeTabIndex };
}

// --- Persistence controller (debounced writes + flush on close) ---

function currentSnapshot(): WorkspaceSnapshot {
  const { tabs, sessions, activeTabId } = useSessionStore.getState();
  return serializeWorkspace(tabs, sessions, activeTabId);
}

async function writeSnapshot(): Promise<void> {
  try {
    await setSetting(SETTING_KEYS.workspaceSnapshot, currentSnapshot());
  } catch {
    // Persistence is best-effort; never surface snapshot write failures.
  }
}

/**
 * Subscribe to workspace changes and persist the snapshot to the device-local
 * `workspace.snapshot` setting: debounced during normal use and flushed
 * immediately when the window is closing. Writes go straight through
 * `setSetting` (not React Query) so continuous snapshots never invalidate the
 * settings cache — and because the write touches no session state, it cannot
 * feed back into a persistence loop. Returns a cleanup function.
 */
export function startSnapshotPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    void writeSnapshot();
  };

  const schedule = () => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void writeSnapshot();
    }, DEBOUNCE_MS);
  };

  // Only the tabs / active tab / sessions slices affect the snapshot; ignore
  // any other store churn to avoid needless writes.
  let prevTabs = useSessionStore.getState().tabs;
  let prevActive = useSessionStore.getState().activeTabId;
  let prevSessions = useSessionStore.getState().sessions;
  const unsubscribe = useSessionStore.subscribe((state) => {
    if (
      state.tabs === prevTabs &&
      state.activeTabId === prevActive &&
      state.sessions === prevSessions
    ) {
      return;
    }
    prevTabs = state.tabs;
    prevActive = state.activeTabId;
    prevSessions = state.sessions;
    schedule();
  });

  // Persist the current state right away — including an empty snapshot when
  // there are zero tabs, so closing everything then quitting clears stale tabs.
  schedule();

  // Flush the latest snapshot before the window closes, then let the close go
  // through. Two Windows constraints shape this sequence, and satisfying only
  // one of them leaves the close button inert:
  //   1. The real close must be *deferred* (setTimeout) so it runs after this
  //      prevented close-request returns — a recursive close issued from inside
  //      the active native callback is dropped.
  //   2. The close-requested listener must be *removed* before that real close.
  //      Re-issuing the close while the listener is still registered means the
  //      request is intercepted again and silently ignored on Windows, so the
  //      window never actually closes.
  let closing = false;
  let unlistenClose: (() => void) | undefined;
  const win = getCurrentWindow();
  void win
    .onCloseRequested(async (event) => {
      if (closing) return;
      closing = true;
      event.preventDefault();
      try {
        await writeSnapshot();
        window.setTimeout(() => {
          // Detach before the final close so the re-issued request isn't
          // swallowed by this still-active listener (see note 2 above).
          unlistenClose?.();
          unlistenClose = undefined;
          void win.close().catch(() => {
            closing = false;
          });
        }, 0);
      } catch {
        // Keep shutdown retryable if either persistence or the window API
        // fails instead of leaving the close button permanently inert.
        closing = false;
      }
    })
    .then((unlisten) => {
      if (disposed) unlisten();
      else unlistenClose = unlisten;
    })
    .catch(() => {
      // onCloseRequested may be unavailable in non-Tauri contexts (tests).
    });

  // Last-ditch best-effort flush for hard reloads/navigations.
  const onBeforeUnload = () => {
    flush();
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    unlistenClose?.();
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
}
