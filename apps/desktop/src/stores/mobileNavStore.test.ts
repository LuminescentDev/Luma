import { beforeEach, describe, expect, it } from "vitest";
import { useMobileNavStore } from "./mobileNavStore";

describe("mobile navigation", () => {
  beforeEach(() => {
    useMobileNavStore.setState({
      tab: "vaults",
      stacks: { vaults: [], connections: [], profile: [] },
      fullscreen: false,
    });
  });

  it("keeps a separate route stack per tab", () => {
    const nav = useMobileNavStore.getState();
    nav.push("hosts");
    nav.selectTab("profile");
    nav.push("settings-appearance");

    const { stacks } = useMobileNavStore.getState();
    expect(stacks.vaults).toEqual(["hosts"]);
    expect(stacks.profile).toEqual(["settings-appearance"]);
  });

  it("restores a tab's position when switching back to it", () => {
    const nav = useMobileNavStore.getState();
    nav.push("keychain");
    nav.selectTab("connections");
    nav.selectTab("vaults");

    expect(useMobileNavStore.getState().stacks.vaults).toEqual(["keychain"]);
  });

  it("pops to the tab's root when the active tab is re-selected", () => {
    const nav = useMobileNavStore.getState();
    nav.push("hosts");
    nav.push("keychain");

    useMobileNavStore.getState().selectTab("vaults");

    expect(useMobileNavStore.getState().stacks.vaults).toEqual([]);
    expect(useMobileNavStore.getState().tab).toBe("vaults");
  });

  it("leaves other tabs untouched when re-selecting pops one to root", () => {
    const nav = useMobileNavStore.getState();
    nav.selectTab("profile");
    nav.push("settings-vaults");
    nav.selectTab("vaults");
    useMobileNavStore.getState().push("hosts");
    useMobileNavStore.getState().selectTab("vaults");

    const { stacks } = useMobileNavStore.getState();
    expect(stacks.vaults).toEqual([]);
    expect(stacks.profile).toEqual(["settings-vaults"]);
  });

  it("pops one level at a time and no-ops at the hub", () => {
    const nav = useMobileNavStore.getState();
    nav.push("hosts");
    nav.push("keychain");

    useMobileNavStore.getState().pop();
    expect(useMobileNavStore.getState().stacks.vaults).toEqual(["hosts"]);

    useMobileNavStore.getState().pop();
    useMobileNavStore.getState().pop();
    expect(useMobileNavStore.getState().stacks.vaults).toEqual([]);
  });

  it("navigate replaces the target tab's stack rather than pushing onto it", () => {
    const nav = useMobileNavStore.getState();
    nav.push("hosts");
    nav.push("keychain");

    useMobileNavStore.getState().navigate("vaults", "snippets");

    expect(useMobileNavStore.getState().stacks.vaults).toEqual(["snippets"]);
  });

  it("navigate without a route lands on the tab's hub", () => {
    const nav = useMobileNavStore.getState();
    nav.push("hosts");

    useMobileNavStore.getState().navigate("vaults");

    expect(useMobileNavStore.getState().stacks.vaults).toEqual([]);
  });

  // A full-screen session hides the tab bar, so any navigation has to drop out
  // of it or the user would land on a screen they cannot see.
  it("leaves full-screen when a tab is selected or navigated to", () => {
    useMobileNavStore.setState({ fullscreen: true });
    useMobileNavStore.getState().selectTab("profile");
    expect(useMobileNavStore.getState().fullscreen).toBe(false);

    useMobileNavStore.setState({ fullscreen: true });
    useMobileNavStore.getState().navigate("vaults", "hosts");
    expect(useMobileNavStore.getState().fullscreen).toBe(false);
  });
});
