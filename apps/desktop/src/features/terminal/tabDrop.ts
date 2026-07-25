import type { TabDropZone } from "../../stores/tabDragStore";

/** The split edge nearest to a point inside a pane rectangle. Left/right map to a
 * row split, top/bottom to a column split (resolved by the caller). The reduce
 * only replaces on a strictly smaller distance, so ties resolve toward the edge
 * listed first in the array order: left, then right, then top, then bottom. */
export function nearestEdgeZone(
  rect: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
): TabDropZone {
  const distances: Array<[TabDropZone, number]> = [
    ["left", x - rect.left],
    ["right", rect.right - x],
    ["top", y - rect.top],
    ["bottom", rect.bottom - y],
  ];
  return distances.reduce((closest, candidate) =>
    candidate[1] < closest[1] ? candidate : closest,
  )[0];
}

export type PaneDropTarget = {
  targetTabId: string;
  targetPaneId: string;
  zone: TabDropZone;
};

/** Resolve the pane a logical client point lands on into a drop target, using the
 * permanent `data-tab-drop-pane`/`data-tab-drop-tab` metadata PaneTreeView puts on
 * every leaf. Returns null when the point is not over a pane. Shared by the normal
 * in-window tab drag and the external detached-window drag so both display and
 * commit the same split direction. */
export function resolvePaneTarget(
  element: Element | null,
  x: number,
  y: number,
): PaneDropTarget | null {
  const pane =
    element instanceof Element
      ? element.closest<HTMLElement>("[data-tab-drop-pane]")
      : null;
  if (!pane) return null;
  const targetPaneId = pane.dataset.tabDropPane;
  const targetTabId = pane.dataset.tabDropTab;
  if (!targetPaneId || !targetTabId) return null;
  const rect = pane.getBoundingClientRect();
  return { targetTabId, targetPaneId, zone: nearestEdgeZone(rect, x, y) };
}
