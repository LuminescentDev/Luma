import type { ITheme } from "@xterm/xterm";
import type { SchemeKind } from "../features/terminal/themes";

/*
 * Derive the app's full CSS design-token set from a terminal color scheme so a
 * selected scheme restyles the ENTIRE app chrome (sidebar, title bar, panels,
 * modals, settings), not just the xterm viewport.
 *
 * The tokens mirror the ones declared in src/styles/globals.css (:root). When a
 * concrete scheme is active we write these as inline custom properties on
 * <html>, which win over the stylesheet :root values; when the selection is
 * AUTO we remove them so the native Luma dark/light tokens apply unchanged.
 *
 * Everything here is defensive: imported themes can be sparse or use non-hex
 * color strings (e.g. rgb()/rgba() for selectionBackground). Parsing failures
 * fall back to sensible defaults and never throw.
 */

/** The app CSS custom properties this module derives + applies. Order-agnostic. */
export const APP_TOKEN_KEYS = [
  "--background",
  "--surface",
  "--raised",
  "--border",
  "--foreground",
  "--muted",
  "--accent",
  "--accent-foreground",
  "--glow",
  "--danger",
] as const;

export type AppTokenKey = (typeof APP_TOKEN_KEYS)[number];
export type AppTokens = Record<AppTokenKey, string>;

type Rgb = { r: number; g: number; b: number };

/** Per-kind fallbacks matching globals.css so sparse themes still look native. */
const FALLBACK = {
  dark: {
    background: "#101217",
    foreground: "#f2f3f5",
    accent: "#7c6cf2",
    danger: "#f87171",
    glowAlpha: 0.24,
  },
  light: {
    background: "#f6f7fa",
    foreground: "#1c2433",
    accent: "#0e7ea8",
    danger: "#dc2626",
    glowAlpha: 0.18,
  },
} as const;

/** Mix ratios (fraction toward foreground) for the elevated surfaces, chosen to
 * approximate the native Luma token relationships. Dark schemes lighten toward
 * the foreground; light schemes darken toward it by the same mechanism. */
const SURFACE_RATIOS = {
  dark: { surface: 0.04, raised: 0.09, border: 0.14 },
  light: { surface: 0.03, raised: 0.06, border: 0.13 },
} as const;

/** How far to blend foreground toward background for the muted/secondary text. */
const MUTED_RATIO = 0.42;

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** Parse a #rgb / #rrggbb / #rrggbbaa hex string into RGB, or null if not hex. */
export function hexToRgb(value: string | undefined | null): Rgb | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "");
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b };
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b };
  }
  return null;
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const hex = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Blend two RGB colors: ratio 0 = base, 1 = target. */
function mix(base: Rgb, target: Rgb, ratio: number): Rgb {
  const t = Math.max(0, Math.min(1, ratio));
  return {
    r: base.r + (target.r - base.r) * t,
    g: base.g + (target.g - base.g) * t,
    b: base.b + (target.b - base.b) * t,
  };
}

/**
 * Blend base toward target by ratio and return a hex string. If either input is
 * not a parseable hex color, return the base string unchanged (never crash).
 */
export function blendHex(
  base: string,
  target: string,
  ratio: number,
): string {
  const a = hexToRgb(base);
  const b = hexToRgb(target);
  if (!a || !b) return base;
  return rgbToHex(mix(a, b, ratio));
}

/** WCAG relative luminance (0..1) for choosing readable overlay text. */
export function relativeLuminance(rgb: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Euclidean distance in RGB space (0..~441). */
function distance(a: Rgb, b: Rgb): number {
  return Math.sqrt(
    (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2,
  );
}

/** Minimum separation from both foreground and background for `cursor` to be
 * considered a distinct accent color rather than a restatement of the text. */
const ACCENT_MIN_DISTANCE = 50;

/** First parseable hex among the candidates, or null. */
function firstHex(...candidates: (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (hexToRgb(candidate)) return candidate as string;
  }
  return null;
}

/**
 * Pick a chromatic accent from the scheme: prefer `cursor` when it reads as a
 * distinct color, otherwise fall back through the cyan/blue family, finally the
 * native Luma accent for the kind.
 */
function pickAccent(theme: ITheme, kind: SchemeKind, bg: Rgb, fg: Rgb): string {
  const cursor = hexToRgb(theme.cursor);
  if (
    cursor &&
    distance(cursor, fg) >= ACCENT_MIN_DISTANCE &&
    distance(cursor, bg) >= ACCENT_MIN_DISTANCE
  ) {
    return theme.cursor as string;
  }
  return (
    firstHex(
      theme.brightCyan,
      theme.cyan,
      theme.blue,
      theme.brightBlue,
      theme.magenta,
    ) ?? FALLBACK[kind].accent
  );
}

/**
 * Derive the full app token set from an xterm theme + its kind. Missing or
 * non-hex fields fall back to native Luma values so imported themes stay usable.
 */
export function deriveAppTokens(theme: ITheme, kind: SchemeKind): AppTokens {
  const defaults = FALLBACK[kind];
  const backgroundHex = hexToRgb(theme.background) ? (theme.background as string) : defaults.background;
  const foregroundHex = hexToRgb(theme.foreground) ? (theme.foreground as string) : defaults.foreground;

  const ratios = SURFACE_RATIOS[kind];
  const surface = blendHex(backgroundHex, foregroundHex, ratios.surface);
  const raised = blendHex(backgroundHex, foregroundHex, ratios.raised);
  const border = blendHex(backgroundHex, foregroundHex, ratios.border);
  const muted = blendHex(foregroundHex, backgroundHex, MUTED_RATIO);

  const bgRgb = hexToRgb(backgroundHex) ?? { r: 0, g: 0, b: 0 };
  const fgRgb = hexToRgb(foregroundHex) ?? { r: 255, g: 255, b: 255 };
  const accent = pickAccent(theme, kind, bgRgb, fgRgb);
  const accentRgb = hexToRgb(accent) ?? hexToRgb(defaults.accent)!;
  const accentForeground = relativeLuminance(accentRgb) > 0.45 ? "#000000" : "#ffffff";
  const glow = `rgba(${clamp255(accentRgb.r)}, ${clamp255(accentRgb.g)}, ${clamp255(accentRgb.b)}, ${defaults.glowAlpha})`;
  const danger = firstHex(theme.brightRed, theme.red) ?? defaults.danger;

  return {
    "--background": backgroundHex,
    "--surface": surface,
    "--raised": raised,
    "--border": border,
    "--foreground": foregroundHex,
    "--muted": muted,
    "--accent": accent,
    "--accent-foreground": accentForeground,
    "--glow": glow,
    "--danger": danger,
  };
}

/*
 * Application + coordination state.
 *
 * Two independent inputs decide the app's data-theme attribute: the appearance
 * mode (dark/light/system, owned by useTheme) and the selected scheme (owned by
 * terminalStyleStore). When a concrete scheme is active its kind wins; otherwise
 * the resolved mode wins. Both callers funnel through this module so the result
 * converges regardless of which runs first at startup, without a circular import.
 */

type ActiveScheme = { theme: ITheme; kind: SchemeKind };

let activeScheme: ActiveScheme | null = null;
let resolvedMode: "dark" | "light" = "dark";

function root(): HTMLElement | null {
  return typeof document !== "undefined" ? document.documentElement : null;
}

function reconcileDataTheme(): void {
  const el = root();
  if (!el) return;
  el.dataset.theme = activeScheme ? activeScheme.kind : resolvedMode;
}

function writeTokens(tokens: AppTokens): void {
  const el = root();
  if (!el) return;
  for (const key of APP_TOKEN_KEYS) {
    el.style.setProperty(key, tokens[key]);
  }
}

function removeTokens(): void {
  const el = root();
  if (!el) return;
  for (const key of APP_TOKEN_KEYS) {
    el.style.removeProperty(key);
  }
}

/**
 * Apply (or clear) the app-wide scheme. Pass a resolved scheme to write derived
 * inline tokens and pin data-theme to its kind; pass null (AUTO) to remove the
 * inline tokens and let the appearance mode drive data-theme again.
 */
export function setAppScheme(scheme: ActiveScheme | null): void {
  activeScheme = scheme;
  if (scheme) {
    writeTokens(deriveAppTokens(scheme.theme, scheme.kind));
  } else {
    removeTokens();
  }
  reconcileDataTheme();
}

/**
 * Record the resolved appearance mode (dark/light). Updates data-theme only when
 * no concrete scheme is active; a scheme's kind always wins while one is set.
 */
export function setResolvedMode(mode: "dark" | "light"): void {
  resolvedMode = mode;
  reconcileDataTheme();
}
