import { describe, it, expect, beforeEach } from "vitest";
import {
  ARROW_SEQUENCES,
  ARROW_STEP_PX,
  DOUBLE_TAP_MS,
  LONG_PRESS_MS,
  MOVE_SLOP_PX,
  TAB_SEQUENCE,
  TAP_MAX_MS,
  createTerminalGestures,
  type GestureOptions,
  type PadState,
} from "./terminalGestures";

/*
 * The recognizer takes its clock from event timestamps and its timer from an
 * injected scheduler, so every case here is deterministic: `fireLongPress()`
 * stands in for the 350ms elapsing, and timestamps are passed explicitly.
 */

let keys: string[];
let pads: (PadState | null)[];
let pending: (() => void) | null;

function harness(overrides: Partial<GestureOptions> = {}) {
  return createTerminalGestures({
    arrowPad: true,
    doubleTapTab: true,
    onKey: (data) => keys.push(data),
    onPad: (pad) => pads.push(pad),
    schedule: (fn) => {
      pending = fn;
      return () => {
        if (pending === fn) pending = null;
      };
    },
    ...overrides,
  });
}

/** Run the armed long-press timer, if it has not been cancelled. */
function fireLongPress() {
  const fn = pending;
  pending = null;
  fn?.();
}

/** The most recent pad update the recognizer emitted. */
function latestPad(): PadState | null | undefined {
  return pads[pads.length - 1];
}

beforeEach(() => {
  keys = [];
  pads = [];
  pending = null;
});

describe("arrow pad", () => {
  it("opens on long press and emits one arrow per step dragged", () => {
    const gestures = harness();
    gestures.start({ x: 100, y: 100, t: 0 }, 1);
    fireLongPress();

    expect(gestures.isPadActive()).toBe(true);
    expect(pads).toEqual([{ x: 100, y: 100, direction: null }]);

    gestures.move({ x: 100, y: 100 + ARROW_STEP_PX * 2, t: 400 });
    expect(keys).toEqual([ARROW_SEQUENCES.down, ARROW_SEQUENCES.down]);
    expect(latestPad()).toEqual({ x: 100, y: 100, direction: "down" });
  });

  it("keeps emitting across successive moves without re-crossing the origin", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    fireLongPress();

    gestures.move({ x: 0, y: ARROW_STEP_PX, t: 10 });
    gestures.move({ x: 0, y: ARROW_STEP_PX * 2, t: 20 });
    gestures.move({ x: 0, y: ARROW_STEP_PX * 3, t: 30 });

    expect(keys).toEqual([
      ARROW_SEQUENCES.down,
      ARROW_SEQUENCES.down,
      ARROW_SEQUENCES.down,
    ]);
  });

  it("emits the opposite arrow when the finger drags back", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    fireLongPress();

    gestures.move({ x: ARROW_STEP_PX * 2, y: 0, t: 10 });
    keys.length = 0;
    gestures.move({ x: 0, y: 0, t: 20 });

    expect(keys).toEqual([ARROW_SEQUENCES.left, ARROW_SEQUENCES.left]);
  });

  it("follows the dominant axis only, so a horizontal drag never sends up/down", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    fireLongPress();

    // Drifts vertically, but never as far as it travels horizontally.
    gestures.move({ x: ARROW_STEP_PX * 3, y: ARROW_STEP_PX - 1, t: 10 });

    expect(keys).toEqual([
      ARROW_SEQUENCES.right,
      ARROW_SEQUENCES.right,
      ARROW_SEQUENCES.right,
    ]);
  });

  it("consumes moves while open so the caller can block xterm scrolling", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    expect(gestures.move({ x: 1, y: 1, t: 5 })).toBe(false);
    fireLongPress();
    expect(gestures.move({ x: 1, y: 2, t: 10 })).toBe(true);
  });

  it("closes on release", () => {
    const gestures = harness();
    gestures.start({ x: 10, y: 10, t: 0 }, 1);
    fireLongPress();
    expect(gestures.end({ x: 10, y: 10, t: 900 })).toBe(true);

    expect(gestures.isPadActive()).toBe(false);
    expect(latestPad()).toBeNull();
  });

  it("closes and stops emitting when the OS cancels the touch", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    fireLongPress();
    gestures.cancel();

    expect(latestPad()).toBeNull();
    expect(gestures.move({ x: 0, y: ARROW_STEP_PX * 4, t: 50 })).toBe(false);
    expect(keys).toEqual([]);
  });

  it("stands aside when the finger moves before the long press fires", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    gestures.move({ x: 0, y: MOVE_SLOP_PX + 1, t: 40 });
    fireLongPress();

    expect(gestures.isPadActive()).toBe(false);
    expect(pads).toEqual([]);
    expect(gestures.move({ x: 0, y: 200, t: 80 })).toBe(false);
    expect(keys).toEqual([]);
  });

  it("stands aside for a second finger (pinch / two-finger scroll)", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    fireLongPress();
    gestures.start({ x: 80, y: 80, t: 10 }, 2);

    expect(gestures.isPadActive()).toBe(false);
    expect(latestPad()).toBeNull();
    expect(gestures.move({ x: 0, y: 200, t: 20 })).toBe(false);
    expect(keys).toEqual([]);
  });

  it("never arms the timer when the gesture is disabled", () => {
    const gestures = harness({ arrowPad: false });
    gestures.start({ x: 0, y: 0, t: 0 }, 1);

    expect(pending).toBeNull();
    fireLongPress();
    expect(gestures.isPadActive()).toBe(false);
  });

  it("re-arms cleanly for a second gesture after the first ends", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    fireLongPress();
    gestures.end({ x: 0, y: 0, t: 500 });

    gestures.start({ x: 50, y: 50, t: 600 }, 1);
    fireLongPress();
    gestures.move({ x: 50, y: 50 - ARROW_STEP_PX, t: 700 });

    expect(gestures.isPadActive()).toBe(true);
    expect(keys).toEqual([ARROW_SEQUENCES.up]);
  });
});

describe("double-tap Tab", () => {
  it("sends Tab on the second quick tap in the same spot", () => {
    const gestures = harness();
    gestures.start({ x: 40, y: 40, t: 0 }, 1);
    expect(gestures.end({ x: 40, y: 40, t: 60 })).toBe(false);
    gestures.start({ x: 42, y: 41, t: 160 }, 1);
    expect(gestures.end({ x: 42, y: 41, t: 210 })).toBe(true);

    expect(keys).toEqual([TAB_SEQUENCE]);
  });

  it("does not fire again on a third tap", () => {
    const gestures = harness();
    const tap = (t: number) => {
      gestures.start({ x: 0, y: 0, t }, 1);
      gestures.end({ x: 0, y: 0, t: t + 20 });
    };
    tap(0);
    tap(100);
    tap(200);

    expect(keys).toEqual([TAB_SEQUENCE]);
  });

  it("ignores taps too far apart in time", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    gestures.end({ x: 0, y: 0, t: 20 });
    gestures.start({ x: 0, y: 0, t: 20 + DOUBLE_TAP_MS + 1 }, 1);
    gestures.end({ x: 0, y: 0, t: 40 + DOUBLE_TAP_MS + 1 });

    expect(keys).toEqual([]);
  });

  it("ignores taps too far apart on screen", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    gestures.end({ x: 0, y: 0, t: 20 });
    gestures.start({ x: 300, y: 0, t: 100 }, 1);
    gestures.end({ x: 300, y: 0, t: 120 });

    expect(keys).toEqual([]);
  });

  it("does not treat a slow press as a tap", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    gestures.end({ x: 0, y: 0, t: TAP_MAX_MS + 1 });
    gestures.start({ x: 0, y: 0, t: TAP_MAX_MS + 50 }, 1);
    gestures.end({ x: 0, y: 0, t: TAP_MAX_MS + 100 });

    expect(keys).toEqual([]);
  });

  it("does not treat a swipe as a tap", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    gestures.move({ x: 0, y: 120, t: 30 });
    gestures.end({ x: 0, y: 120, t: 60 });
    gestures.start({ x: 0, y: 120, t: 100 }, 1);
    gestures.end({ x: 0, y: 120, t: 130 });

    expect(keys).toEqual([]);
  });

  it("does not let a released pad become half of a double-tap", () => {
    const gestures = harness();
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    fireLongPress();
    gestures.end({ x: 0, y: 0, t: LONG_PRESS_MS + 10 });
    // A quick tap right after the pad closes must not complete a double-tap.
    gestures.start({ x: 0, y: 0, t: LONG_PRESS_MS + 60 }, 1);
    gestures.end({ x: 0, y: 0, t: LONG_PRESS_MS + 90 });

    expect(keys).toEqual([]);
  });

  it("stays silent when the gesture is disabled", () => {
    const gestures = harness({ doubleTapTab: false });
    gestures.start({ x: 0, y: 0, t: 0 }, 1);
    gestures.end({ x: 0, y: 0, t: 20 });
    gestures.start({ x: 0, y: 0, t: 100 }, 1);
    expect(gestures.end({ x: 0, y: 0, t: 120 })).toBe(false);

    expect(keys).toEqual([]);
  });
});
