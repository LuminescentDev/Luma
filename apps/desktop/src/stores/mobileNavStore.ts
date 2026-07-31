import { create } from "zustand";

/*
 * Navigation state for the mobile shell: three tabs, each owning an independent
 * stack of routes. This replaces the flat five-tab local state the shell used
 * before, so hub screens (Vaults, Profile) can push detail screens and keep a
 * back stack per tab — switching tabs preserves where you were in each.
 *
 * Desktop navigation is untouched: it stays on uiStore.mainView. This store is
 * only read by the mobile shell (and by the native tab-bar bridge on iOS, which
 * mirrors `tab` into a UIKit view and pushes selections back in).
 */

export type MobileTab = "vaults" | "connections" | "profile";

/** A screen inside a tab's stack. The tab's own hub is never a route: it is the
 * implicit bottom of the stack, so an empty stack means "showing the hub". */
export type MobileRoute =
  | "hosts"
  | "keychain"
  | "port-forwards"
  | "snippets"
  | "known-hosts"
  | "sftp"
  | "logs"
  // Monitoring screens. "servers" is the dashboard, which picks its own host and
  // remembers it in serverStatsStore; "fleet" is the health sweep across
  // favorites. Neither carries route parameters.
  | "servers"
  | "fleet"
  | "agent-inbox"
  | "settings-account"
  | "settings-appearance"
  | "settings-terminal"
  | "settings-ssh"
  | "settings-vaults"
  | "settings-collaboration"
  | "settings-about";

export const MOBILE_TABS: MobileTab[] = ["vaults", "connections", "profile"];

type MobileNavState = {
  tab: MobileTab;
  /** Route stack per tab, deepest last. Empty = the tab's hub screen. */
  stacks: Record<MobileTab, MobileRoute[]>;
  /** Whether the Connections tab is showing a session full-screen (nav hidden). */
  fullscreen: boolean;
  /**
   * Whether a full-screen sheet (the host editor) covers the shell. On iOS the
   * tab bar is a real UIKit view sitting OVER the webview, so a DOM overlay
   * cannot hide it — the bar has to be told to get out of the way.
   */
  sheetOpen: boolean;
  /**
   * Select a tab. Re-selecting the active tab pops it to its root, matching
   * iOS: tapping the current tab is "take me home", not a no-op.
   */
  selectTab: (tab: MobileTab) => void;
  /** Push a route onto the active tab's stack. */
  push: (route: MobileRoute) => void;
  /** Pop the active tab's stack. No-op at the hub. */
  pop: () => void;
  /** Jump straight to a route in a given tab (deep links, cross-tab actions). */
  navigate: (tab: MobileTab, route?: MobileRoute) => void;
  setFullscreen: (fullscreen: boolean) => void;
  setSheetOpen: (open: boolean) => void;
};

const EMPTY_STACKS: Record<MobileTab, MobileRoute[]> = {
  vaults: [],
  connections: [],
  profile: [],
};

export const useMobileNavStore = create<MobileNavState>((set) => ({
  tab: "vaults",
  stacks: EMPTY_STACKS,
  fullscreen: false,
  sheetOpen: false,

  selectTab: (tab) =>
    set((state) => ({
      tab,
      fullscreen: false,
      stacks:
        state.tab === tab && state.stacks[tab].length > 0
          ? { ...state.stacks, [tab]: [] }
          : state.stacks,
    })),

  push: (route) =>
    set((state) => ({
      stacks: {
        ...state.stacks,
        [state.tab]: [...state.stacks[state.tab], route],
      },
    })),

  pop: () =>
    set((state) => ({
      stacks: {
        ...state.stacks,
        [state.tab]: state.stacks[state.tab].slice(0, -1),
      },
    })),

  navigate: (tab, route) =>
    set((state) => ({
      tab,
      fullscreen: false,
      stacks: { ...state.stacks, [tab]: route ? [route] : [] },
    })),

  setFullscreen: (fullscreen) => set({ fullscreen }),

  setSheetOpen: (sheetOpen) => set({ sheetOpen }),
}));

/** Route currently shown in the active tab, or null when at the tab's hub. */
export function useActiveRoute(): MobileRoute | null {
  return useMobileNavStore((state) => {
    const stack = state.stacks[state.tab];
    return stack.length > 0 ? stack[stack.length - 1] : null;
  });
}

/** Whether the active tab can go back (i.e. is not at its hub). */
export function useCanGoBack(): boolean {
  return useMobileNavStore((state) => state.stacks[state.tab].length > 0);
}
