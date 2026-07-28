import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  Cable,
  Columns2,
  Combine,
  Command,
  Loader2,
  MoreHorizontal,
  Plus,
  RadioTower,
  Save,
  ServerCog,
  SplitSquareHorizontal,
  SquarePlus,
  Rows2,
  Server,
  Users,
  X,
} from "lucide-react";
import { useCollabStore } from "../../stores/collabStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { useSessionLogStore } from "../../stores/sessionLogStore";
import { useProfiles, useShells } from "../../hooks/useShells";
import { terminalManager } from "./terminalManager";
import { collectLeaves, findLeaf } from "./paneTree";
import { cn } from "../../lib/utils";
import { DistroIcon } from "../../components/DistroIcon";
import { ContextMenu, type MenuAction } from "../../components/ContextMenu";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
import { SplitWithHostDialog } from "./SplitWithHostDialog";
import { SaveHostDialog } from "./SaveHostDialog";
import { useTabDragStore } from "../../stores/tabDragStore";
import type { SplitDirection, TerminalSession, WorkspaceTab } from "../../types";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { resolvePaneTarget } from "./tabDrop";
import {
  attachTab,
  detachTab,
  detachedTabIds,
  detachedTabsVersion,
  detachedWindowLabel,
  subscribeDetachedTabs,
  windowPositionUnderCursor,
} from "./detachedTabs";

/** Logical height of the main window's top tab strip. A detached window released
 * over this band re-docks as its own standalone tab; below it, over a pane, it
 * grafts into that pane. Mirrors the `h-10` header. */
const DOCK_STRIP_HEIGHT = 40;

/** A detached window reports its cursor as main-window client coordinates. */
type DetachedDragPoint = { tabId: string; x: number; y: number };

/** True when the drag pointer has left the window frame. Coordinates clamp at
 * the frame edge when the window is maximized, so touching an edge counts as
 * leaving — otherwise a maximized window could never tear a tab off. */
function pointerOutsideWindow(x: number, y: number): boolean {
  return (
    x <= 0 || y <= 0 || x >= window.innerWidth - 1 || y >= window.innerHeight - 1
  );
}

/** A tab is restorable (saveable as a template) when at least one of its panes
 * hosts a session with a restore descriptor. */
function tabHasRestorable(
  tab: WorkspaceTab,
  sessions: TerminalSession[],
): boolean {
  return collectLeaves(tab.root).some((leaf) =>
    sessions.some((s) => s.id === leaf.sessionId && s.restore),
  );
}

/**
 * The shared workspace action list backing both the 3-dot "Workspace options"
 * dropdown and the terminal-tab right-click menu, so they never drift apart.
 * Split/close entries are conditioned exactly like the toolbar buttons.
 */
function workspaceActions(deps: {
  openNewTab: () => void;
  splitActivePane: (direction: SplitDirection) => Promise<void>;
  closeActivePane: () => void;
  openPalette: () => void;
  hasTab: boolean;
  hasSession: boolean;
  onCloseTab?: () => void;
  /** Open the "Split with host…" picker (splits the active pane with a
   * different connection). */
  onSplitWithHost?: () => void;
  /** Save the active tab's layout as a workspace template. */
  onSaveTemplate?: () => void;
  /** Whether the active tab has anything restorable to save. */
  canSaveTemplate?: boolean;
  /** Save this tab's ephemeral quick-connect host to the host list (only offered
   * when the tab's active session is an unsaved quick-connect). */
  onSaveHost?: () => void;
  /** Merge this tab into the previous tab (tab context menu only). */
  onMergeIntoPrevious?: () => void;
}): MenuAction[] {
  const actions: MenuAction[] = [
    {
      label: "New tab",
      icon: <Plus size={15} />,
      hint: "Ctrl+Shift+T",
      onSelect: () => deps.openNewTab(),
    },
  ];
  if (deps.hasTab) {
    actions.push(
      {
        label: "Split right",
        icon: <Columns2 size={15} />,
        hint: "Ctrl+Shift+D",
        onSelect: () => void deps.splitActivePane("row"),
      },
      {
        label: "Split down",
        icon: <Rows2 size={15} />,
        hint: "Ctrl+Shift+E",
        onSelect: () => void deps.splitActivePane("column"),
      },
    );
    if (deps.onSplitWithHost) {
      actions.push({
        label: "Split with host…",
        icon: <SplitSquareHorizontal size={15} />,
        onSelect: deps.onSplitWithHost,
      });
    }
  }
  if (deps.hasSession) {
    actions.push({
      label: "Close pane",
      icon: <X size={15} />,
      hint: "Ctrl+Shift+W",
      onSelect: () => deps.closeActivePane(),
    });
  }
  if (deps.onSaveHost) {
    actions.push({ separator: true });
    actions.push({
      label: "Save host…",
      icon: <ServerCog size={15} />,
      onSelect: deps.onSaveHost,
    });
  }
  if (deps.onSaveTemplate) {
    actions.push({ separator: true });
    actions.push({
      label: "Save tab as template",
      icon: <Save size={15} />,
      disabled: deps.canSaveTemplate === false,
      onSelect: deps.onSaveTemplate,
    });
  }
  actions.push({ separator: true });
  actions.push({
    label: "Command palette",
    icon: <Command size={15} />,
    hint: "Ctrl+Shift+P",
    onSelect: () => deps.openPalette(),
  });
  if (deps.onMergeIntoPrevious || deps.onCloseTab) {
    actions.push({ separator: true });
  }
  if (deps.onMergeIntoPrevious) {
    actions.push({
      label: "Merge into previous tab",
      icon: <Combine size={15} />,
      onSelect: deps.onMergeIntoPrevious,
    });
  }
  if (deps.onCloseTab) {
    actions.push({
      label: "Close tab",
      icon: <X size={15} />,
      onSelect: deps.onCloseTab,
    });
  }
  return actions;
}

export function TabBar() {
  const tabListRef = useRef<HTMLDivElement>(null);
  const sessions = useSessionStore((s) => s.sessions);
  const tabs = useSessionStore((s) => s.tabs);
  useSyncExternalStore(subscribeDetachedTabs, detachedTabsVersion, detachedTabsVersion);
  const draggedTabId = useTabDragStore((s) => s.sourceTabId);
  const tornDrag = useTabDragStore((s) => s.torn);
  const externalDrag = useTabDragStore((s) => s.external);
  // A live-torn tab is already detached but must STAY MOUNTED (collapsed to
  // zero width) until the pointer is released: its strip element holds the
  // pointer capture that drives the rest of the gesture. Unmounting it would
  // silently end the drag.
  // A detached window hovering the strip is also still detached, but shows its
  // tab as the dimmed landing placeholder for the duration of the hover.
  const visibleTabs = tabs.filter(
    (tab) =>
      !detachedTabIds().has(tab.id) ||
      ((tornDrag || externalDrag) && tab.id === draggedTabId),
  );
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);
  const closeTab = useSessionStore((s) => s.closeTab);
  const splitActivePane = useSessionStore((s) => s.splitActivePane);
  const closeActivePane = useSessionStore((s) => s.closeActivePane);
  const mergeTabs = useSessionStore((s) => s.mergeTabs);
  const toggleBroadcast = useSessionStore((s) => s.toggleBroadcast);
  const openPalette = useUiStore((s) => s.openPalette);
  const openNewTab = useUiStore((s) => s.openNewTab);
  const closeNewTab = useUiStore((s) => s.closeNewTab);
  const selectNewTab = useUiStore((s) => s.selectNewTab);
  const newTabIds = useUiStore((s) => s.newTabIds);
  const activeNewTabId = useUiStore((s) => s.activeNewTabId);
  const openCollab = useUiStore((s) => s.openCollab);
  const collabMode = useCollabStore((s) =>
    s.runtimes.some((runtime) => runtime.ownerSessionId === activeSessionId)
      ? "hosting"
      : s.runtimes.some((runtime) => runtime.mode === "viewing")
        ? "viewing"
        : "idle",
  );
  const logs = useSessionLogStore((s) => s.logs);

  // Pointer-based drag state. Native HTML drag/drop is unreliable inside a
  // frameless WebView2 titlebar, where it competes with Tauri window dragging.
  const tabDrag = useRef<{
    pointerId: number;
    sourceId: string;
    title: string;
    startX: number;
    startY: number;
    dragging: boolean;
    targetId: string | null;
    /** Live tear-off: the tab's new OS window, moved under the cursor on every
     * pointermove (this window keeps pointer capture for the whole gesture). */
    tornWindow: WebviewWindow | null;
    /** Tear-off spawn in flight — suppresses duplicate detach calls. */
    tearing: boolean;
    /** One setPosition in flight at a time; extra moves collapse into the next. */
    tornMoveInFlight: boolean;
  } | null>(null);
  const suppressTabClick = useRef(false);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(() => new Set());
  const closeTimers = useRef(new Map<string, number>());
  const draggedTitle = useTabDragStore((s) => s.sourceTitle);
  const dragX = useTabDragStore((s) => s.x);
  const dragY = useTabDragStore((s) => s.y);
  const beginVisualDrag = useTabDragStore((s) => s.begin);
  const beginExternalDrag = useTabDragStore((s) => s.beginExternal);
  const moveVisualDrag = useTabDragStore((s) => s.move);
  const setTornDrag = useTabDragStore((s) => s.setTorn);
  const clearVisualDrag = useTabDragStore((s) => s.clear);

  useEffect(
    () => () => {
      for (const timer of closeTimers.current.values()) window.clearTimeout(timer);
    },
    [],
  );

  const closeTabWithAnimation = (tabId: string) => {
    if (closeTimers.current.has(tabId)) return;
    setClosingTabIds((current) => new Set(current).add(tabId));
    closeTimers.current.set(
      tabId,
      window.setTimeout(() => {
        closeTimers.current.delete(tabId);
        closeTab(tabId);
        setClosingTabIds((current) => {
          const next = new Set(current);
          next.delete(tabId);
          return next;
        });
      }, 140),
    );
  };

  const closeNewTabWithAnimation = (tabId: string) => {
    const timerKey = `new:${tabId}`;
    if (closeTimers.current.has(timerKey)) return;
    setClosingTabIds((current) => new Set(current).add(timerKey));
    closeTimers.current.set(
      timerKey,
      window.setTimeout(() => {
        closeTimers.current.delete(timerKey);
        closeNewTab(tabId);
        setClosingTabIds((current) => {
          const next = new Set(current);
          next.delete(timerKey);
          return next;
        });
      }, 140),
    );
  };
  // Workspace-action dialogs (Save template / Split with host). The tab whose
  // layout the save dialog serializes is captured when the action fires.
  const [saveTemplateTab, setSaveTemplateTab] = useState<WorkspaceTab | null>(null);
  const [splitHostOpen, setSplitHostOpen] = useState(false);
  // The ephemeral quick-connect session whose "Save host…" dialog is open.
  const [saveHostSession, setSaveHostSession] = useState<TerminalSession | null>(null);
  // A terminal tab is "active" only when the terminal workspace is the current
  // main view; selecting a sidebar section deselects the tabs (they stay in the
  // bar so the user can click one to return).
  const terminalActive = useUiStore((s) => s.mainView === "terminal");

  // A detached window dragged over this window drives the SAME preview an
  // in-window tab drag shows: the tab reappears in the strip as the dimmed drag
  // source, and hovering a pane renders that pane's nearest-edge split overlay.
  // Nothing commits until release. Dragging back out (leave) returns the tab to
  // its detached state without ever having snapped in.
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    let cancelled = false;
    let previewFrame = 0;
    let pendingPreview: DetachedDragPoint | null = null;
    const register = (unlisten: () => void) => {
      if (cancelled) unlisten();
      else cleanups.push(unlisten);
    };
    // Ensure the placeholder drag source is active for this tab, resolving the
    // title from its active pane. Idempotent: only (re)begins when the tab
    // changed, so it never clears a target mid-hover.
    const ensureExternal = (tabId: string) => {
      const drag = useTabDragStore.getState();
      if (drag.external && drag.sourceTabId === tabId) return true;
      const state = useSessionStore.getState();
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return false;
      const leaf = findLeaf(tab.root, tab.activePaneId);
      const title =
        state.sessions.find((s) => s.id === leaf?.sessionId)?.title ?? "Terminal";
      // The tab STAYS detached — only its placeholder appears in the strip.
      // Attaching and detaching on every frame crossing would tear down and
      // rebuild the output mirroring.
      beginExternalDrag(tabId, title);
      return true;
    };
    const updateExternalPreview = ({ tabId, x, y }: DetachedDragPoint) => {
      if (!ensureExternal(tabId)) return;
      // Above the strip band the tab re-docks as its own standalone tab: keep the
      // dimmed placeholder but clear any pane target so no split preview shows.
      if (y < DOCK_STRIP_HEIGHT) {
        moveVisualDrag(x, y, null, null, null);
        return;
      }
      const paneDrop = resolvePaneTarget(document.elementFromPoint(x, y), x, y);
      if (paneDrop) {
        moveVisualDrag(x, y, paneDrop.targetTabId, paneDrop.zone, paneDrop.targetPaneId);
      } else {
        // Inside the window but over no pane (sidebar, empty state): keep the
        // placeholder without a sticky pane preview.
        moveVisualDrag(x, y, null, null, null);
      }
    };
    void listen<DetachedDragPoint>("detached-terminal-drag-move", (event) => {
      pendingPreview = event.payload;
      if (previewFrame) return;
      previewFrame = requestAnimationFrame(() => {
        previewFrame = 0;
        const preview = pendingPreview;
        pendingPreview = null;
        if (preview) updateExternalPreview(preview);
      });
    }).then(register);
    void listen<string>("detached-terminal-drag-leave", (event) => {
      if (useTabDragStore.getState().sourceTabId !== event.payload) return;
      pendingPreview = null;
      if (previewFrame) {
        cancelAnimationFrame(previewFrame);
        previewFrame = 0;
      }
      clearVisualDrag();
    }).then(register);
    void listen<DetachedDragPoint>("detached-terminal-dock", (event) => {
      const { tabId, x, y } = event.payload;
      // Re-resolve the target from the drop coordinates rather than trusting the
      // last hovered state, which a coalesced probe may have missed.
      let committed = false;
      if (y < DOCK_STRIP_HEIGHT) {
        // attachTab clears the placeholder drag state for this tab.
        attachTab(tabId);
        committed = true;
      } else {
        const paneDrop = resolvePaneTarget(document.elementFromPoint(x, y), x, y);
        if (paneDrop && paneDrop.targetTabId !== tabId) {
          // Attach first (stops mirroring, removes the placeholder) without
          // activating, then graft the whole detached tree beside the target
          // pane — no visible standalone-tab intermediate state.
          attachTab(tabId, { activate: false });
          const direction =
            paneDrop.zone === "left" || paneDrop.zone === "right" ? "row" : "column";
          const placement =
            paneDrop.zone === "left" || paneDrop.zone === "top" ? "before" : "after";
          mergeTabs(tabId, paneDrop.targetTabId, direction, placement, paneDrop.targetPaneId);
          committed = true;
        }
      }
      if (!committed) {
        // Invalid drop inside the window: drop the preview and send no
        // acknowledgement, so the detached window stays open.
        if (useTabDragStore.getState().sourceTabId === tabId) clearVisualDrag();
        return;
      }
      void getCurrentWindow().show();
      void getCurrentWindow().setFocus();
      void emitTo(detachedWindowLabel(tabId), "detached-terminal-dock-committed", tabId);
    }).then(register);
    return () => {
      cancelled = true;
      if (previewFrame) cancelAnimationFrame(previewFrame);
      for (const cleanup of cleanups) cleanup();
    };
  }, [beginExternalDrag, clearVisualDrag, mergeTabs, moveVisualDrag]);

  // Broadcast toggle is only offered when the active tab has more than one pane.
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activePaneCount = activeTab ? collectLeaves(activeTab.root).length : 0;
  const broadcastOn = Boolean(activeTab?.broadcastEnabled) && activePaneCount > 1;

  const activeSessionOf = (tab: WorkspaceTab): TerminalSession | undefined => {
    const leaf = findLeaf(tab.root, tab.activePaneId);
    return leaf ? sessions.find((s) => s.id === leaf.sessionId) : undefined;
  };

  // Keep keyboard-selected tabs visible when the strip overflows. Mouse wheels
  // usually report vertical deltas, so translate those into horizontal motion
  // while the pointer is over the tab strip.
  useEffect(() => {
    tabListRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, terminalActive, activeNewTabId]);

  const scrollTabs = (event: React.WheelEvent<HTMLDivElement>) => {
    const tabList = event.currentTarget;
    if (
      tabList.scrollWidth <= tabList.clientWidth ||
      Math.abs(event.deltaX) >= Math.abs(event.deltaY)
    ) {
      return;
    }

    event.preventDefault();
    tabList.scrollLeft += event.deltaY;
  };

  const startTabDrag = (
    event: React.PointerEvent<HTMLDivElement>,
    tabId: string,
    title: string,
  ) => {
    if (
      event.button !== 0 ||
      (event.target as Element).closest("[data-tab-close]")
    ) {
      return;
    }

    tabDrag.current = {
      pointerId: event.pointerId,
      sourceId: tabId,
      title,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      targetId: null,
      tornWindow: null,
      tearing: false,
      tornMoveInFlight: false,
    };
    // NB: pointer capture is deliberately NOT set here. Capturing on the outer
    // wrapper makes Chromium/WebView2 retarget the subsequent compatibility
    // `click` event to the capturing element, so the inner role="tab" button's
    // onClick never fires and a plain click can no longer activate the tab.
    // Capture is instead taken once a real drag begins (see moveTabDrag).
  };

  /** Move a live-torn window so its tab-strip grab point tracks the global
   * cursor. windowPositionUnderCursor works in physical pixels, which are
   * absolute across the whole desktop — correct on any monitor and any DPI
   * mix, including when the main window is not on the primary display.
   * Coalesces to one setPosition in flight so a fast drag can't queue stale
   * moves. */
  const moveTornWindow = (drag: NonNullable<typeof tabDrag.current>) => {
    const win = drag.tornWindow;
    if (!win || drag.tornMoveInFlight) return;
    drag.tornMoveInFlight = true;
    void (async () => {
      try {
        const position = await windowPositionUnderCursor();
        if (position) await win.setPosition(position);
      } catch {
        // The window may have been closed mid-gesture (e.g. docked back).
      } finally {
        drag.tornMoveInFlight = false;
      }
    })();
  };

  const moveTabDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = tabDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (!drag.dragging) {
      const distance = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (distance < 5) return;
      drag.dragging = true;
      suppressTabClick.current = true;
      // Take pointer capture only now that the gesture is a genuine drag, so
      // pointermove keeps tracking outside the wrapper. Plain clicks never reach
      // this branch and therefore never suffer click retargeting.
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      beginVisualDrag(drag.sourceId, drag.title, event.clientX, event.clientY);
    }

    event.preventDefault();

    // Once torn, the gesture steers the new window instead of an in-app ghost.
    if (drag.tornWindow || drag.tearing) {
      // Dragging back inside the frame re-docks within the same gesture: the
      // tab returns to the strip (attachTab first, so the strip element that
      // holds pointer capture never unmounts) and the torn window closes.
      if (
        drag.tornWindow &&
        !pointerOutsideWindow(event.clientX, event.clientY)
      ) {
        const win = drag.tornWindow;
        drag.tornWindow = null;
        drag.tearing = false;
        attachTab(drag.sourceId, { activate: false });
        setTornDrag(false);
        void win.close().catch(() => {});
      } else {
        moveVisualDrag(event.clientX, event.clientY, null, null, null);
        moveTornWindow(drag);
        return;
      }
    }

    const element = document.elementFromPoint(event.clientX, event.clientY);
    const paneDrop =
      element instanceof Element
        ? resolvePaneTarget(element, event.clientX, event.clientY)
        : null;
    let targetId =
      element instanceof Element
        ? element.closest<HTMLElement>("[data-luma-tab-id]")?.dataset.lumaTabId ?? null
        : null;
    // Dragging into the terminal workspace means "group with the tab shown
    // there", the same as hovering that tab in the strip. A pane hit already
    // carries its owning tab id (see resolvePaneTarget); otherwise fall back to
    // the workspace wrapper's visible tab.
    if (!targetId && !paneDrop && element instanceof Element) {
      targetId =
        element.closest<HTMLElement>("[data-tab-drop-workspace]")?.dataset
          .tabDropWorkspace ?? null;
    }

    // Live tear-off, Chrome-style: the moment the pointer leaves the window
    // frame with no merge/group target, the tab detaches into its own window
    // which then follows the cursor for the REST of this gesture (this element
    // keeps pointer capture; each pointermove repositions the new window). The
    // header check keeps maximized windows safe — there the pointer clamps at
    // the screen edge, and a drag along the top-edge tab strip must not tear off.
    const overTitlebar =
      element instanceof Element && element.closest("header") !== null;
    if (
      !targetId &&
      !paneDrop &&
      !overTitlebar &&
      pointerOutsideWindow(event.clientX, event.clientY)
    ) {
      drag.tearing = true;
      setDragOverTabId(null);
      setTornDrag(true);
      moveVisualDrag(event.clientX, event.clientY, null, null, null);
      void detachTab(drag.sourceId, { continueDrag: true }).then((win) => {
        // The gesture may have ended (pointer released / cancelled) while the
        // window was spawning — then the window just stays where it appeared.
        const current = tabDrag.current;
        if (current?.sourceId !== drag.sourceId) {
          void win?.setFocus().catch(() => {});
          clearVisualDrag();
          return;
        }
        if (!win) {
          current.tearing = false;
          return;
        }
        current.tornWindow = win;
        moveTornWindow(current);
      });
      return;
    }
    // A pane hit on the source tab's own workspace is not a real target (you
    // can't group a tab with itself), so ignore it exactly like the strip path.
    const validPane =
      paneDrop && paneDrop.targetTabId !== drag.sourceId ? paneDrop : null;
    const effectiveTargetId = validPane?.targetTabId ?? targetId;
    // Non-sticky, like Chrome: the drop action always reflects where the
    // pointer currently is, not the last tab it happened to pass over.
    drag.targetId =
      effectiveTargetId && effectiveTargetId !== drag.sourceId ? effectiveTargetId : null;
    if (
      effectiveTargetId &&
      effectiveTargetId !== drag.sourceId &&
      useTabDragStore.getState().targetTabId !== effectiveTargetId
    ) {
      setActiveTab(effectiveTargetId);
    }
    // Only a strip tab shows the "Split" badge; a pane hit shows its overlay.
    setDragOverTabId((current) =>
      current === targetId ? current : targetId !== drag.sourceId ? targetId : null,
    );
    moveVisualDrag(
      event.clientX,
      event.clientY,
      effectiveTargetId && effectiveTargetId !== drag.sourceId ? effectiveTargetId : undefined,
      validPane?.zone ?? null,
      validPane?.targetPaneId ?? null,
    );
  };

  const finishTabDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = tabDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    tabDrag.current = null;
    setDragOverTabId(null);

    if (drag.dragging) {
      event.preventDefault();
      if (drag.tornWindow || drag.tearing) {
        // The tab already became its own window mid-drag; releasing just ends
        // the gesture and hands it focus (deferred until now — focusing during
        // the drag would break this window's pointer capture).
        void drag.tornWindow?.setFocus().catch(() => {});
        clearVisualDrag();
      } else {
        const { targetTabId, targetPaneId, zone } = useTabDragStore.getState();
        if (targetTabId && targetPaneId && zone) {
          const direction = zone === "left" || zone === "right" ? "row" : "column";
          const placement = zone === "left" || zone === "top" ? "before" : "after";
          mergeTabs(
            drag.sourceId,
            targetTabId,
            direction,
            placement,
            targetPaneId,
          );
        } else if (drag.targetId) {
          mergeTabs(drag.sourceId, drag.targetId);
        }
        clearVisualDrag();
      }
      window.setTimeout(() => {
        suppressTabClick.current = false;
      }, 0);
    }
  };

  const cancelTabDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = tabDrag.current;
    if (drag?.pointerId !== event.pointerId) return;
    // A cancel after tear-off leaves the already-created window where it is.
    void drag.tornWindow?.setFocus().catch(() => {});
    tabDrag.current = null;
    suppressTabClick.current = false;
    setDragOverTabId(null);
    clearVisualDrag();
  };

  return (
    <>
    <div
      className="flex h-full min-w-0 flex-1 items-center gap-1"
    >
      <div
        ref={tabListRef}
        role="tablist"
        aria-label="Terminal tabs"
        onWheel={scrollTabs}
        className="flex min-w-0 flex-1 touch-pan-x items-center gap-1 overflow-x-auto overflow-y-hidden"
      >
        {visibleTabs.map((tab, index) => {
          const session = activeSessionOf(tab);
          const active = tab.id === activeTabId && terminalActive && !activeNewTabId;
          const title = session?.title ?? "Terminal";
          // Best-effort cwd tooltip from shell integration (OSC 7 / OSC 1337).
          // Read outside React; refreshed on any tab re-render.
          const cwd = session ? terminalManager.getCwd(session.id) : null;
          const tabTooltip = cwd ? `${title} — ${cwd}` : title;
          const leaves = collectLeaves(tab.root);
          const paneCount = leaves.length;
          // Per-host tab accent, carried into session metadata at spawn time.
          const tabColor = session?.tabColor ?? null;
          const isLogging = leaves.some((l) => logs[l.sessionId]?.active);
          const isDropTarget = dragOverTabId === tab.id;
          const isDragging = draggedTabId === tab.id;
          const tabActions = workspaceActions({
            openNewTab,
            splitActivePane,
            closeActivePane,
            openPalette,
            hasTab: true,
            hasSession: Boolean(session),
            onCloseTab: () => closeTabWithAnimation(tab.id),
            onSplitWithHost: () => setSplitHostOpen(true),
            onSaveTemplate: () => setSaveTemplateTab(tab),
            canSaveTemplate: tabHasRestorable(tab, sessions),
            // Offer "Save host…" only for an unsaved quick-connect session.
            onSaveHost:
              session?.type === "ssh" && session.hostEphemeral && session.hostId
                ? () => setSaveHostSession(session)
                : undefined,
            // Only offer merge when there is a previous tab to merge into.
            onMergeIntoPrevious:
              index > 0
                ? () => mergeTabs(tab.id, visibleTabs[index - 1].id)
                : undefined,
          });
          return (
            <ContextMenu
              key={tab.id}
              actions={tabActions}
              minWidth="min-w-52"
              // Activating the tab first makes Split/Close pane target it,
              // matching the toolbar buttons that act on the active tab.
              onOpenChange={(open) => {
                if (open) setActiveTab(tab.id);
              }}
            >
            <div
              role="presentation"
              data-luma-tab-id={tab.id}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => startTabDrag(event, tab.id, title)}
              onPointerMove={moveTabDrag}
              onPointerUp={finishTabDrag}
              onPointerCancel={cancelTabDrag}
              className={cn(
                "group flex h-7 min-w-32 max-w-52 shrink-0 touch-none cursor-grab items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors active:cursor-grabbing",
                "luma-tab-enter",
                closingTabIds.has(tab.id) && "luma-tab-exit pointer-events-none",
                active
                  ? "bg-raised text-foreground shadow-sm"
                  : "bg-raised/45 text-muted hover:bg-raised/75 hover:text-foreground",
                isDropTarget &&
                  "bg-raised ring-2 ring-inset ring-accent",
                // While dragging, the ghost represents the tab; the original
                // dims in place, and collapses out of the strip once the tab
                // tears off into its own window, like Chrome. Width collapse
                // (not display:none / unmount) keeps pointer capture alive on
                // this element for the rest of the gesture. An external drag
                // (a detached window hovering the strip) keeps the dimmed
                // placeholder visible instead: it marks where the tab will land
                // and must not react to a pointer this window doesn't own.
                isDragging &&
                  (tornDrag
                    ? "pointer-events-none min-w-0 max-w-0 overflow-hidden border-0 px-0 opacity-0 transition-all duration-150"
                    : externalDrag
                      ? "pointer-events-none opacity-40 transition-all duration-150"
                      : "opacity-40 transition-all duration-150"),
              )}
            >
              {tabColor && (
                <span
                  aria-hidden="true"
                  className="h-4 w-0.5 shrink-0 rounded-full"
                  style={{ backgroundColor: tabColor }}
                />
              )}
              <button
                type="button"
                role="tab"
                title={tabTooltip}
                aria-selected={active}
                aria-current={active ? "page" : undefined}
                onClick={(event) => {
                  if (suppressTabClick.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  setActiveTab(tab.id);
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1.5 text-left"
              >
                <TabIcon session={session} />
                <span className="truncate">{title}</span>
                {session?.type === "ssh" &&
                  session.status === "connected" &&
                  typeof session.latencyMs === "number" && (
                    <LatencyChip latencyMs={session.latencyMs} />
                  )}
                {isLogging && (
                  <span
                    aria-label="Session logging active"
                    title="Session logging active"
                    className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-danger"
                  />
                )}
                {isDropTarget && (
                  <span className="flex shrink-0 items-center gap-1 rounded bg-accent px-1.5 text-[10px] font-semibold leading-4 text-white shadow-sm">
                    <Combine size={10} /> Split
                  </span>
                )}
                {paneCount > 1 && (
                  <span
                    aria-label={`${paneCount} panes`}
                    title={`${paneCount} panes`}
                    className="shrink-0 rounded bg-accent/15 px-1 text-[10px] font-medium leading-4 text-accent"
                  >
                    {paneCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                data-tab-close
                aria-label={`Close ${title}`}
                onClick={() => closeTabWithAnimation(tab.id)}
                className={cn(
                  "shrink-0 rounded p-0.5 hover:bg-raised hover:text-danger",
                  active ? "" : "invisible group-hover:visible",
                )}
              >
                <X size={13} />
              </button>
            </div>
            </ContextMenu>
          );
        })}
        {newTabIds.map((tabId) => (
          <div
            key={tabId}
            role="presentation"
            onDoubleClick={(event) => event.stopPropagation()}
            className={cn(
              "luma-tab-enter group flex h-7 min-w-32 max-w-52 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs",
              tabId === activeNewTabId
                ? "bg-raised text-foreground shadow-sm"
                : "bg-raised/45 text-muted hover:bg-raised/75 hover:text-foreground",
              closingTabIds.has(`new:${tabId}`) &&
                "luma-tab-exit pointer-events-none",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tabId === activeNewTabId}
              aria-current={tabId === activeNewTabId ? "page" : undefined}
              onClick={() => selectNewTab(tabId)}
              className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1.5 text-left"
            >
              <SquarePlus size={13} className="shrink-0 text-accent" />
              <span className="truncate">New tab</span>
            </button>
            <button
              type="button"
              aria-label="Close New tab"
              onClick={() => closeNewTabWithAnimation(tabId)}
              className="shrink-0 rounded p-0.5 hover:bg-surface hover:text-danger"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label="New tab"
          title="New tab (Ctrl+Shift+T)"
          onClick={openNewTab}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-foreground"
        >
          <Plus size={15} />
        </button>
      </div>
      {draggedTabId && !tornDrag && !externalDrag && (() => {
        const draggedTab = tabs.find((t) => t.id === draggedTabId);
        const draggedSession = draggedTab ? activeSessionOf(draggedTab) : undefined;
        const draggedColor = draggedSession?.tabColor ?? null;
        // Chrome-style drag preview: a lone tab follows the cursor. Once the
        // pointer leaves the frame the tab tears off into a REAL window that
        // takes over as the preview, so no ghost is drawn in the torn state.
        return (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed z-[100]"
            style={{ left: dragX - 88, top: dragY - 14 }}
          >
            <div className="flex h-7 w-44 items-center gap-1.5 rounded-lg border border-border/60 bg-raised px-2.5 text-xs text-foreground shadow-lg">
              {draggedColor && (
                <span
                  aria-hidden="true"
                  className="h-4 w-0.5 shrink-0 rounded-full"
                  style={{ backgroundColor: draggedColor }}
                />
              )}
              <TabIcon session={draggedSession} />
              <span className="min-w-0 flex-1 truncate">{draggedTitle}</span>
            </div>
          </div>
        );
      })()}

      <div
        onDoubleClick={(event) => event.stopPropagation()}
        className="flex shrink-0 items-center"
      >
        {terminalActive && activePaneCount > 1 && (
          <button
            type="button"
            aria-label={broadcastOn ? "Disable broadcast input" : "Enable broadcast input"}
            aria-pressed={broadcastOn}
            title="Broadcast input to all panes (Ctrl+Shift+B)"
            onClick={() => activeTabId && toggleBroadcast(activeTabId)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              broadcastOn
                ? "bg-accent/15 text-accent hover:bg-accent/25"
                : "text-muted hover:bg-raised hover:text-foreground",
            )}
          >
            <RadioTower size={15} />
          </button>
        )}
        <button
          type="button"
          aria-label={collabMode === "idle" ? "Collaborate" : "Collaboration active"}
          aria-pressed={collabMode !== "idle"}
          title="Share or join a collaborative terminal"
          onClick={() => openCollab()}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
            collabMode !== "idle"
              ? "bg-accent/15 text-accent hover:bg-accent/25"
              : "text-muted hover:bg-raised hover:text-foreground",
          )}
        >
          <Users size={15} />
        </button>
        <WorkspaceMenu
          onSplitWithHost={() => setSplitHostOpen(true)}
          onSaveTemplate={() => {
            const tab = tabs.find((t) => t.id === activeTabId);
            if (tab) setSaveTemplateTab(tab);
          }}
        >
          <button
            type="button"
            aria-label="Workspace options"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-foreground data-[state=open]:bg-raised data-[state=open]:text-foreground"
          >
            <MoreHorizontal size={15} />
          </button>
        </WorkspaceMenu>
      </div>
    </div>
    <SaveTemplateDialog
      open={saveTemplateTab !== null}
      onOpenChange={(open) => {
        if (!open) setSaveTemplateTab(null);
      }}
      tab={saveTemplateTab}
    />
    <SplitWithHostDialog open={splitHostOpen} onOpenChange={setSplitHostOpen} />
    <SaveHostDialog
      session={saveHostSession}
      onOpenChange={(open) => {
        if (!open) setSaveHostSession(null);
      }}
    />
    </>
  );
}

/** The three-dots "Workspace options" dropdown. Mirrors NewTerminalMenu's
 * Radix pattern/styling and exposes the same workspace actions as the standalone
 * toolbar buttons and their keyboard chords. Split/close items only appear when
 * a tab/session exists, matching how the toolbar buttons are conditioned. */
function WorkspaceMenu({
  children,
  onSplitWithHost,
  onSaveTemplate,
}: {
  children: React.ReactNode;
  onSplitWithHost: () => void;
  onSaveTemplate: () => void;
}) {
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const splitActivePane = useSessionStore((s) => s.splitActivePane);
  const closeActivePane = useSessionStore((s) => s.closeActivePane);
  const sessions = useSessionStore((s) => s.sessions);
  const activeTab = useSessionStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId),
  );
  const openNewTab = useUiStore((s) => s.openNewTab);
  const openPalette = useUiStore((s) => s.openPalette);

  const actions = workspaceActions({
    openNewTab,
    splitActivePane,
    closeActivePane,
    openPalette,
    hasTab: Boolean(activeTabId),
    hasSession: Boolean(activeSessionId),
    onSplitWithHost: activeTabId ? onSplitWithHost : undefined,
    onSaveTemplate: activeTab ? onSaveTemplate : undefined,
    canSaveTemplate: activeTab ? tabHasRestorable(activeTab, sessions) : false,
  });

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-52 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow"
        >
          {actions.map((action, index) =>
            "separator" in action && action.separator ? (
              <DropdownMenu.Separator
                key={`sep-${index}`}
                className="my-1 h-px bg-border"
              />
            ) : (
              <DropdownMenu.Item
                key={action.label}
                onSelect={action.onSelect}
                className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface data-[highlighted]:text-accent"
              >
                <span className="shrink-0 text-muted">{action.icon}</span>
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                {action.hint && (
                  <span className="shrink-0 text-xs text-muted">{action.hint}</span>
                )}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Latency thresholds → chip tone. Mirrors reconnect.latencyTone but returns the
 * Tailwind class directly for the small "12 ms" chip in the tab. */
function latencyChipClass(latencyMs: number): string {
  if (latencyMs < 80) return "bg-raised/60 text-muted";
  if (latencyMs < 300) return "bg-amber-500/15 text-amber-400";
  return "bg-danger/15 text-danger";
}

/** Subtle latency chip shown on connected SSH tabs and pane title bars. */
export function LatencyChip({ latencyMs }: { latencyMs: number }) {
  return (
    <span
      title={`Round-trip latency: ${latencyMs} ms`}
      className={cn(
        "shrink-0 rounded px-1 text-[10px] font-medium leading-4 tabular-nums",
        latencyChipClass(latencyMs),
      )}
    >
      {latencyMs} ms
    </span>
  );
}

export function TabIcon({ session }: { session: TerminalSession | undefined }) {
  if (!session) return null;
  // Reconnect state layers over the normal status so a dropped SSH session reads
  // as "reconnecting" (amber spinner) or "failed" (red dot) at a glance.
  if (session.connectionState === "reconnecting") {
    return (
      <Loader2
        aria-label="Reconnecting"
        size={12}
        className="shrink-0 animate-spin text-amber-400"
      />
    );
  }
  if (session.connectionState === "failed") {
    return (
      <span
        aria-label="Reconnect failed"
        title="Reconnect failed"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
      />
    );
  }
  if (session.status === "connecting") {
    return <Loader2 size={12} className="shrink-0 animate-spin text-accent" />;
  }
  if (session.type === "ssh" || session.type === "serial") {
    // A live/previously-authenticated SSH session shows the detected distro logo
    // in place of the generic server icon. Error sessions keep the danger server
    // (an error usually means auth never completed, so no distro was detected);
    // a disconnected session keeps its logo but dimmed. "unknown" and undetected
    // ids fall through to the generic server icon below.
    if (
      session.type === "ssh" &&
      session.osId &&
      session.osId !== "unknown" &&
      (session.status === "connected" || session.status === "disconnected")
    ) {
      return (
        <DistroIcon
          osId={session.osId}
          size={13}
          label={session.osPrettyName ?? undefined}
          className={cn(
            "shrink-0",
            session.status === "disconnected" && "opacity-50 grayscale",
          )}
        />
      );
    }
    const Icon = session.type === "serial" ? Cable : Server;
    return (
      <Icon
        size={12}
        className={cn(
          "shrink-0",
          session.status === "error"
            ? "text-danger"
            : session.status === "disconnected"
              ? "text-muted"
              : "text-accent",
        )}
      />
    );
  }
  if (session.status === "disconnected") {
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted" />;
  }
  if (session.status === "error") {
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />;
  }
  return null;
}

export function NewTerminalMenu({ children }: { children: React.ReactNode }) {
  const openLocalSession = useSessionStore((s) => s.openLocalSession);
  const { data: shells } = useShells();
  const { data: profiles } = useProfiles();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-44 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow"
        >
          {(shells ?? []).map((shell) => (
            <DropdownMenu.Item
              key={shell.id}
              onSelect={() =>
                void openLocalSession({ kind: "shell", id: shell.id }, shell.name)
              }
              className="cursor-default rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface data-[highlighted]:text-accent"
            >
              {shell.name}
            </DropdownMenu.Item>
          ))}
          {(profiles?.length ?? 0) > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className="px-2.5 py-1 text-xs uppercase tracking-wider text-muted">
                Profiles
              </DropdownMenu.Label>
              {(profiles ?? []).map((profile) => (
                <DropdownMenu.Item
                  key={profile.id}
                  onSelect={() =>
                    void openLocalSession({ kind: "profile", id: profile.id }, profile.name)
                  }
                  className="cursor-default rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface data-[highlighted]:text-accent"
                >
                  {profile.name}
                </DropdownMenu.Item>
              ))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
