import { describe, it, expect, beforeEach } from "vitest";
import type { ITheme } from "@xterm/xterm";
import {
  APP_TOKEN_KEYS,
  blendHex,
  deriveAppTokens,
  hexToRgb,
  relativeLuminance,
  rgbToHex,
  setAppScheme,
  setResolvedMode,
} from "./appTheme";

const DRACULA: ITheme = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#f8f8f2", // equals foreground -> not a distinct accent
  brightCyan: "#a4ffff",
  cyan: "#8be9fd",
  brightRed: "#ff6e6e",
  red: "#ff5555",
};

const ONE_DARK: ITheme = {
  background: "#282c34",
  foreground: "#abb2bf",
  cursor: "#528bff", // distinct blue -> used as accent
  brightCyan: "#56b6c2",
};

describe("hexToRgb / rgbToHex", () => {
  it("parses #rrggbb", () => {
    expect(hexToRgb("#ff8040")).toEqual({ r: 255, g: 128, b: 64 });
  });
  it("parses shorthand #rgb", () => {
    expect(hexToRgb("#f84")).toEqual({ r: 255, g: 136, b: 68 });
  });
  it("parses #rrggbbaa ignoring the alpha byte", () => {
    expect(hexToRgb("#102030ff")).toEqual({ r: 16, g: 32, b: 48 });
  });
  it("returns null for non-hex (rgb()/rgba()/garbage/undefined)", () => {
    expect(hexToRgb("rgba(1,2,3,0.5)")).toBeNull();
    expect(hexToRgb("not-a-color")).toBeNull();
    expect(hexToRgb(undefined)).toBeNull();
    expect(hexToRgb(null)).toBeNull();
  });
  it("round-trips through rgbToHex", () => {
    expect(rgbToHex({ r: 16, g: 32, b: 48 })).toBe("#102030");
  });
});

describe("blendHex", () => {
  it("ratio 0 returns the base, ratio 1 returns the target", () => {
    expect(blendHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(blendHex("#000000", "#ffffff", 1)).toBe("#ffffff");
  });
  it("lightens toward the target at the midpoint", () => {
    expect(blendHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
  it("falls back to the base string when a color is not hex (never crashes)", () => {
    expect(blendHex("rgb(0,0,0)", "#ffffff", 0.5)).toBe("rgb(0,0,0)");
    expect(blendHex("#000000", "rgba(1,1,1,1)", 0.5)).toBe("#000000");
  });
});

describe("relativeLuminance", () => {
  it("is ~0 for black and ~1 for white", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });
});

describe("deriveAppTokens", () => {
  it("emits every app token key", () => {
    const tokens = deriveAppTokens(DRACULA, "dark");
    for (const key of APP_TOKEN_KEYS) {
      expect(typeof tokens[key]).toBe("string");
      expect(tokens[key].length).toBeGreaterThan(0);
    }
  });

  it("uses theme background/foreground verbatim", () => {
    const tokens = deriveAppTokens(DRACULA, "dark");
    expect(tokens["--background"]).toBe("#282a36");
    expect(tokens["--foreground"]).toBe("#f8f8f2");
  });

  it("derives surfaces by blending background toward foreground (dark lightens)", () => {
    const tokens = deriveAppTokens(DRACULA, "dark");
    const bg = relativeLuminance(hexToRgb(tokens["--background"])!);
    const surface = relativeLuminance(hexToRgb(tokens["--surface"])!);
    const raised = relativeLuminance(hexToRgb(tokens["--raised"])!);
    const border = relativeLuminance(hexToRgb(tokens["--border"])!);
    expect(surface).toBeGreaterThan(bg);
    expect(raised).toBeGreaterThan(surface);
    expect(border).toBeGreaterThan(raised);
  });

  it("falls back through the cyan/blue chain when cursor is not distinct", () => {
    // Dracula's cursor equals the foreground, so brightCyan is chosen.
    expect(deriveAppTokens(DRACULA, "dark")["--accent"]).toBe("#a4ffff");
  });

  it("uses a distinct cursor as the accent", () => {
    expect(deriveAppTokens(ONE_DARK, "dark")["--accent"]).toBe("#528bff");
  });

  it("picks accent-foreground by accent luminance", () => {
    // Bright cyan accent -> black text; deep blue accent -> white text.
    expect(deriveAppTokens(DRACULA, "dark")["--accent-foreground"]).toBe("#000000");
    expect(deriveAppTokens(ONE_DARK, "dark")["--accent-foreground"]).toBe("#ffffff");
  });

  it("prefers brightRed then red for danger", () => {
    expect(deriveAppTokens(DRACULA, "dark")["--danger"]).toBe("#ff6e6e");
    expect(
      deriveAppTokens({ ...DRACULA, brightRed: undefined }, "dark")["--danger"],
    ).toBe("#ff5555");
  });

  it("derives a low-alpha glow from the accent color", () => {
    expect(deriveAppTokens(DRACULA, "dark")["--glow"]).toBe(
      "rgba(164, 255, 255, 0.24)",
    );
    expect(deriveAppTokens(DRACULA, "light")["--glow"]).toBe(
      "rgba(164, 255, 255, 0.18)",
    );
  });

  it("falls back to native Luma tokens for a fully sparse theme", () => {
    const dark = deriveAppTokens({}, "dark");
    expect(dark["--background"]).toBe("#101217");
    expect(dark["--foreground"]).toBe("#f2f3f5");
    expect(dark["--accent"]).toBe("#7c6cf2");
    expect(dark["--danger"]).toBe("#f87171");

    const light = deriveAppTokens({}, "light");
    expect(light["--background"]).toBe("#f6f7fa");
    expect(light["--accent"]).toBe("#0e7ea8");
    expect(light["--danger"]).toBe("#dc2626");
  });

  it("never crashes on non-hex background/foreground", () => {
    const tokens = deriveAppTokens(
      { background: "rgb(1,2,3)", foreground: "var(--x)" },
      "dark",
    );
    // Non-hex background/foreground fall back to native Luma values.
    expect(tokens["--background"]).toBe("#101217");
    expect(tokens["--foreground"]).toBe("#f2f3f5");
  });
});

describe("setAppScheme / setResolvedMode (inline token application)", () => {
  const el = document.documentElement;

  beforeEach(() => {
    setAppScheme(null);
    setResolvedMode("dark");
  });

  it("data-theme follows the resolved mode when no scheme is active", () => {
    setResolvedMode("light");
    expect(el.dataset.theme).toBe("light");
    setResolvedMode("dark");
    expect(el.dataset.theme).toBe("dark");
    // No inline tokens are written in AUTO.
    expect(el.style.getPropertyValue("--background")).toBe("");
  });

  it("writes inline tokens and pins data-theme to the scheme kind", () => {
    setResolvedMode("light"); // app mode is light...
    setAppScheme({ theme: DRACULA, kind: "dark" }); // ...but a dark scheme wins
    expect(el.dataset.theme).toBe("dark");
    expect(el.style.getPropertyValue("--background")).toBe("#282a36");
    expect(el.style.getPropertyValue("--accent")).toBe("#a4ffff");
  });

  it("clearing the scheme removes inline tokens and restores mode-driven data-theme", () => {
    setResolvedMode("light");
    setAppScheme({ theme: DRACULA, kind: "dark" });
    setAppScheme(null);
    expect(el.dataset.theme).toBe("light");
    for (const key of APP_TOKEN_KEYS) {
      expect(el.style.getPropertyValue(key)).toBe("");
    }
  });

  it("mode changes do not override an active scheme's kind", () => {
    setAppScheme({ theme: DRACULA, kind: "dark" });
    setResolvedMode("light");
    expect(el.dataset.theme).toBe("dark");
  });
});
