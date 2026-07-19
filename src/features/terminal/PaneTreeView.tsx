import { useRef } from "react";
import type {
  PaneNode,
  SplitDirection,
  TerminalSession,
  WorkspaceTab,
} from "../../types";
import { useSessionStore } from "../../stores/sessionStore";
import { PaneView } from "./PaneView";
import { useTabDragStore } from "../../stores/tabDragStore";
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
  const targetTabId = useTabDragStore((s) => s.targetTabId);
  const showDropPreview = Boolean(sourceTabId && targetTabId === tab.id);
  return (
    <div className="relative h-full w-full p-1">
      <PaneNodeView
        node={tab.root}
        tab={tab}
        sessions={sessions}
        multiPane={leafCount > 1}
        showDropPreview={showDropPreview}
      />
    </div>
  );
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
}: {
  node: PaneNode;
  tab: WorkspaceTab;
  sessions: TerminalSession[];
  multiPane: boolean;
  showDropPreview: boolean;
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
      <div className="relative h-full min-h-0 w-full min-w-0">
        <PaneView
          session={session}
          tabId={tab.id}
          focused={tab.activePaneId === node.id}
          showFocusRing={multiPane}
          broadcastActive={broadcastActive}
          broadcasting={broadcasting}
          onFocus={() => focusPane(tab.id, node.id)}
        />
        {showDropPreview && (
          <div
            data-tab-drop-pane={node.id}
            className="absolute inset-0 z-40 rounded-lg border border-dashed border-accent/35 bg-background/10"
          >
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
            className="relative min-h-0 min-w-0"
            style={{ flexGrow: node.sizes[index] ?? 1, flexBasis: 0 }}
          >
            <PaneNodeView
              node={child}
              tab={tab}
              sessions={sessions}
              multiPane={multiPane}
              showDropPreview={showDropPreview}
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
