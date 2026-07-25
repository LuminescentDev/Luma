import { useEffect, useMemo, useRef } from "react";
import { emitTo } from "@tauri-apps/api/event";
import {
  cursorPosition,
  getCurrentWindow,
  Window as TauriWindow,
} from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { terminalManager } from "./terminalManager";
import { PaneTreeView } from "./PaneTreeView";
import { TabIcon } from "./TabBar";
import { useSessionStore } from "../../stores/sessionStore";
import type { DetachedTabSnapshot } from "./detachedTabs";
import { collectLeaves, findLeaf } from "./paneTree";

/** Convert a global PHYSICAL cursor position into LOGICAL client coordinates of
 * the main window's inner (webview) area — the same space as `document`'s
 * clientX/clientY, so the main window can hit-test panes and its tab strip. All
 * inputs are physical pixels, the only representation unambiguous across monitors
 * that each carry their own scale factor. `main` is the inner rect from
 * innerPosition/innerSize. Returns null when the cursor is outside that rect, so
 * a point exactly on the right/bottom edge (>= extent) reads as outside. */
export function mainClientPoint(
  cursor: { x: number; y: number },
  main: { x: number; y: number; width: number; height: number; scaleFactor: number },
): { x: number; y: number } | null {
  if (
    cursor.x < main.x ||
    cursor.x >= main.x + main.width ||
    cursor.y < main.y ||
    cursor.y >= main.y + main.height
  ) {
    return null;
  }
  return {
    x: (cursor.x - main.x) / main.scaleFactor,
    y: (cursor.y - main.y) / main.scaleFactor,
  };
}

type MainWindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
};

async function mainWindowRect(): Promise<MainWindowRect | null> {
  try {
    const main = await TauriWindow.getByLabel("main");
    if (!main || (await main.isMinimized())) return null;
    const [position, size, scaleFactor] = await Promise.all([
      main.innerPosition(),
      main.innerSize(),
      main.scaleFactor(),
    ]);
    return {
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
      scaleFactor,
    };
  } catch {
    return null;
  }
}

/** The global cursor as logical client coordinates of the main window, or null
 * when the cursor is off the main window (or it is minimized). This is the drop
 * point the user is aiming, rather than the detached window's origin. */
async function cursorInMainClient(
  cachedRect?: MainWindowRect | null,
): Promise<{ x: number; y: number } | null> {
  try {
    const [cursor, rect] = await Promise.all([
      cursorPosition(),
      cachedRect === undefined ? mainWindowRect() : Promise.resolve(cachedRect),
    ]);
    return rect ? mainClientPoint(cursor, rect) : null;
  } catch {
    return null;
  }
}

export function DetachedTerminalWindow() {
  const params = new URLSearchParams(location.search);
  const tabId = params.get("detached") ?? "";
  const title = params.get("title") ?? "Terminal";
  // getCurrentWindow() builds a fresh handle each call; memoize so it is a stable
  // effect dependency (the handle is just a label wrapper, not live state).
  const win = useMemo(() => getCurrentWindow(), []);
  const windowFocused = useRef(false);
  const focusedAt = useRef(0);
  const cachedMainRect = useRef<MainWindowRect | null>(null);
  const dragging = useRef(false);
  /** The window has actually moved since the drag began. WebView2 can deliver a
   * synthetic pointerup the moment startDragging() hands the gesture to the OS
   * move loop; requiring a move first keeps that from reading as a release. */
  const dragMoved = useRef(false);
  /** Whether the last probe found the cursor inside the main window, so a
   * leave is emitted exactly once when it exits. */
  const overMain = useRef(false);
  const detachedTab = useSessionStore((state) => state.tabs[0] ?? null);
  const detachedSessions = useSessionStore((state) => state.sessions);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void win.isFocused().then((focused) => {
      if (!cancelled) windowFocused.current = focused;
    }).catch(() => {});
    void win.onFocusChanged(({ payload: focused }) => {
      windowFocused.current = focused;
      if (focused) focusedAt.current = Date.now();
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [win]);

  useEffect(() => {
    void mainWindowRect().then((rect) => {
      cachedMainRect.current = rect;
    });
  }, []);

  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const displayIds: string[] = [];
    let cancelled = false;
    const onOutput = (event: { payload: { sessionId: string; data: number[] } }) => {
      if (cancelled) return;
      terminalManager.writeOutput(event.payload.sessionId, new Uint8Array(event.payload.data));
    };
    const onSnapshot = (event: { payload: DetachedTabSnapshot }) => {
      // A discarded StrictMode mount registers its listeners with Tauri before
      // its cleanup runs, so it can still receive the snapshot the surviving
      // mount asked for and replay the scrollback a second time.
      if (cancelled) return;
      const next = event.payload;
      // This window owns exactly one tab; adopting another one's snapshot would
      // replace its store state and make it a duplicate of that window.
      if (next.tab.id !== tabId) return;
      for (const session of next.sessions) {
        displayIds.push(session.id);
        terminalManager.createDisplaySession(session.id, {
          onInput: (data) => void emitTo("main", "detached-terminal-input", {
            sessionId: session.id,
            data,
          }),
          // Forward window-driven refits to the main window, which mirrors the
          // size onto the hidden source terminal and its backend PTY, so the
          // shell reflows for this window instead of the old pane.
          onResize: (cols, rows) => void emitTo("main", "detached-terminal-resize", {
            sessionId: session.id,
            cols,
            rows,
          }),
        });
        // Match the source grid before replaying its buffer so the snapshot
        // wraps exactly as it did in the main window; the mount's fit() then
        // reflows it (and the PTY, via onResize) to this window's real size.
        const dims = next.dims[session.id];
        if (dims) terminalManager.resizeTerminal(session.id, dims.cols, dims.rows);
        // Clear first so applying a snapshot is idempotent: the main window
        // answers every "ready" with a fresh snapshot, and a display session can
        // outlive the mount that created it (createDisplaySession no-ops when
        // the id already exists), so without this the scrollback would replay on
        // top of itself.
        terminalManager.resetOutput(session.id);
        terminalManager.writeOutput(session.id, next.buffers[session.id] ?? "");
      }
      const activeSessionId = findLeaf(next.tab.root, next.tab.activePaneId)?.sessionId ?? null;
      useSessionStore.setState({
        tabs: [next.tab],
        sessions: next.sessions,
        activeTabId: next.tab.id,
        activeSessionId,
      });
    };
    // Scoped to THIS window (target { kind: "Window", label }), never the global
    // `listen`: the main window addresses each detached window by label, but a
    // global listener also receives the snapshots and output meant for its
    // siblings — which made an existing popout adopt the next one's tab and
    // mirror it. emitTo's AnyLabel target matches a per-window listener.
    void Promise.all([
      win.listen<{ sessionId: string; data: number[] }>("detached-terminal-output", onOutput),
      win.listen<DetachedTabSnapshot>("detached-terminal-snapshot", onSnapshot),
    ]).then(async (registered) => {
      if (cancelled) {
        for (const cleanup of registered) cleanup();
        return;
      }
      cleanups.push(...registered);
      await emitTo("main", "detached-terminal-ready", tabId);
    });
    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
      for (const id of displayIds) terminalManager.dispose(id);
    };
  }, [tabId, win]);

  // Dragging this window over the main window does NOT dock it live. It reports
  // the cursor as main-window client coordinates so the main window can render
  // the same nearest-edge split preview it shows for an in-window tab drag (and
  // the dimmed standalone-tab placeholder while over the top strip), all while
  // this window keeps following the cursor so the user can pull it back out.
  // Only releasing commits: the drop coordinates are sent to the main window,
  // which re-resolves the target and, on a valid top-strip or pane drop,
  // acknowledges with `detached-terminal-dock-committed`. This window closes
  // only on that acknowledgement, so an invalid drop leaves it open.
  //
  // The OS move loop swallows the real mouseup: startDragging() hands the
  // gesture to Windows, which returns control only once the button is already
  // up, so the release is detected from the first subsequent event reporting no
  // buttons held. Both listeners are on this window, which is where the release
  // lands — the titlebar being dragged sits under the cursor throughout.
  useEffect(() => {
    let closed = false;
    const endDrag = () => {
      if (!dragging.current) return;
      const moved = dragMoved.current;
      dragging.current = false;
      dragMoved.current = false;
      const wasOverMain = overMain.current;
      overMain.current = false;
      if (!moved) return;
      // Re-test rather than trusting the last hover: a coalesced probe may have
      // dropped the final move, and the drop target is whatever is under the
      // cursor at release.
      void cursorInMainClient().then(async (point) => {
        if (!point) {
          if (wasOverMain) await emitTo("main", "detached-terminal-drag-leave", tabId);
          return;
        }
        // Wait for the main window's acknowledgement (see the committed listener
        // below) before closing; an invalid drop sends none and leaves this
        // window open.
        await emitTo("main", "detached-terminal-dock", { tabId, x: point.x, y: point.y });
      });
    };
    const onPointerUp = () => endDrag();
    const onPointerMove = (event: PointerEvent) => {
      if (event.buttons === 0) endDrag();
    };
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointermove", onPointerMove);

    // One hit-test in flight at a time; a move arriving mid-probe is retained as
    // a single pending probe so the preview still follows a fast drag without
    // queueing stale, out-of-order enter/leave/move emissions.
    let probing = false;
    let pending = false;
    const probe = () => {
      if (probing) {
        pending = true;
        return;
      }
      probing = true;
      void cursorInMainClient(cachedMainRect.current)
        .then((point) => {
          if (!dragging.current) return;
          if (point) {
            overMain.current = true;
            void emitTo("main", "detached-terminal-drag-move", {
              tabId,
              x: point.x,
              y: point.y,
            });
          } else if (overMain.current) {
            overMain.current = false;
            void emitTo("main", "detached-terminal-drag-leave", tabId);
          }
        })
        .finally(() => {
          probing = false;
          if (pending && dragging.current) {
            pending = false;
            probe();
          } else {
            pending = false;
          }
        });
    };

    // A discarded StrictMode mount can resolve its async listen()/onMoved()
    // registrations after cleanup has already run; register unlistens through a
    // cancelled guard so a late resolution unlistens immediately instead of
    // leaking (mirrors the snapshot effect above).
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const register = (cleanup: () => void) => {
      if (cancelled) cleanup();
      else cleanups.push(cleanup);
    };
    void win.onMoved(() => {
      if (!dragging.current) return;
      dragMoved.current = true;
      probe();
    }).then(register);
    // Window-scoped like the snapshot listeners above: the main window
    // acknowledges one specific popout, and a global listener would also fire in
    // every sibling window.
    void win.listen<string>("detached-terminal-dock-committed", (event) => {
      if (event.payload !== tabId) return;
      closed = true;
      void win.close();
    }).then(register);

    return () => {
      cancelled = true;
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
      for (const cleanup of cleanups) cleanup();
      // A window closed mid-drag must not leave a stale placeholder behind.
      if (!closed && dragging.current && overMain.current) {
        void emitTo("main", "detached-terminal-drag-leave", tabId);
      }
    };
  }, [tabId, win]);

  const activeSession = detachedTab
    ? detachedSessions.find(
        (session) =>
          session.id === findLeaf(detachedTab.root, detachedTab.activePaneId)?.sessionId,
      )
    : undefined;
  const liveTitle = activeSession?.title ?? title;
  const paneCount = detachedTab ? collectLeaves(detachedTab.root).length : 0;
  const tabColor = activeSession?.tabColor ?? null;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Titlebar mirrors the main window's tab strip so the torn-off tab keeps
          its identity (icon, accent, pane count) in the new window. */}
      <header onMouseDown={(event) => {
        const wasJustFocused = Date.now() - focusedAt.current < 250;
        if (
          event.button === 0 &&
          windowFocused.current &&
          !wasJustFocused &&
          !(event.target as Element).closest("button")
        ) {
          void mainWindowRect().then((rect) => {
            cachedMainRect.current = rect;
          });
          dragging.current = true;
          dragMoved.current = false;
          void win.startDragging();
        }
      }} className="flex h-10 shrink-0 select-none items-center gap-1 border-b border-border bg-surface pl-1.5">
        <div className="pointer-events-none flex h-7 min-w-0 max-w-52 items-center gap-1.5 rounded-lg bg-raised px-2.5 text-xs text-foreground shadow-sm">
          {tabColor && (
            <span
              aria-hidden="true"
              className="h-4 w-0.5 shrink-0 rounded-full"
              style={{ backgroundColor: tabColor }}
            />
          )}
          <TabIcon session={activeSession} />
          <span className="truncate">{liveTitle}</span>
          {paneCount > 1 && (
            <span
              aria-label={`${paneCount} panes`}
              className="shrink-0 rounded bg-accent/15 px-1 text-[10px] font-medium leading-4 text-accent"
            >
              {paneCount}
            </span>
          )}
        </div>
        <span className="min-w-0 flex-1 self-stretch" />
        <button aria-label="Minimize" onClick={() => void win.minimize()} className="flex h-full w-10 items-center justify-center text-muted hover:bg-raised hover:text-foreground"><Minus size={15} /></button>
        <button aria-label="Maximize or restore" onClick={() => void win.toggleMaximize()} className="flex h-full w-10 items-center justify-center text-muted hover:bg-raised hover:text-foreground"><Square size={12} /></button>
        <button aria-label="Close" onClick={() => void win.close()} className="flex h-full w-10 items-center justify-center text-muted hover:bg-danger hover:text-white"><X size={15} /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {detachedTab && <PaneTreeView tab={detachedTab} sessions={detachedSessions} />}
      </div>
    </div>
  );
}
