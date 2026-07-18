import { create } from "zustand";

export type TabDropZone = "left" | "right" | "top" | "bottom";

type TabDragState = {
  sourceTabId: string | null;
  sourceTitle: string;
  targetTabId: string | null;
  targetPaneId: string | null;
  zone: TabDropZone | null;
  x: number;
  y: number;
  begin: (sourceTabId: string, sourceTitle: string, x: number, y: number) => void;
  move: (
    x: number,
    y: number,
    targetTabId?: string | null,
    zone?: TabDropZone | null,
    targetPaneId?: string | null,
  ) => void;
  clear: () => void;
};

export const useTabDragStore = create<TabDragState>((set) => ({
  sourceTabId: null,
  sourceTitle: "",
  targetTabId: null,
  targetPaneId: null,
  zone: null,
  x: 0,
  y: 0,
  begin: (sourceTabId, sourceTitle, x, y) =>
    set({ sourceTabId, sourceTitle, targetTabId: null, targetPaneId: null, zone: null, x, y }),
  move: (x, y, targetTabId, zone, targetPaneId) =>
    set((state) => ({
      x,
      y,
      targetTabId:
        targetTabId === undefined ? state.targetTabId : targetTabId,
      zone: zone === undefined ? state.zone : zone,
      targetPaneId:
        targetPaneId === undefined ? state.targetPaneId : targetPaneId,
    })),
  clear: () =>
    set({ sourceTabId: null, sourceTitle: "", targetTabId: null, targetPaneId: null, zone: null }),
}));
