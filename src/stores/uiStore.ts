import { create } from "zustand";
import type { SidebarSection } from "../types";

type UiState = {
  section: SidebarSection;
  setSection: (section: SidebarSection) => void;
};

export const useUiStore = create<UiState>((set) => ({
  section: "hosts",
  setSection: (section) => set({ section }),
}));
