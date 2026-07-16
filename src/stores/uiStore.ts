import { create } from "zustand";
import type { SidebarSection } from "../types";

/** The main-area content: the terminal workspace or the full-screen settings. */
type MainView = "workspace" | "settings" | "keychain";

type UiState = {
  /** Which sidebar panel section is selected. */
  section: SidebarSection;
  /** Whether the sidebar content panel is expanded (icon rail is always shown). */
  panelOpen: boolean;
  /** What the main area shows to the right of the sidebar. */
  view: MainView;
  navOpen: boolean;
  toggleNav: () => void;
  /** Rail-icon behavior: open the section's panel, or collapse it if already active. */
  selectSection: (section: SidebarSection) => void;
  /** Force a section's panel open (e.g. deep links / empty-state shortcuts). */
  openSection: (section: SidebarSection) => void;
  /** Show the full-screen settings view. */
  openSettings: () => void;
  openKeychain: () => void;
  /** Return the main area to the terminal workspace. */
  showWorkspace: () => void;
  terminalSearchOpen: boolean;
  setTerminalSearchOpen: (open: boolean) => void;
  /** Command palette overlay visibility. */
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  section: "terminal",
  panelOpen: true,
  view: "workspace",
  navOpen: false,
  toggleNav: () => set((state) => ({ navOpen: !state.navOpen })),
  selectSection: (section) =>
    set({ view: "workspace", section, panelOpen: true }),
  openSection: (section) => set({ view: "workspace", section, panelOpen: true }),
  openSettings: () => set({ view: "settings" }),
  openKeychain: () => set({ view: "keychain" }),
  showWorkspace: () => set({ view: "workspace" }),
  terminalSearchOpen: false,
  setTerminalSearchOpen: (open) => set({ terminalSearchOpen: open }),
  paletteOpen: false,
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
}));
