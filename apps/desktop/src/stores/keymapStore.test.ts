import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke } from "../test/tauriMock";
import { useKeymapStore } from "./keymapStore";
import { DEFAULT_KEYMAP } from "../lib/keymap";

/** Reset the store to defaults between tests (module state persists). */
beforeEach(() => {
  useKeymapStore.setState({ keymap: { ...DEFAULT_KEYMAP }, loaded: false });
});

describe("keymapStore round-trip", () => {
  it("deserializes a persisted keymap on load, merging with defaults", async () => {
    setInvoke((cmd) => {
      if (cmd === "settings_get_all") {
        return {
          "keybindings.map": {
            "workspace.newTab": "Ctrl+Alt+N",
            "unknown.action": "Ctrl+Q", // dropped
          },
        };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useKeymapStore.getState().load();
    const { keymap, loaded } = useKeymapStore.getState();
    expect(loaded).toBe(true);
    expect(keymap["workspace.newTab"]).toBe("Ctrl+Alt+N");
    // Missing actions fall back to defaults; unknown ids never appear.
    expect(keymap["workspace.splitRight"]).toBe(DEFAULT_KEYMAP["workspace.splitRight"]);
    expect(keymap).not.toHaveProperty("unknown.action");
  });

  it("falls back to defaults when settings are unreadable", async () => {
    setInvoke((cmd) => {
      if (cmd === "settings_get_all") throw new Error("boom");
      throw new Error(`unexpected ${cmd}`);
    });
    await useKeymapStore.getState().load();
    expect(useKeymapStore.getState().keymap).toEqual(DEFAULT_KEYMAP);
    expect(useKeymapStore.getState().loaded).toBe(true);
  });

  it("serializes the full keymap when an action is rebound", async () => {
    let saved: { key: string; value: unknown } | null = null;
    setInvoke((cmd, args) => {
      if (cmd === "settings_set") {
        saved = { key: args.key as string, value: args.value };
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useKeymapStore.getState().rebind("workspace.newTab", "Ctrl+Alt+N");
    expect(useKeymapStore.getState().keymap["workspace.newTab"]).toBe("Ctrl+Alt+N");
    expect(saved).not.toBeNull();
    expect(saved!.key).toBe("keybindings.map");
    expect((saved!.value as Record<string, string>)["workspace.newTab"]).toBe(
      "Ctrl+Alt+N",
    );
  });

  it("resets a single action and all actions to defaults", async () => {
    setInvoke((cmd) => {
      if (cmd === "settings_set") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    await useKeymapStore.getState().rebind("workspace.splitRight", "Ctrl+Alt+R");
    await useKeymapStore.getState().resetAction("workspace.splitRight");
    expect(useKeymapStore.getState().keymap["workspace.splitRight"]).toBe(
      DEFAULT_KEYMAP["workspace.splitRight"],
    );

    await useKeymapStore.getState().rebind("workspace.newTab", "Ctrl+Alt+N");
    await useKeymapStore.getState().resetAll();
    expect(useKeymapStore.getState().keymap).toEqual(DEFAULT_KEYMAP);
  });
});
