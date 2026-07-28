import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./uiStore";

describe("new tab launchers", () => {
  beforeEach(() => {
    useUiStore.setState({
      mainView: "hosts",
      newTabIds: [],
      activeNewTabId: null,
    });
  });

  it("keeps multiple launchers and selects the newest one", () => {
    useUiStore.getState().openNewTab();
    const first = useUiStore.getState().activeNewTabId;
    useUiStore.getState().openNewTab();
    const state = useUiStore.getState();

    expect(first).not.toBeNull();
    expect(state.newTabIds).toHaveLength(2);
    expect(state.activeNewTabId).toBe(state.newTabIds[1]);
  });

  it("selects an adjacent launcher when the active one is explicitly closed", () => {
    useUiStore.getState().openNewTab();
    useUiStore.getState().openNewTab();
    const [first, second] = useUiStore.getState().newTabIds;

    useUiStore.getState().closeNewTab(second);

    expect(useUiStore.getState().newTabIds).toEqual([first]);
    expect(useUiStore.getState().activeNewTabId).toBe(first);
  });

  it("preserves blank launchers when returning to a real terminal", () => {
    useUiStore.getState().openNewTab();
    const launcherId = useUiStore.getState().activeNewTabId;

    useUiStore.getState().showTerminal();

    expect(useUiStore.getState().newTabIds).toEqual([launcherId]);
    expect(useUiStore.getState().activeNewTabId).toBeNull();
  });
});
