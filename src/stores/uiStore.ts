import { create } from "zustand";
import type { SidebarSection } from "../types";

/**
 * What the main area shows. Decoupled from the sidebar rail: the terminal
 * workspace is driven by the top TabBar (`"terminal"`), the rail selects a
 * section screen, and settings/keychain are full-screen views. This is a single
 * source of truth so a terminal tab can be the active main view independently of
 * any sidebar section.
 */
export type MainView = SidebarSection | "terminal" | "settings" | "keychain";

type UiState = {
  /** What the main area shows to the right of the sidebar. */
  mainView: MainView;
  navOpen: boolean;
  toggleNav: () => void;
  /** Rail-icon behavior: show the section's screen in the main area. */
  selectSection: (section: SidebarSection) => void;
  /** Force a section's screen into the main area (deep links / shortcuts). */
  openSection: (section: SidebarSection) => void;
  /** Show the terminal workspace in the main area (top-tab driven). */
  showTerminal: () => void;
  /** Show the full-screen settings view. */
  openSettings: () => void;
  openKeychain: () => void;
  terminalSearchOpen: boolean;
  setTerminalSearchOpen: (open: boolean) => void;
  newTabOpen: boolean;
  openNewTab: () => void;
  closeNewTab: () => void;
  /** Serial-terminal connect dialog visibility. */
  serialConnectOpen: boolean;
  openSerialConnect: () => void;
  closeSerialConnect: () => void;
  /** Command palette overlay visibility. */
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  // With no terminal tabs open on launch, the main area defaults to Hosts.
  mainView: "hosts",
  navOpen: false,
  toggleNav: () => set((state) => ({ navOpen: !state.navOpen })),
  selectSection: (section) => set({ mainView: section }),
  openSection: (section) => set({ mainView: section }),
  showTerminal: () => set({ mainView: "terminal" }),
  openSettings: () => set({ mainView: "settings" }),
  openKeychain: () => set({ mainView: "keychain" }),
  terminalSearchOpen: false,
  setTerminalSearchOpen: (open) => set({ terminalSearchOpen: open }),
  newTabOpen: false,
  openNewTab: () => set({ mainView: "terminal", newTabOpen: true }),
  closeNewTab: () => set({ newTabOpen: false }),
  serialConnectOpen: false,
  openSerialConnect: () => set({ serialConnectOpen: true }),
  closeSerialConnect: () => set({ serialConnectOpen: false }),
  paletteOpen: false,
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
}));
