import { describe, it, expect } from "vitest";
import {
  DEFAULT_KEYMAP,
  canonicalizeChord,
  chordFromEvent,
  findConflict,
  hasRequiredModifier,
  isBindableChord,
  matchesChord,
  mergeKeymap,
  parseChord,
  resolveAction,
  type ChordEvent,
} from "./keymap";

/** Build a ChordEvent, defaulting all modifiers off. */
function ev(code: string, mods: Partial<ChordEvent> = {}): ChordEvent {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  };
}

describe("parseChord / matchesChord", () => {
  it("parses modifiers and letter/token codes", () => {
    expect(parseChord("Ctrl+Shift+B")).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      code: "KeyB",
    });
    expect(parseChord("Ctrl+Alt+Up")).toEqual({
      ctrl: true,
      alt: true,
      shift: false,
      meta: false,
      code: "ArrowUp",
    });
    expect(parseChord("Ctrl+PageDown")?.code).toBe("PageDown");
    expect(parseChord("Ctrl+1")?.code).toBe("Digit1");
  });

  it("returns null for empty input", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord("   ")).toBeNull();
  });

  it("matches only on exact modifier equality", () => {
    const chord = parseChord("Ctrl+Shift+T")!;
    expect(matchesChord(chord, ev("KeyT", { ctrlKey: true, shiftKey: true }))).toBe(true);
    // Extra Alt held -> no match (prevents accidental over-broad firing).
    expect(
      matchesChord(chord, ev("KeyT", { ctrlKey: true, shiftKey: true, altKey: true })),
    ).toBe(false);
    // Different key -> no match.
    expect(matchesChord(chord, ev("KeyD", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

describe("hasRequiredModifier / isBindableChord", () => {
  it("requires at least one of Ctrl/Alt/Meta", () => {
    expect(hasRequiredModifier(parseChord("Ctrl+B")!)).toBe(true);
    expect(hasRequiredModifier(parseChord("Alt+B")!)).toBe(true);
    expect(hasRequiredModifier(parseChord("Meta+B")!)).toBe(true);
    // Shift alone (or a bare key) is not enough.
    expect(hasRequiredModifier(parseChord("Shift+B")!)).toBe(false);
    expect(hasRequiredModifier(parseChord("B")!)).toBe(false);
  });

  it("isBindableChord rejects unmodified and Shift-only chords", () => {
    expect(isBindableChord("Ctrl+Shift+B")).toBe(true);
    expect(isBindableChord("Shift+B")).toBe(false);
    expect(isBindableChord("B")).toBe(false);
    expect(isBindableChord("")).toBe(false);
  });
});

describe("chordFromEvent / canonicalizeChord", () => {
  it("builds a canonical chord from a keydown", () => {
    expect(
      chordFromEvent(ev("KeyB", { ctrlKey: true, shiftKey: true })),
    ).toBe("Ctrl+Shift+B");
    expect(chordFromEvent(ev("ArrowUp", { ctrlKey: true, altKey: true }))).toBe(
      "Ctrl+Alt+Up",
    );
  });

  it("ignores modifier-only presses (keeps capture waiting)", () => {
    expect(chordFromEvent(ev("ControlLeft", { ctrlKey: true }))).toBeNull();
    expect(chordFromEvent(ev("ShiftRight", { shiftKey: true }))).toBeNull();
  });

  it("canonicalizes modifier order", () => {
    expect(canonicalizeChord("Shift+Ctrl+B")).toBe("Ctrl+Shift+B");
    expect(canonicalizeChord("Alt+Ctrl+Up")).toBe("Ctrl+Alt+Up");
    expect(canonicalizeChord("cmd+b")).toBe("Meta+B");
  });
});

describe("resolveAction", () => {
  it("resolves the bound action for an event", () => {
    expect(
      resolveAction(DEFAULT_KEYMAP, ev("KeyT", { ctrlKey: true, shiftKey: true })),
    ).toBe("workspace.newTab");
    expect(
      resolveAction(DEFAULT_KEYMAP, ev("ArrowUp", { ctrlKey: true, altKey: true })),
    ).toBe("terminal.jumpPreviousPrompt");
  });

  it("returns null for unbound chords", () => {
    expect(resolveAction(DEFAULT_KEYMAP, ev("KeyZ", { ctrlKey: true }))).toBeNull();
  });

  it("honors a rebind", () => {
    const remapped = { ...DEFAULT_KEYMAP, "workspace.newTab": "Ctrl+Alt+N" };
    expect(
      resolveAction(remapped, ev("KeyN", { ctrlKey: true, altKey: true })),
    ).toBe("workspace.newTab");
    // The old chord no longer resolves to it.
    expect(
      resolveAction(remapped, ev("KeyT", { ctrlKey: true, shiftKey: true })),
    ).toBeNull();
  });
});

describe("findConflict", () => {
  it("detects a chord already bound to another action", () => {
    // Ctrl+Shift+D is splitRight by default.
    expect(findConflict(DEFAULT_KEYMAP, "workspace.newTab", "Ctrl+Shift+D")).toBe(
      "workspace.splitRight",
    );
  });

  it("ignores the action's own current chord and free chords", () => {
    expect(
      findConflict(DEFAULT_KEYMAP, "workspace.splitRight", "Ctrl+Shift+D"),
    ).toBeNull();
    expect(findConflict(DEFAULT_KEYMAP, "workspace.newTab", "Ctrl+Alt+N")).toBeNull();
  });

  it("compares canonically (modifier order independent)", () => {
    expect(findConflict(DEFAULT_KEYMAP, "workspace.newTab", "Shift+Ctrl+D")).toBe(
      "workspace.splitRight",
    );
  });
});

describe("mergeKeymap", () => {
  it("fills missing actions with defaults", () => {
    expect(mergeKeymap({})).toEqual(DEFAULT_KEYMAP);
    expect(mergeKeymap(null)).toEqual(DEFAULT_KEYMAP);
    expect(mergeKeymap("nope")).toEqual(DEFAULT_KEYMAP);
  });

  it("keeps valid overrides, canonicalized", () => {
    const merged = mergeKeymap({ "workspace.newTab": "Shift+Ctrl+N" });
    expect(merged["workspace.newTab"]).toBe("Ctrl+Shift+N");
    // Untouched actions keep their defaults.
    expect(merged["workspace.splitRight"]).toBe(DEFAULT_KEYMAP["workspace.splitRight"]);
  });

  it("drops unknown actions and invalid/unbindable chords", () => {
    const merged = mergeKeymap({
      "unknown.action": "Ctrl+Q",
      "workspace.newTab": "B", // no required modifier -> ignored
    });
    expect(merged).not.toHaveProperty("unknown.action");
    expect(merged["workspace.newTab"]).toBe(DEFAULT_KEYMAP["workspace.newTab"]);
  });
});
