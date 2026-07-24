import type { ITheme } from "@xterm/xterm";
import { DARK_THEME, LIGHT_THEME } from "./terminalManager";

/*
 * Registry of bundled xterm color schemes plus helpers for resolving a stored
 * selection (bundled id or an imported custom theme) into an xterm ITheme.
 *
 * "Luma Dark" / "Luma Light" reuse the manager's built-in defaults so the
 * bundled list and the app's native look never drift apart. The special
 * selection value `AUTO_SCHEME_ID` (or an unknown/missing id) means "follow the
 * app light/dark mode" — resolveScheme returns null in that case and the manager
 * falls back to its light/dark default.
 */

/** Whether a scheme reads as dark or light (drives grouping + preview chrome). */
export type SchemeKind = "dark" | "light";

export type TerminalScheme = {
  id: string;
  name: string;
  kind: SchemeKind;
  theme: ITheme;
};

/** A user-imported scheme persisted (as JSON) in the settings store. */
export type CustomTheme = {
  id: string;
  name: string;
  kind: SchemeKind;
  theme: ITheme;
};

/** Selection value meaning "follow the app light/dark mode with Luma's palette". */
export const AUTO_SCHEME_ID = "auto";

const DRACULA: ITheme = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#f8f8f2",
  cursorAccent: "#282a36",
  selectionBackground: "rgba(68, 71, 90, 0.55)",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

const SOLARIZED_DARK: ITheme = {
  background: "#002b36",
  foreground: "#839496",
  cursor: "#93a1a1",
  cursorAccent: "#002b36",
  selectionBackground: "rgba(7, 54, 66, 0.85)",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const SOLARIZED_LIGHT: ITheme = {
  background: "#fdf6e3",
  foreground: "#657b83",
  cursor: "#586e75",
  cursorAccent: "#fdf6e3",
  selectionBackground: "rgba(238, 232, 213, 0.9)",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const NORD: ITheme = {
  background: "#2e3440",
  foreground: "#d8dee9",
  cursor: "#d8dee9",
  cursorAccent: "#2e3440",
  selectionBackground: "rgba(67, 76, 94, 0.9)",
  black: "#3b4252",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  magenta: "#b48ead",
  cyan: "#88c0d0",
  white: "#e5e9f0",
  brightBlack: "#4c566a",
  brightRed: "#bf616a",
  brightGreen: "#a3be8c",
  brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1",
  brightMagenta: "#b48ead",
  brightCyan: "#8fbcbb",
  brightWhite: "#eceff4",
};

const GRUVBOX_DARK: ITheme = {
  background: "#282828",
  foreground: "#ebdbb2",
  cursor: "#ebdbb2",
  cursorAccent: "#282828",
  selectionBackground: "rgba(60, 56, 54, 0.9)",
  black: "#282828",
  red: "#cc241d",
  green: "#98971a",
  yellow: "#d79921",
  blue: "#458588",
  magenta: "#b16286",
  cyan: "#689d6a",
  white: "#a89984",
  brightBlack: "#928374",
  brightRed: "#fb4934",
  brightGreen: "#b8bb26",
  brightYellow: "#fabd2f",
  brightBlue: "#83a598",
  brightMagenta: "#d3869b",
  brightCyan: "#8ec07c",
  brightWhite: "#ebdbb2",
};

const ONE_DARK: ITheme = {
  background: "#282c34",
  foreground: "#abb2bf",
  cursor: "#528bff",
  cursorAccent: "#282c34",
  selectionBackground: "rgba(62, 68, 81, 0.9)",
  black: "#282c34",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

/** Bundled schemes, in display order. Luma Dark/Light come first as the
 * defaults; the rest are popular community palettes. */
export const BUNDLED_SCHEMES: TerminalScheme[] = [
  { id: "luma-dark", name: "Luma Dark", kind: "dark", theme: DARK_THEME },
  { id: "luma-light", name: "Luma Light", kind: "light", theme: LIGHT_THEME },
  { id: "dracula", name: "Dracula", kind: "dark", theme: DRACULA },
  { id: "solarized-dark", name: "Solarized Dark", kind: "dark", theme: SOLARIZED_DARK },
  { id: "solarized-light", name: "Solarized Light", kind: "light", theme: SOLARIZED_LIGHT },
  { id: "nord", name: "Nord", kind: "dark", theme: NORD },
  { id: "gruvbox-dark", name: "Gruvbox Dark", kind: "dark", theme: GRUVBOX_DARK },
  { id: "one-dark", name: "One Dark", kind: "dark", theme: ONE_DARK },
];

/** Look up a bundled scheme by id. */
export function bundledScheme(id: string): TerminalScheme | undefined {
  return BUNDLED_SCHEMES.find((scheme) => scheme.id === id);
}

/** Parse the persisted custom-themes setting (JSON array) into a typed list,
 * dropping any entry that is not a well-formed { id, name, theme }. Defensive so
 * a corrupted setting can never crash the settings screen or the manager. */
export function parseCustomThemes(raw: unknown): CustomTheme[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const result: CustomTheme[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string") continue;
    if (typeof record.theme !== "object" || record.theme === null) continue;
    const kind: SchemeKind = record.kind === "light" ? "light" : "dark";
    result.push({
      id: record.id,
      name: record.name,
      kind,
      theme: record.theme as ITheme,
    });
  }
  return result;
}

/**
 * Resolve a stored selection into its scheme (theme + kind), or null to follow
 * the app's light/dark mode. `AUTO_SCHEME_ID`, undefined, and any unknown id all
 * resolve to null. Custom (imported) themes are matched by id. The `kind` is
 * needed by the app-wide theming (data-theme + token derivation), so callers
 * that only need the ITheme use `resolveScheme` below.
 */
export function resolveSchemeInfo(
  id: string | undefined | null,
  customThemes: CustomTheme[] = [],
): { theme: ITheme; kind: SchemeKind } | null {
  if (!id || id === AUTO_SCHEME_ID) return null;
  const bundled = bundledScheme(id);
  if (bundled) return { theme: bundled.theme, kind: bundled.kind };
  const custom = customThemes.find((theme) => theme.id === id);
  return custom ? { theme: custom.theme, kind: custom.kind } : null;
}

/**
 * Resolve a stored selection into an xterm ITheme, or null to follow the app's
 * light/dark mode (the manager's default). `AUTO_SCHEME_ID`, undefined, and any
 * unknown id all resolve to null. Custom (imported) themes are matched by id.
 */
export function resolveScheme(
  id: string | undefined | null,
  customThemes: CustomTheme[] = [],
): ITheme | null {
  return resolveSchemeInfo(id, customThemes)?.theme ?? null;
}
