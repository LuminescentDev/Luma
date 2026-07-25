import { beforeEach, describe, expect, it } from "vitest";
import { mainClientPoint } from "./DetachedTerminalWindow";
import { useTabDragStore } from "../../stores/tabDragStore";

// Cursor + main rect are PHYSICAL pixels; the result is LOGICAL client px of the
// main window's inner (webview) area. main is the innerPosition/innerSize rect.
const main = { x: 100, y: 200, width: 1200, height: 800, scaleFactor: 1 };

describe("mainClientPoint", () => {
  it("converts a physical cursor to logical client coordinates at 1x", () => {
    expect(mainClientPoint({ x: 400, y: 260 }, main)).toEqual({ x: 300, y: 60 });
  });

  it("resolves a point in the top strip band", () => {
    // 20px below the client origin: inside the 40px strip TabBar checks.
    expect(mainClientPoint({ x: 400, y: 220 }, main)).toEqual({ x: 300, y: 20 });
  });

  it("resolves a point deep in the terminal body", () => {
    expect(mainClientPoint({ x: 700, y: 700 }, main)).toEqual({ x: 600, y: 500 });
  });

  it("divides by the scale factor on a high-DPI monitor", () => {
    const hidpi = { ...main, scaleFactor: 2 };
    expect(mainClientPoint({ x: 400, y: 260 }, hidpi)).toEqual({ x: 150, y: 30 });
  });

  it("handles a fractional scale factor", () => {
    const scaled = { x: 0, y: 0, width: 1500, height: 1500, scaleFactor: 1.5 };
    expect(mainClientPoint({ x: 150, y: 300 }, scaled)).toEqual({ x: 100, y: 200 });
  });

  it("handles a window at negative desktop coordinates", () => {
    const offscreen = { x: -400, y: -100, width: 800, height: 600, scaleFactor: 1 };
    expect(mainClientPoint({ x: -350, y: -50 }, offscreen)).toEqual({ x: 50, y: 50 });
    expect(mainClientPoint({ x: -500, y: -50 }, offscreen)).toBeNull();
  });

  it("includes the top-left edge and excludes the right/bottom edge", () => {
    // Top-left corner is inside (>= origin).
    expect(mainClientPoint({ x: 100, y: 200 }, main)).toEqual({ x: 0, y: 0 });
    // Exactly on the right/bottom extent is outside (>= extent).
    expect(mainClientPoint({ x: 1300, y: 500 }, main)).toBeNull();
    expect(mainClientPoint({ x: 400, y: 1000 }, main)).toBeNull();
    // One px inside those extents is in.
    expect(mainClientPoint({ x: 1299, y: 999 }, main)).toEqual({ x: 1199, y: 799 });
  });

  it("rejects a cursor outside the window on any side", () => {
    expect(mainClientPoint({ x: 50, y: 260 }, main)).toBeNull();
    expect(mainClientPoint({ x: 400, y: 190 }, main)).toBeNull();
  });
});

describe("external drag placeholder", () => {
  beforeEach(() => {
    useTabDragStore.getState().clear();
  });

  it("marks the hovered tab as a non-torn drag source", () => {
    useTabDragStore.getState().beginExternal("tab-1", "zsh");
    const state = useTabDragStore.getState();

    // Non-torn keeps the tab visible in the strip as the dimmed placeholder;
    // external suppresses the in-app ghost, since the real window is the
    // preview and this window never sees the pointer.
    expect(state.sourceTabId).toBe("tab-1");
    expect(state.sourceTitle).toBe("zsh");
    expect(state.external).toBe(true);
    expect(state.torn).toBe(false);
  });

  it("commits no drop target while hovering", () => {
    useTabDragStore.getState().beginExternal("tab-1", "zsh");
    const state = useTabDragStore.getState();

    expect(state.targetTabId).toBeNull();
    expect(state.targetPaneId).toBeNull();
    expect(state.zone).toBeNull();
  });

  it("clears the external flag when the drag leaves", () => {
    useTabDragStore.getState().beginExternal("tab-1", "zsh");
    useTabDragStore.getState().clear();

    expect(useTabDragStore.getState().sourceTabId).toBeNull();
    expect(useTabDragStore.getState().external).toBe(false);
  });

  it("resets external state when a normal in-app drag begins", () => {
    useTabDragStore.getState().beginExternal("tab-1", "zsh");
    useTabDragStore.getState().begin("tab-2", "bash", 10, 20);

    expect(useTabDragStore.getState().external).toBe(false);
    expect(useTabDragStore.getState().sourceTabId).toBe("tab-2");
  });

  it("drops a pane target when the drag moves to the strip or empty space", () => {
    useTabDragStore.getState().beginExternal("tab-1", "zsh");
    // Over a pane: full split target set (matching TabBar's move dispatch).
    useTabDragStore.getState().move(300, 300, "tab-2", "left", "pane-9");
    let state = useTabDragStore.getState();
    expect(state.targetTabId).toBe("tab-2");
    expect(state.zone).toBe("left");
    expect(state.targetPaneId).toBe("pane-9");

    // Moving to the strip / empty space clears every target field so the split
    // preview never sticks. Explicit null (not undefined) is what forces this.
    useTabDragStore.getState().move(300, 10, null, null, null);
    state = useTabDragStore.getState();
    expect(state.targetTabId).toBeNull();
    expect(state.zone).toBeNull();
    expect(state.targetPaneId).toBeNull();
    // The placeholder itself remains until the drag commits or leaves.
    expect(state.external).toBe(true);
    expect(state.sourceTabId).toBe("tab-1");
  });
});
