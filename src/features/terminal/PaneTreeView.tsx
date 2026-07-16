import { useRef } from "react";
import type {
  PaneNode,
  SplitDirection,
  TerminalSession,
  WorkspaceTab,
} from "../../types";
import { useSessionStore } from "../../stores/sessionStore";
import { PaneView } from "./PaneView";

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
  return (
    <div className="h-full w-full p-1">
      <PaneNodeView
        node={tab.root}
        tab={tab}
        sessions={sessions}
        multiPane={leafCount > 1}
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
}: {
  node: PaneNode;
  tab: WorkspaceTab;
  sessions: TerminalSession[];
  multiPane: boolean;
}) {
  const focusPane = useSessionStore((s) => s.focusPane);

  if (node.kind === "leaf") {
    const session = sessions.find((s) => s.id === node.sessionId);
    if (!session) return null;
    return (
      <PaneView
        session={session}
        focused={tab.activePaneId === node.id}
        showFocusRing={multiPane}
        onFocus={() => focusPane(tab.id, node.id)}
      />
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
