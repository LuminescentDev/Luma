import { describe, it, expect } from "vitest";
import {
  AUTO_SCHEME_ID,
  BUNDLED_SCHEMES,
  bundledScheme,
  parseCustomThemes,
  resolveScheme,
  type CustomTheme,
} from "./themes";

const custom: CustomTheme = {
  id: "custom:1",
  name: "Mine",
  kind: "dark",
  theme: { background: "#123456", foreground: "#abcdef" },
};

describe("bundled scheme registry", () => {
  it("includes Luma Dark/Light plus popular schemes", () => {
    const ids = BUNDLED_SCHEMES.map((s) => s.id);
    expect(ids).toContain("luma-dark");
    expect(ids).toContain("luma-light");
    expect(ids).toContain("dracula");
    expect(ids).toContain("nord");
    expect(ids.length).toBeGreaterThanOrEqual(8);
  });

  it("looks up a bundled scheme by id", () => {
    expect(bundledScheme("dracula")?.name).toBe("Dracula");
    expect(bundledScheme("nope")).toBeUndefined();
  });
});

describe("resolveScheme", () => {
  it("returns null for AUTO / undefined / unknown ids (follow app mode)", () => {
    expect(resolveScheme(AUTO_SCHEME_ID)).toBeNull();
    expect(resolveScheme(undefined)).toBeNull();
    expect(resolveScheme(null)).toBeNull();
    expect(resolveScheme("does-not-exist")).toBeNull();
  });

  it("resolves a bundled scheme's theme", () => {
    const theme = resolveScheme("dracula");
    expect(theme?.background).toBe("#282a36");
  });

  it("resolves a custom scheme by id", () => {
    expect(resolveScheme("custom:1", [custom])?.background).toBe("#123456");
    // An unknown custom id still falls back to AUTO (null).
    expect(resolveScheme("custom:2", [custom])).toBeNull();
  });
});

describe("parseCustomThemes", () => {
  it("parses a JSON string array, dropping malformed entries", () => {
    const raw = JSON.stringify([
      custom,
      { id: "bad" }, // missing name/theme
      { name: "no id", theme: {} },
      { id: "ok", name: "Ok", kind: "light", theme: { background: "#fff" } },
    ]);
    const parsed = parseCustomThemes(raw);
    expect(parsed.map((t) => t.id)).toEqual(["custom:1", "ok"]);
    expect(parsed[1].kind).toBe("light");
  });

  it("returns [] for corrupt / non-array input", () => {
    expect(parseCustomThemes("not json")).toEqual([]);
    expect(parseCustomThemes(42)).toEqual([]);
    expect(parseCustomThemes(null)).toEqual([]);
  });

  it("defaults kind to dark when absent/invalid", () => {
    const parsed = parseCustomThemes([
      { id: "x", name: "X", theme: { background: "#000" } },
    ]);
    expect(parsed[0].kind).toBe("dark");
  });
});
