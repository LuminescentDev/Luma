import { create } from "zustand";
import { SETTING_KEYS } from "../types";
import { getAllSettings, setSetting } from "../lib/settings";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  terminalManager,
} from "../features/terminal/terminalManager";
import {
  AUTO_SCHEME_ID,
  parseCustomThemes,
  resolveScheme,
  resolveSchemeInfo,
  type CustomTheme,
} from "../features/terminal/themes";
import { setAppScheme } from "../lib/appTheme";

/*
 * Terminal Appearance styling: color scheme (bundled/custom/AUTO), font family,
 * and font size. Persisted device-local through the generic settings commands
 * (mirroring keymapStore) and pushed into terminalManager — which owns the live
 * xterm instances outside React — via applyTerminalStyle. Loaded once at startup
 * (see Layout). Terminal bytes never touch this store.
 */

const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 24;

type TerminalStyleState = {
  /** Selected scheme id: a bundled/custom id, or AUTO_SCHEME_ID for app mode. */
  schemeId: string;
  /** Custom (imported) schemes, resolvable by id alongside the bundled ones. */
  customThemes: CustomTheme[];
  /** User font family; empty string means "use the default stack". */
  fontFamily: string;
  fontSize: number;
  loaded: boolean;

  load: () => Promise<void>;
  setScheme: (id: string) => Promise<void>;
  setFontFamily: (family: string) => Promise<void>;
  setFontSize: (size: number) => Promise<void>;
  addCustomTheme: (theme: CustomTheme) => Promise<void>;
  deleteCustomTheme: (id: string) => Promise<void>;
};

function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size)));
}

function applyScheme(schemeId: string, customThemes: CustomTheme[]): void {
  // Restyle the terminals (manager owns live xterm instances outside React)...
  terminalManager.applyTerminalStyle({
    scheme: resolveScheme(schemeId, customThemes),
  });
  // ...and the whole app chrome, deriving CSS tokens from the same scheme. AUTO
  // (null) clears the inline tokens so the native Luma dark/light look returns.
  setAppScheme(resolveSchemeInfo(schemeId, customThemes));
}

async function persist(key: string, value: unknown): Promise<void> {
  try {
    await setSetting(key, value);
  } catch {
    // Persistence is best-effort; never surface style write failures.
  }
}

export const useTerminalStyleStore = create<TerminalStyleState>((set, get) => ({
  schemeId: AUTO_SCHEME_ID,
  customThemes: [],
  fontFamily: "",
  fontSize: DEFAULT_FONT_SIZE,
  loaded: false,

  load: async () => {
    try {
      const settings = await getAllSettings();
      const customThemes = parseCustomThemes(settings[SETTING_KEYS.terminalCustomThemes]);
      const rawScheme = settings[SETTING_KEYS.terminalScheme];
      const schemeId = typeof rawScheme === "string" && rawScheme ? rawScheme : AUTO_SCHEME_ID;
      const rawFamily = settings[SETTING_KEYS.terminalFontFamily];
      const fontFamily = typeof rawFamily === "string" ? rawFamily : "";
      const fontSize = clampFontSize(Number(settings[SETTING_KEYS.fontSize] ?? DEFAULT_FONT_SIZE));
      set({ schemeId, customThemes, fontFamily, fontSize, loaded: true });
      terminalManager.applyTerminalStyle({
        scheme: resolveScheme(schemeId, customThemes),
        fontFamily: fontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
        fontSize,
      });
      // Restyle the app chrome from the persisted scheme (no-op/clear on AUTO).
      setAppScheme(resolveSchemeInfo(schemeId, customThemes));
    } catch {
      // First run or unreadable settings: keep defaults (already applied).
      set({ loaded: true });
    }
  },

  setScheme: async (id) => {
    set({ schemeId: id });
    applyScheme(id, get().customThemes);
    await persist(SETTING_KEYS.terminalScheme, id);
  },

  setFontFamily: async (family) => {
    set({ fontFamily: family });
    terminalManager.applyTerminalStyle({
      fontFamily: family || DEFAULT_TERMINAL_FONT_FAMILY,
    });
    await persist(SETTING_KEYS.terminalFontFamily, family);
  },

  setFontSize: async (size) => {
    const fontSize = clampFontSize(size);
    set({ fontSize });
    terminalManager.applyTerminalStyle({ fontSize });
    await persist(SETTING_KEYS.fontSize, fontSize);
  },

  addCustomTheme: async (theme) => {
    // Replace any existing theme with the same id (re-import), else append.
    const customThemes = [
      ...get().customThemes.filter((existing) => existing.id !== theme.id),
      theme,
    ];
    set({ customThemes });
    await persist(SETTING_KEYS.terminalCustomThemes, customThemes);
  },

  deleteCustomTheme: async (id) => {
    const customThemes = get().customThemes.filter((theme) => theme.id !== id);
    set({ customThemes });
    // If the deleted theme was the active selection, fall back to AUTO.
    if (get().schemeId === id) {
      set({ schemeId: AUTO_SCHEME_ID });
      applyScheme(AUTO_SCHEME_ID, customThemes);
      await persist(SETTING_KEYS.terminalScheme, AUTO_SCHEME_ID);
    }
    await persist(SETTING_KEYS.terminalCustomThemes, customThemes);
  },
}));
