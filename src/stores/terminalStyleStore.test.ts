import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke } from "../test/tauriMock";
import { AUTO_SCHEME_ID, type CustomTheme } from "../features/terminal/themes";
import { useTerminalStyleStore } from "./terminalStyleStore";
import { APP_TOKEN_KEYS } from "../lib/appTheme";
import { SETTING_KEYS } from "../types";

const custom: CustomTheme = {
  id: "custom:1",
  name: "Mine",
  kind: "dark",
  theme: { background: "#123456", foreground: "#abcdef" },
};

function lastSet(): { key: string; value: unknown }[] {
  return writes;
}
let writes: { key: string; value: unknown }[] = [];

let stored: Record<string, unknown> = {};

function tokenValue(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

beforeEach(() => {
  writes = [];
  stored = {};
  setInvoke((cmd, args) => {
    if (cmd === "settings_set") {
      writes.push({ key: args.key as string, value: args.value });
      stored[args.key as string] = args.value;
      return undefined;
    }
    if (cmd === "settings_get_all") {
      return stored;
    }
    throw new Error(`unexpected ${cmd}`);
  });
  // Reset any inline app-theme tokens leaked from a previous test.
  for (const key of APP_TOKEN_KEYS) {
    document.documentElement.style.removeProperty(key);
  }
  useTerminalStyleStore.setState({
    schemeId: AUTO_SCHEME_ID,
    customThemes: [],
    fontFamily: "",
    fontSize: 14,
    loaded: true,
  });
});

describe("terminalStyleStore", () => {
  it("persists a scheme selection under terminal.scheme", async () => {
    await useTerminalStyleStore.getState().setScheme("dracula");
    expect(useTerminalStyleStore.getState().schemeId).toBe("dracula");
    expect(lastSet()).toContainEqual({ key: SETTING_KEYS.terminalScheme, value: "dracula" });
  });

  it("applies app-wide CSS tokens when a scheme is selected, and clears them on AUTO", async () => {
    await useTerminalStyleStore.getState().setScheme("dracula");
    expect(tokenValue("--background")).toBe("#282a36");
    expect(tokenValue("--accent")).not.toBe("");
    expect(document.documentElement.dataset.theme).toBe("dark");

    await useTerminalStyleStore.getState().setScheme(AUTO_SCHEME_ID);
    for (const key of APP_TOKEN_KEYS) {
      expect(tokenValue(key)).toBe("");
    }
  });

  it("applies app-wide tokens on load() from persisted settings", async () => {
    stored[SETTING_KEYS.terminalScheme] = "dracula";
    await useTerminalStyleStore.getState().load();
    expect(useTerminalStyleStore.getState().schemeId).toBe("dracula");
    expect(tokenValue("--background")).toBe("#282a36");
  });

  it("clears app-wide tokens when the active custom theme is deleted", async () => {
    useTerminalStyleStore.setState({ customThemes: [custom], schemeId: custom.id });
    // Re-apply so the inline tokens reflect the active custom theme.
    await useTerminalStyleStore.getState().setScheme(custom.id);
    expect(tokenValue("--background")).toBe("#123456");

    await useTerminalStyleStore.getState().deleteCustomTheme(custom.id);
    expect(useTerminalStyleStore.getState().schemeId).toBe(AUTO_SCHEME_ID);
    for (const key of APP_TOKEN_KEYS) {
      expect(tokenValue(key)).toBe("");
    }
  });

  it("clamps font size to 8..24", async () => {
    await useTerminalStyleStore.getState().setFontSize(99);
    expect(useTerminalStyleStore.getState().fontSize).toBe(24);
    await useTerminalStyleStore.getState().setFontSize(2);
    expect(useTerminalStyleStore.getState().fontSize).toBe(8);
    const all = lastSet();
    expect(all[all.length - 1]).toEqual({ key: SETTING_KEYS.fontSize, value: 8 });
  });

  it("adds and de-duplicates custom themes", async () => {
    await useTerminalStyleStore.getState().addCustomTheme(custom);
    await useTerminalStyleStore
      .getState()
      .addCustomTheme({ ...custom, name: "Renamed" });
    const themes = useTerminalStyleStore.getState().customThemes;
    expect(themes).toHaveLength(1);
    expect(themes[0].name).toBe("Renamed");
  });

  it("resets to AUTO when the selected custom theme is deleted", async () => {
    useTerminalStyleStore.setState({ customThemes: [custom], schemeId: custom.id });
    await useTerminalStyleStore.getState().deleteCustomTheme(custom.id);
    expect(useTerminalStyleStore.getState().customThemes).toHaveLength(0);
    expect(useTerminalStyleStore.getState().schemeId).toBe(AUTO_SCHEME_ID);
  });
});
