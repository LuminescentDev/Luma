import { create } from "zustand";
import {
  DEFAULT_KEYMAP,
  keymapChords,
  mergeKeymap,
  type Keymap,
  type KeymapActionId,
} from "../lib/keymap";
import { SETTING_KEYS } from "../types";
import { getAllSettings, setSetting } from "../lib/settings";
import { terminalManager } from "../features/terminal/terminalManager";

/*
 * Configurable keybindings. The keymap (actionId -> chord) is persisted
 * device-local through the generic settings commands under `keybindings.map`,
 * merged with defaults on load (see mergeKeymap: unknown actions dropped,
 * missing actions get defaults). Every change re-pushes the full chord set to
 * terminalManager so the terminal keeps swallowing app chords (letting them
 * bubble to the window handler in Layout) even after a rebind.
 */

type KeymapState = {
  keymap: Keymap;
  loaded: boolean;
  /** Read the persisted keymap into the store (once, on app start). */
  load: () => Promise<void>;
  /** Rebind one action to a new chord; persists and re-syncs the manager. */
  rebind: (id: KeymapActionId, chord: string) => Promise<void>;
  /** Reset a single action to its default chord. */
  resetAction: (id: KeymapActionId) => Promise<void>;
  /** Reset every action to its default chord. */
  resetAll: () => Promise<void>;
};

/** Push the current chord set into terminalManager's pass-through list so
 * rebindings keep terminal-to-window chord routing correct. */
function syncManager(keymap: Keymap): void {
  terminalManager.setAppChords(keymapChords(keymap));
}

async function persist(keymap: Keymap): Promise<void> {
  try {
    await setSetting(SETTING_KEYS.keymap, keymap);
  } catch {
    // Persistence is best-effort; never surface keymap write failures.
  }
}

export const useKeymapStore = create<KeymapState>((set, get) => ({
  keymap: { ...DEFAULT_KEYMAP },
  loaded: false,

  load: async () => {
    try {
      const settings = await getAllSettings();
      const keymap = mergeKeymap(settings[SETTING_KEYS.keymap]);
      set({ keymap, loaded: true });
      syncManager(keymap);
    } catch {
      // First run or unreadable settings: keep defaults.
      const keymap = { ...DEFAULT_KEYMAP };
      set({ keymap, loaded: true });
      syncManager(keymap);
    }
  },

  rebind: async (id, chord) => {
    const keymap = { ...get().keymap, [id]: chord };
    set({ keymap });
    syncManager(keymap);
    await persist(keymap);
  },

  resetAction: async (id) => {
    const keymap = { ...get().keymap, [id]: DEFAULT_KEYMAP[id] };
    set({ keymap });
    syncManager(keymap);
    await persist(keymap);
  },

  resetAll: async () => {
    const keymap = { ...DEFAULT_KEYMAP };
    set({ keymap });
    syncManager(keymap);
    await persist(keymap);
  },
}));
