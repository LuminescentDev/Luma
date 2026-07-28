import { useRef } from "react";
import type {
  PaneNode,
  SplitDirection,
  TerminalSession,
  WorkspaceTab,
} from "../../types";
import { useSessionStore } from "../../stores/sessionStore";
import { PaneView } from "./PaneView";
import { PaneTitleBar } from "./PaneTitleBar";
import { useTabDragStore } from "../../stores/tabDragStore";
import { resolvePaneTarget } from "./tabDrop";
import {
  attachTab,
  detachTab,
  windowPositionUnderCursor,
} from "./detachedTabs";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cn } from "../../lib/utils";

/*
 * Renders a tab's split tree. Splits become flex containers whose children are
 * weighted by their size (flex-grow), separated by draggable dividers that
 * resize the two adjacent panes. Leaf nodes render a PaneView.
 */
export function PaneTreeView({
  tab,
  sessions,
}: {
  tab: WorkspaceTab;
  sessions: TerminalSession[];
}) {
  const leafCount = countLeaves(tab.root);
  const sourceTabId = useTabDragStore((s) => s.sourceTabId);
  const sourcePaneId = useTabDragStore((s) => s.sourcePaneId);
  const targetTabId = useTabDragStore((s) => s.targetTabId);
  // A tab drag previews only over the tab it would merge into. A pane drag can
  // land on any pane, including one in its own tab, so it previews as soon as
  // the gesture starts — there is nothing to "enter" first.
  const showDropPreview = Boolean(
    sourceTabId && (sourcePaneId ? leafCount > 1 : targetTabId === tab.id),
  );
  const dragSurfaceRef = useRef<HTMLDivElement>(null);
  const paneDrag = usePaneDrag(tab.id, dragSurfaceRef);
  return (
    <div
      ref={dragSurfaceRef}
      onPointerMove={paneDrag.onPointerMove}
      onPointerUp={paneDrag.onPointerUp}
      onPointerCancel={paneDrag.onPointerCancel}
      className="relative h-full w-full p-1"
    >
      <PaneNodeView
        node={tab.root}
        tab={tab}
        sessions={sessions}
        multiPane={leafCount > 1}
        showDropPreview={showDropPreview}
        paneDrag={paneDrag}
      />
    </div>
  );
}

type PaneDragHandlers = {
  sourcePaneId: string | null;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
  handlers: (paneId: string, title: string) => {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  };
};

/*
 * Pointer-driven pane dragging, mirroring TabBar's tab drag: no capture on
 * pointerdown (it retargets the compatibility click and would swallow the
 * header's buttons), capture once the gesture passes the movement threshold.
 * Targets are resolved live from `data-tab-drop-pane`, so a pane can be dropped
 * onto any pane in any tab of this window; dropping on the tab strip promotes
 * the pane into a tab of its own.
 */
function usePaneDrag(
  tabId: string,
  dragSurfaceRef: React.RefObject<HTMLDivElement | null>,
): PaneDragHandlers {
  const movePaneToPane = useSessionStore((s) => s.movePaneToPane);
  const detachPaneToTab = useSessionStore((s) => s.detachPaneToTab);
  const sourcePaneId = useTabDragStore((s) => s.sourcePaneId);
  const drag = useRef<{
    pointerId: number;
    paneId: string;
    title: string;
    startX: number;
    startY: number;
    dragging: boolean;
    sourceTabId: string;
    detachedTabId: string | null;
    tornWindow: WebviewWindow | null;
    tearing: boolean;
    tornMoveInFlight: boolean;
  } | null>(null);

  const moveTornWindow = (current: NonNullable<typeof drag.current>) => {
    if (!current.tornWindow || current.tornMoveInFlight) return;
    current.tornMoveInFlight = true;
    const win = current.tornWindow;
    void (async () => {
      try {
        const position = await windowPositionUnderCursor();
        if (position) await win.setPosition(position);
      } catch {
        // The window may have re-docked or closed while a move was in flight.
      } finally {
        current.tornMoveInFlight = false;
      }
    })();
  };

  const handlers = (paneId: string, title: string) => ({
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      drag.current = {
        pointerId: event.pointerId,
        paneId,
        title,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
        sourceTabId: tabId,
        detachedTabId: null,
        tornWindow: null,
        tearing: false,
        tornMoveInFlight: false,
      };
    },
  });

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;

      if (!current.dragging) {
        const distance = Math.hypot(
          event.clientX - current.startX,
          event.clientY - current.startY,
        );
        if (distance < 5) return;
        current.dragging = true;
        const dragSurface = dragSurfaceRef.current;
        if (dragSurface && !dragSurface.hasPointerCapture(event.pointerId)) {
          dragSurface.setPointerCapture(event.pointerId);
        }
        useTabDragStore
          .getState()
          .beginPane(tabId, current.paneId, current.title, event.clientX, event.clientY);
      }
      event.preventDefault();

      const outside =
        event.clientX <= 0 ||
        event.clientY <= 0 ||
        event.clientX >= window.innerWidth - 1 ||
        event.clientY >= window.innerHeight - 1;

      if (current.tornWindow || current.tearing) {
        if (current.tornWindow && !outside && current.detachedTabId) {
          const win = current.tornWindow;
          current.tornWindow = null;
          current.tearing = false;
          attachTab(current.detachedTabId, { activate: false });
          void win.close().catch(() => {});
        } else {
          moveTornWindow(current);
          return;
        }
      }

      const element = document.elementFromPoint(event.clientX, event.clientY);
      const drop = resolvePaneTarget(element, event.clientX, event.clientY);
      // A pane can't be dropped onto itself; keep the preview clear instead of
      // showing a split that would be a no-op.
      const valid = drop && drop.targetPaneId !== current.paneId ? drop : null;
      useTabDragStore
        .getState()
        .move(
          event.clientX,
          event.clientY,
          valid?.targetTabId ?? null,
          valid?.zone ?? null,
          valid?.targetPaneId ?? null,
        );
      if (!valid && outside && !current.detachedTabId) {
        const newTabId = detachPaneToTab(current.sourceTabId, current.paneId, {
          activate: false,
        });
        if (!newTabId) return;
        current.sourceTabId = newTabId;
        current.detachedTabId = newTabId;
        current.tearing = true;
        useTabDragStore
          .getState()
          .beginPane(newTabId, current.paneId, current.title, event.clientX, event.clientY);
        void detachTab(newTabId, { continueDrag: true }).then((win) => {
          const active = drag.current;
          if (active !== current) {
            void win?.setFocus().catch(() => {});
            return;
          }
          if (!win) {
            current.tearing = false;
            return;
          }
          current.tornWindow = win;
          moveTornWindow(current);
        });
      }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const dragSurface = dragSurfaceRef.current;
      if (dragSurface?.hasPointerCapture(event.pointerId)) {
        dragSurface.releasePointerCapture(event.pointerId);
      }
      drag.current = null;
      if (!current.dragging) return;
      event.preventDefault();
      if (current.tornWindow || current.tearing) {
        void current.tornWindow?.setFocus().catch(() => {});
        useTabDragStore.getState().clear();
        return;
      }

      const state = useTabDragStore.getState();
      const { targetTabId, targetPaneId, zone } = state;
      state.clear();
      if (targetTabId && targetPaneId && zone) {
        const direction = zone === "left" || zone === "right" ? "row" : "column";
        const placement = zone === "left" || zone === "top" ? "before" : "after";
        movePaneToPane(
          current.sourceTabId,
          current.paneId,
          targetTabId,
          targetPaneId,
          direction,
          placement,
        );
        return;
      }
      // Released over the tab strip: the pane becomes a tab of its own.
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (element instanceof Element && element.closest("header")) {
        detachPaneToTab(current.sourceTabId, current.paneId);
      }
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      void drag.current.tornWindow?.setFocus().catch(() => {});
      drag.current = null;
      useTabDragStore.getState().clear();
  };

  return { sourcePaneId, handlers, onPointerMove, onPointerUp, onPointerCancel };
}

function countLeaves(node: PaneNode): number {
  return node.kind === "leaf"
    ? 1
    : node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

function PaneNodeView({
  node,
  tab,
  sessions,
  multiPane,
  showDropPreview,
  paneDrag,
}: {
  node: PaneNode;
  tab: WorkspaceTab;
  sessions: TerminalSession[];
  multiPane: boolean;
  showDropPreview: boolean;
  paneDrag: PaneDragHandlers;
}) {
  const focusPane = useSessionStore((s) => s.focusPane);
  const targetPaneId = useTabDragStore((s) => s.targetPaneId);
  const zone = useTabDragStore((s) => s.zone);

  if (node.kind === "leaf") {
    const session = sessions.find((s) => s.id === node.sessionId);
    if (!session) return null;
    const selected = targetPaneId === node.id;
    // Broadcast is only meaningful across multiple panes. `broadcastActive`
    // drives the per-pane include/exclude action; `broadcasting` marks the panes
    // that currently receive fanned-out input (tinted border + badge).
    const broadcastActive = Boolean(tab.broadcastEnabled) && multiPane;
    const broadcasting =
      broadcastActive && !(tab.broadcastExcluded ?? []).includes(session.id);
    return (
      <div
        data-tab-drop-tab={tab.id}
        data-tab-drop-pane={node.id}
        className="luma-pane-enter relative h-full min-h-0 w-full min-w-0"
      >
        <PaneView
          session={session}
          tabId={tab.id}
          focused={tab.activePaneId === node.id}
          showFocusRing={multiPane}
          // A lone pane is already named by its tab; the header would only cost
          // terminal height and its drag/split actions have no second pane to
          // act against.
          titleBar={
            multiPane ? (
              <PaneTitleBar
                session={session}
                focused={tab.activePaneId === node.id}
                dragging={paneDrag.sourcePaneId === node.id}
                onFocus={() => focusPane(tab.id, node.id)}
                {...paneDrag.handlers(node.id, session.title)}
                onPointerMove={() => {}}
                onPointerUp={() => {}}
                onPointerCancel={() => {}}
              />
            ) : undefined
          }
          broadcastActive={broadcastActive}
          broadcasting={broadcasting}
          onFocus={() => focusPane(tab.id, node.id)}
        />
        {showDropPreview && paneDrag.sourcePaneId !== node.id && (
          <div className="pointer-events-none absolute inset-0 z-40 rounded-lg border border-dashed border-accent/35 bg-background/10">
            {selected && zone && (
              <div
                className={cn(
                  "absolute flex items-center justify-center border-2 border-accent bg-accent/30 text-sm font-semibold text-white shadow-glow backdrop-blur-[1px]",
                  zone === "left" && "inset-y-0 left-0 w-1/2 rounded-l-lg",
                  zone === "right" && "inset-y-0 right-0 w-1/2 rounded-r-lg",
                  zone === "top" && "inset-x-0 top-0 h-1/2 rounded-t-lg",
                  zone === "bottom" && "inset-x-0 bottom-0 h-1/2 rounded-b-lg",
                )}
              >
                Drop here
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const isRow = node.direction === "row";
  return (
    <div
      className={isRow ? "flex h-full w-full flex-row" : "flex h-full w-full flex-col"}
    >
      {node.children.map((child, index) => (
        <div key={child.id} className="contents">
          <div
            className="relative min-h-0 min-w-0 transition-[flex-grow] duration-150 ease-out"
            style={{ flexGrow: node.sizes[index] ?? 1, flexBasis: 0 }}
          >
            <PaneNodeView
              node={child}
              tab={tab}
              sessions={sessions}
              multiPane={multiPane}
              showDropPreview={showDropPreview}
              paneDrag={paneDrag}
            />
          </div>
          {index < node.children.length - 1 && (
            <Divider
              direction={node.direction}
              tabId={tab.id}
              splitId={node.id}
              sizes={node.sizes}
              index={index}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function Divider({
  direction,
  tabId,
  splitId,
  sizes,
  index,
}: {
  direction: SplitDirection;
  tabId: string;
  splitId: string;
  sizes: number[];
  index: number;
}) {
  const resizeSplit = useSessionStore((s) => s.resizeSplit);
  const barRef = useRef<HTMLDivElement>(null);
  const isRow = direction === "row";

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = barRef.current?.parentElement?.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const totalPx = isRow ? rect.width : rect.height;
    if (totalPx <= 0) return;

    const startPos = isRow ? event.clientX : event.clientY;
    const startA = sizes[index];
    const startB = sizes[index + 1];
    const pair = startA + startB;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const pos = isRow ? moveEvent.clientX : moveEvent.clientY;
      const deltaPercent = ((pos - startPos) / totalPx) * 100;
      const min = 8;
      let a = startA + deltaPercent;
      a = Math.max(min, Math.min(pair - min, a));
      const b = pair - a;
      const next = [...sizes];
      next[index] = a;
      next[index + 1] = b;
      resizeSplit(tabId, splitId, next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      target.releasePointerCapture?.(event.pointerId);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={barRef}
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      aria-label="Resize panes"
      onPointerDown={onPointerDown}
      className={
        isRow
          ? "group relative w-1 shrink-0 cursor-col-resize"
          : "group relative h-1 shrink-0 cursor-row-resize"
      }
    >
      <span
        className={
          isRow
            ? "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-accent"
            : "absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover:bg-accent"
        }
      />
    </div>
  );
}
