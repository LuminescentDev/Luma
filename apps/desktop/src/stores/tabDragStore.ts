import { create } from "zustand";

export type TabDropZone = "left" | "right" | "top" | "bottom";

type TabDragState = {
  sourceTabId: string | null;
  /** Set only while a single PANE is being dragged by its title bar; null for a
   * whole-tab drag from the strip. Its own tab stays in `sourceTabId` so the
   * drop preview still resolves, and the pane itself is excluded as a target. */
  sourcePaneId: string | null;
  sourceTitle: string;
  targetTabId: string | null;
  targetPaneId: string | null;
  zone: TabDropZone | null;
  /** Live tear-off in progress: the tab has become its own OS window that now
   * follows the pointer. The drag gesture is still active (sourceTabId stays
   * set so the capturing strip element remains mounted) but the in-app ghost
   * hides — the real window is the drag preview. */
  torn: boolean;
  /** An already-detached window is being dragged over this window's tab strip.
   * The gesture lives in that window's OS move loop, so this window holds no
   * pointer capture and draws no ghost — the real window is the preview. The
   * strip shows the tab as a dimmed placeholder until the drag commits or
   * leaves, so crossing the frame never snaps the tab back in. */
  external: boolean;
  x: number;
  y: number;
  begin: (sourceTabId: string, sourceTitle: string, x: number, y: number) => void;
  /** Begin dragging one pane out of `sourceTabId` by its title bar. */
  beginPane: (
    sourceTabId: string,
    sourcePaneId: string,
    sourceTitle: string,
    x: number,
    y: number,
  ) => void;
  beginExternal: (sourceTabId: string, sourceTitle: string) => void;
  move: (
    x: number,
    y: number,
    targetTabId?: string | null,
    zone?: TabDropZone | null,
    targetPaneId?: string | null,
  ) => void;
  setTorn: (torn: boolean) => void;
  clear: () => void;
};

export const useTabDragStore = create<TabDragState>((set) => ({
  sourceTabId: null,
  sourcePaneId: null,
  sourceTitle: "",
  targetTabId: null,
  targetPaneId: null,
  zone: null,
  torn: false,
  external: false,
  x: 0,
  y: 0,
  begin: (sourceTabId, sourceTitle, x, y) =>
    set({ sourceTabId, sourcePaneId: null, sourceTitle, targetTabId: null, targetPaneId: null, zone: null, torn: false, external: false, x, y }),
  beginPane: (sourceTabId, sourcePaneId, sourceTitle, x, y) =>
    set({ sourceTabId, sourcePaneId, sourceTitle, targetTabId: null, targetPaneId: null, zone: null, torn: false, external: false, x, y }),
  beginExternal: (sourceTabId, sourceTitle) =>
    set({ sourceTabId, sourcePaneId: null, sourceTitle, targetTabId: null, targetPaneId: null, zone: null, torn: false, external: true }),
  move: (x, y, targetTabId, zone, targetPaneId) =>
    set((state) => {
      const nextTargetTabId =
        targetTabId === undefined ? state.targetTabId : targetTabId;
      const nextZone = zone === undefined ? state.zone : zone;
      const nextTargetPaneId =
        targetPaneId === undefined ? state.targetPaneId : targetPaneId;
      const nextX = state.external ? state.x : x;
      const nextY = state.external ? state.y : y;
      if (
        nextX === state.x &&
        nextY === state.y &&
        nextTargetTabId === state.targetTabId &&
        nextZone === state.zone &&
        nextTargetPaneId === state.targetPaneId
      ) {
        return state;
      }
      return {
        x: nextX,
        y: nextY,
        targetTabId: nextTargetTabId,
        zone: nextZone,
        targetPaneId: nextTargetPaneId,
      };
    }),
  setTorn: (torn) => set({ torn }),
  clear: () =>
    set({ sourceTabId: null, sourcePaneId: null, sourceTitle: "", targetTabId: null, targetPaneId: null, zone: null, torn: false, external: false }),
}));
