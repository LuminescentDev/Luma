import type { ITheme } from "@xterm/xterm";

/*
 * Pure parsers that turn external terminal-theme files into an xterm `ITheme`.
 * Two formats are supported:
 *   - VS Code color-theme JSON (the `workbench.colorCustomizations`-style
 *     `terminal.ansi*` / `terminal.background` / `terminal.foreground` keys).
 *   - iTerm2 `.itermcolors` XML property lists ("Ansi 0 Color".."Ansi 15 Color"
 *     dicts of 0..1 float components, plus Background/Foreground/Cursor colors).
 *
 * Every parser throws a plain `Error` with a human-readable message on malformed
 * input so the import UI can surface it; callers never get a partial theme.
 */

/** Whether a parsed theme reads as dark or light (used to group + preview it). */
export type ImportedThemeKind = "dark" | "light";

/** The 16 ANSI slots in xterm ITheme order. */
const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** Accept #rgb, #rgba, #rrggbb, and #rrggbbaa (CSS hex colors xterm understands). */
function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
}

/** Estimate whether a background hex reads as dark, for grouping/preview chrome.
 * Uses perceived luminance; defaults to "dark" when the color can't be parsed. */
export function deriveThemeKind(background: string): ImportedThemeKind {
  const hex = background.replace("#", "");
  const full =
    hex.length === 3
      ? hex.split("").map((c) => c + c).join("")
      : hex.slice(0, 6);
  if (full.length < 6) return "dark";
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return "dark";
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5 ? "dark" : "light";
}

// --- VS Code color-theme JSON -------------------------------------------------

/** VS Code -> xterm key map. Both the top-level object and a nested `colors`
 * object are accepted (theme files use `colors`; a raw customization snippet may
 * not). */
const VSCODE_KEYS: Record<(typeof ANSI_KEYS)[number], string> = {
  black: "terminal.ansiBlack",
  red: "terminal.ansiRed",
  green: "terminal.ansiGreen",
  yellow: "terminal.ansiYellow",
  blue: "terminal.ansiBlue",
  magenta: "terminal.ansiMagenta",
  cyan: "terminal.ansiCyan",
  white: "terminal.ansiWhite",
  brightBlack: "terminal.ansiBrightBlack",
  brightRed: "terminal.ansiBrightRed",
  brightGreen: "terminal.ansiBrightGreen",
  brightYellow: "terminal.ansiBrightYellow",
  brightBlue: "terminal.ansiBrightBlue",
  brightMagenta: "terminal.ansiBrightMagenta",
  brightCyan: "terminal.ansiBrightCyan",
  brightWhite: "terminal.ansiBrightWhite",
};

/** Parse a VS Code color-theme JSON string into an ITheme. Requires all 16 ANSI
 * colors plus a terminal background + foreground. Throws on malformed input. */
export function parseVsCodeTheme(json: string): ITheme {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Theme JSON must be an object.");
  }
  const root = parsed as Record<string, unknown>;
  const colors =
    root.colors && typeof root.colors === "object"
      ? (root.colors as Record<string, unknown>)
      : root;

  const readColor = (key: string): string => {
    const value = colors[key];
    if (!isHexColor(value)) {
      throw new Error(`Missing or invalid "${key}" color.`);
    }
    return value;
  };

  const background = readColor("terminal.background");
  const foreground = readColor("terminal.foreground");

  const theme: ITheme = { background, foreground };
  for (const key of ANSI_KEYS) {
    theme[key] = readColor(VSCODE_KEYS[key]);
  }

  // Optional extras when present and valid.
  const cursor = colors["terminalCursor.foreground"];
  theme.cursor = isHexColor(cursor) ? cursor : foreground;
  const cursorAccent = colors["terminalCursor.background"];
  if (isHexColor(cursorAccent)) theme.cursorAccent = cursorAccent;
  const selection = colors["terminal.selectionBackground"];
  if (isHexColor(selection)) theme.selectionBackground = selection;

  return theme;
}

// --- iTerm2 .itermcolors XML plist -------------------------------------------

const ITERM_ANSI = ANSI_KEYS.map((_, index) => `Ansi ${index} Color`);

/** Flatten a plist <dict> element into an ordered key -> value-element map. In a
 * plist dict, <key> nodes alternate with their value nodes. */
function plistDictEntries(dict: Element): Map<string, Element> {
  const map = new Map<string, Element>();
  const children = Array.from(dict.children);
  for (let i = 0; i < children.length; i += 1) {
    if (children[i].tagName === "key") {
      const value = children[i + 1];
      if (value) map.set(children[i].textContent?.trim() ?? "", value);
    }
  }
  return map;
}

function readComponent(el: Element | undefined): number | null {
  if (!el) return null;
  const value = Number(el.textContent);
  return Number.isFinite(value) ? value : null;
}

function componentToHex(value: number): string {
  const int = Math.round(Math.max(0, Math.min(1, value)) * 255);
  return int.toString(16).padStart(2, "0");
}

/** Convert an iTerm color <dict> (Red/Green/Blue Component reals) to "#rrggbb". */
function itermColor(el: Element): string | null {
  if (el.tagName !== "dict") return null;
  const entries = plistDictEntries(el);
  const r = readComponent(entries.get("Red Component"));
  const g = readComponent(entries.get("Green Component"));
  const b = readComponent(entries.get("Blue Component"));
  if (r === null || g === null || b === null) return null;
  return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
}

/** Parse an iTerm2 `.itermcolors` XML plist string into an ITheme. Requires all
 * 16 ANSI colors plus Background + Foreground. Throws on malformed input. */
export function parseItermColors(xml: string): ITheme {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Not valid XML.");
  }
  const dict = doc.querySelector("plist > dict") ?? doc.querySelector("dict");
  if (!dict) throw new Error("Missing plist <dict> root.");
  const entries = plistDictEntries(dict);

  const readColor = (key: string): string => {
    const el = entries.get(key);
    const color = el ? itermColor(el) : null;
    if (!color) throw new Error(`Missing or invalid "${key}".`);
    return color;
  };

  const background = readColor("Background Color");
  const foreground = readColor("Foreground Color");
  const theme: ITheme = { background, foreground };
  ANSI_KEYS.forEach((key, index) => {
    theme[key] = readColor(ITERM_ANSI[index]);
  });

  const cursorEl = entries.get("Cursor Color");
  const cursor = cursorEl ? itermColor(cursorEl) : null;
  theme.cursor = cursor ?? foreground;
  const cursorTextEl = entries.get("Cursor Text Color");
  const cursorAccent = cursorTextEl ? itermColor(cursorTextEl) : null;
  if (cursorAccent) theme.cursorAccent = cursorAccent;
  const selectionEl = entries.get("Selection Color");
  const selection = selectionEl ? itermColor(selectionEl) : null;
  if (selection) theme.selectionBackground = selection;

  return theme;
}

/** The result of importing a theme from arbitrary pasted text. */
export type ParsedImportedTheme = { theme: ITheme; kind: ImportedThemeKind };

/**
 * Detect the format of pasted text and parse it. XML/plist input (starting with
 * `<?xml` or `<plist`) is treated as iTerm2; anything else is tried as VS Code
 * JSON. Throws with a readable message when neither parser accepts the input.
 */
export function parseImportedTheme(text: string): ParsedImportedTheme {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste a theme to import.");
  const looksXml = trimmed.startsWith("<?xml") || trimmed.startsWith("<plist") || trimmed.startsWith("<");
  const theme = looksXml ? parseItermColors(trimmed) : parseVsCodeTheme(trimmed);
  return { theme, kind: deriveThemeKind(theme.background ?? "#000000") };
}
