import { afterEach, describe, expect, it } from "vitest";
import { nearestEdgeZone, resolvePaneTarget } from "./tabDrop";

const rect = { left: 100, right: 300, top: 100, bottom: 500 };

describe("nearestEdgeZone", () => {
  it("returns left near the left edge", () => {
    expect(nearestEdgeZone(rect, 110, 300)).toBe("left");
  });

  it("returns right near the right edge", () => {
    expect(nearestEdgeZone(rect, 290, 300)).toBe("right");
  });

  it("returns top near the top edge", () => {
    expect(nearestEdgeZone(rect, 200, 110)).toBe("top");
  });

  it("returns bottom near the bottom edge", () => {
    expect(nearestEdgeZone(rect, 200, 490)).toBe("bottom");
  });

  it("prefers a horizontal edge when it is closest even off-center", () => {
    // Near the left edge but vertically centered: left wins over top/bottom.
    expect(nearestEdgeZone(rect, 105, 300)).toBe("left");
  });
});

describe("resolvePaneTarget", () => {
  const created: HTMLElement[] = [];

  afterEach(() => {
    for (const el of created) el.remove();
    created.length = 0;
  });

  function makePane(
    tabId: string,
    paneId: string,
    bounds: { left: number; top: number; width: number; height: number },
  ): HTMLElement {
    const el = document.createElement("div");
    el.dataset.tabDropTab = tabId;
    el.dataset.tabDropPane = paneId;
    el.getBoundingClientRect = () =>
      ({
        left: bounds.left,
        top: bounds.top,
        right: bounds.left + bounds.width,
        bottom: bounds.top + bounds.height,
        width: bounds.width,
        height: bounds.height,
        x: bounds.left,
        y: bounds.top,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(el);
    created.push(el);
    return el;
  }

  it("reads the permanent pane + tab metadata and computes the nearest edge", () => {
    const pane = makePane("tab-a", "pane-1", {
      left: 0,
      top: 0,
      width: 200,
      height: 400,
    });

    expect(resolvePaneTarget(pane, 10, 200)).toEqual({
      targetTabId: "tab-a",
      targetPaneId: "pane-1",
      zone: "left",
    });
    expect(resolvePaneTarget(pane, 190, 200)).toEqual({
      targetTabId: "tab-a",
      targetPaneId: "pane-1",
      zone: "right",
    });
    expect(resolvePaneTarget(pane, 100, 10)).toEqual({
      targetTabId: "tab-a",
      targetPaneId: "pane-1",
      zone: "top",
    });
    expect(resolvePaneTarget(pane, 100, 390)).toEqual({
      targetTabId: "tab-a",
      targetPaneId: "pane-1",
      zone: "bottom",
    });
  });

  it("walks up from a descendant to the owning pane wrapper", () => {
    const pane = makePane("tab-b", "pane-2", {
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
    const child = document.createElement("span");
    pane.appendChild(child);

    expect(resolvePaneTarget(child, 5, 50)?.targetPaneId).toBe("pane-2");
  });

  it("returns null off any pane or for a non-element", () => {
    const loose = document.createElement("div");
    document.body.appendChild(loose);
    created.push(loose);

    expect(resolvePaneTarget(loose, 10, 10)).toBeNull();
    expect(resolvePaneTarget(null, 10, 10)).toBeNull();
  });
});
