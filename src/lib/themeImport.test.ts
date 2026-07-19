import { describe, it, expect } from "vitest";
import {
  deriveThemeKind,
  parseImportedTheme,
  parseItermColors,
  parseVsCodeTheme,
} from "./themeImport";

const VSCODE_FIXTURE = JSON.stringify({
  name: "Test Theme",
  colors: {
    "terminal.background": "#101014",
    "terminal.foreground": "#e0e0e0",
    "terminalCursor.foreground": "#00ffcc",
    "terminal.selectionBackground": "#264f78",
    "terminal.ansiBlack": "#000000",
    "terminal.ansiRed": "#ff0000",
    "terminal.ansiGreen": "#00ff00",
    "terminal.ansiYellow": "#ffff00",
    "terminal.ansiBlue": "#0000ff",
    "terminal.ansiMagenta": "#ff00ff",
    "terminal.ansiCyan": "#00ffff",
    "terminal.ansiWhite": "#c0c0c0",
    "terminal.ansiBrightBlack": "#808080",
    "terminal.ansiBrightRed": "#ff8080",
    "terminal.ansiBrightGreen": "#80ff80",
    "terminal.ansiBrightYellow": "#ffff80",
    "terminal.ansiBrightBlue": "#8080ff",
    "terminal.ansiBrightMagenta": "#ff80ff",
    "terminal.ansiBrightCyan": "#80ffff",
    "terminal.ansiBrightWhite": "#ffffff",
  },
});

function itermColorDict(name: string, r: number, g: number, b: number): string {
  return `
    <key>${name}</key>
    <dict>
      <key>Red Component</key><real>${r}</real>
      <key>Green Component</key><real>${g}</real>
      <key>Blue Component</key><real>${b}</real>
    </dict>`;
}

const ITERM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  ${Array.from({ length: 16 }, (_, i) => itermColorDict(`Ansi ${i} Color`, i / 15, 0, 0)).join("")}
  ${itermColorDict("Background Color", 0, 0, 0)}
  ${itermColorDict("Foreground Color", 1, 1, 1)}
  ${itermColorDict("Cursor Color", 0, 1, 0)}
</dict>
</plist>`;

describe("parseVsCodeTheme", () => {
  it("maps terminal.ansi* + background/foreground into an ITheme", () => {
    const theme = parseVsCodeTheme(VSCODE_FIXTURE);
    expect(theme.background).toBe("#101014");
    expect(theme.foreground).toBe("#e0e0e0");
    expect(theme.black).toBe("#000000");
    expect(theme.brightWhite).toBe("#ffffff");
    expect(theme.red).toBe("#ff0000");
    expect(theme.brightCyan).toBe("#80ffff");
    expect(theme.cursor).toBe("#00ffcc");
    expect(theme.selectionBackground).toBe("#264f78");
  });

  it("accepts colors at the top level (no nested colors object)", () => {
    const raw = JSON.parse(VSCODE_FIXTURE) as { colors: Record<string, string> };
    const theme = parseVsCodeTheme(JSON.stringify(raw.colors));
    expect(theme.blue).toBe("#0000ff");
  });

  it("rejects non-JSON input", () => {
    expect(() => parseVsCodeTheme("not json")).toThrow();
  });

  it("rejects JSON missing required ansi colors", () => {
    expect(() =>
      parseVsCodeTheme(
        JSON.stringify({
          colors: { "terminal.background": "#000000", "terminal.foreground": "#ffffff" },
        }),
      ),
    ).toThrow();
  });

  it("rejects invalid hex values", () => {
    const broken = JSON.parse(VSCODE_FIXTURE) as { colors: Record<string, string> };
    broken.colors["terminal.ansiBlack"] = "rgb(0,0,0)";
    expect(() => parseVsCodeTheme(JSON.stringify(broken))).toThrow();
  });
});

describe("parseItermColors", () => {
  it("converts Ansi 0..15 + Background/Foreground float components to hex", () => {
    const theme = parseItermColors(ITERM_FIXTURE);
    expect(theme.background).toBe("#000000");
    expect(theme.foreground).toBe("#ffffff");
    expect(theme.black).toBe("#000000"); // Ansi 0 = 0/15 red
    expect(theme.brightWhite).toBe("#ff0000"); // Ansi 15 = 15/15 red
    expect(theme.cursor).toBe("#00ff00");
  });

  it("rejects non-XML input", () => {
    expect(() => parseItermColors("{ not xml }")).toThrow();
  });

  it("rejects a plist missing required color dicts", () => {
    const partial = `<?xml version="1.0"?><plist><dict>${itermColorDict(
      "Background Color",
      0,
      0,
      0,
    )}</dict></plist>`;
    expect(() => parseItermColors(partial)).toThrow();
  });
});

describe("parseImportedTheme", () => {
  it("detects iTerm XML vs VS Code JSON and derives kind", () => {
    const iterm = parseImportedTheme(ITERM_FIXTURE);
    expect(iterm.theme.background).toBe("#000000");
    expect(iterm.kind).toBe("dark");

    const vscode = parseImportedTheme(VSCODE_FIXTURE);
    expect(vscode.theme.foreground).toBe("#e0e0e0");
    expect(vscode.kind).toBe("dark");
  });

  it("throws on empty input", () => {
    expect(() => parseImportedTheme("   ")).toThrow();
  });
});

describe("deriveThemeKind", () => {
  it("classifies by background luminance", () => {
    expect(deriveThemeKind("#000000")).toBe("dark");
    expect(deriveThemeKind("#ffffff")).toBe("light");
    expect(deriveThemeKind("#fdf6e3")).toBe("light");
  });
});
