import { create } from "zustand";
import type { SidebarSection } from "../types";

type UiState = {
  section: SidebarSection;
  setSection: (section: SidebarSection) => void;
  terminalSearchOpen: boolean;
  setTerminalSearchOpen: (open: boolean) => void;
};

export const useUiStore = create<UiState>((set) => ({
  section: "hosts",
  setSection: (section) => set({ section }),
  terminalSearchOpen: false,
  setTerminalSearchOpen: (open) => set({ terminalSearchOpen: open }),
}));
