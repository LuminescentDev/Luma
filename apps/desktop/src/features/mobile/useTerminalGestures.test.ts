import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bindTerminalGestures } from "./useTerminalGestures";
import {
  ARROW_SEQUENCES,
  ARROW_STEP_PX,
  LONG_PRESS_MS,
  MOVE_SLOP_PX,
  TAB_SEQUENCE,
  type PadState,
} from "./terminalGestures";

/*
 * Covers the DOM half of the gestures: that the listeners engage on a real
 * element, that an engaged gesture is kept away from xterm (capture phase +
 * stopPropagation), that an ordinary scroll is NOT interfered with, and that
 * teardown is complete. The recognition rules themselves are covered in
 * terminalGestures.test.ts.
 *
 * jsdom has no TouchEvent constructor, so events are synthesized with the few
 * fields the listeners actually read.
 */

type Point = { x: number; y: number };

function touchEvent(
  type: string,
  points: Point[],
  timeStamp: number,
  changed: Point[] = points,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const toTouch = (p: Point) => ({ clientX: p.x, clientY: p.y }) as Touch;
  Object.defineProperty(event, "touches", { value: points.map(toTouch) });
  Object.defineProperty(event, "changedTouches", { value: changed.map(toTouch) });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  return event;
}

let host: HTMLDivElement;
/** Stands in for xterm's own listeners, which live below the host. */
let child: HTMLDivElement;
let keys: string[];
let pads: (PadState | null)[];
let childSaw: string[];
let unbind: () => void;

function bind(options: { arrowPad?: boolean; doubleTapTab?: boolean } = {}) {
  unbind = bindTerminalGestures(host, {
    arrowPad: options.arrowPad ?? true,
    doubleTapTab: options.doubleTapTab ?? true,
    onKey: (data) => keys.push(data),
    onPad: (pad) => pads.push(pad),
  });
}

/** Dispatch on the child, the way a real touch on the terminal would. */
function dispatch(
  type: string,
  points: Point[],
  timeStamp: number,
  changed?: Point[],
): Event {
  const event = touchEvent(type, points, timeStamp, changed);
  child.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  keys = [];
  pads = [];
  childSaw = [];
  host = document.createElement("div");
  child = document.createElement("div");
  host.appendChild(child);
  document.body.appendChild(host);
  for (const type of ["touchstart", "touchmove", "touchend"]) {
    child.addEventListener(type, () => childSaw.push(type));
  }
});

afterEach(() => {
  unbind?.();
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bindTerminalGestures", () => {
  it("opens the pad after the long press and sends arrows on drag", () => {
    bind();
    dispatch("touchstart", [{ x: 100, y: 100 }], 0);
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(pads).toEqual([{ x: 100, y: 100, direction: null }]);

    dispatch("touchmove", [{ x: 100, y: 100 - ARROW_STEP_PX }], 400);
    expect(keys).toEqual([ARROW_SEQUENCES.up]);
  });

  it("keeps an engaged drag away from xterm and from the viewport scroll", () => {
    bind();
    dispatch("touchstart", [{ x: 0, y: 0 }], 0);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    childSaw = [];

    const event = dispatch("touchmove", [{ x: 0, y: ARROW_STEP_PX }], 400);

    expect(event.defaultPrevented).toBe(true);
    expect(childSaw).toEqual([]);
  });

  it("leaves an ordinary scroll entirely alone", () => {
    bind();
    dispatch("touchstart", [{ x: 0, y: 0 }], 0);
    const event = dispatch("touchmove", [{ x: 0, y: MOVE_SLOP_PX + 40 }], 30);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);

    expect(event.defaultPrevented).toBe(false);
    expect(childSaw).toContain("touchmove");
    expect(pads).toEqual([]);
    expect(keys).toEqual([]);
  });

  it("sends Tab on a double-tap and suppresses the synthesized click", () => {
    bind();
    dispatch("touchstart", [{ x: 20, y: 20 }], 0);
    const first = dispatch("touchend", [], 50, [{ x: 20, y: 20 }]);
    dispatch("touchstart", [{ x: 20, y: 20 }], 150);
    const second = dispatch("touchend", [], 190, [{ x: 20, y: 20 }]);

    expect(keys).toEqual([TAB_SEQUENCE]);
    // Only the second tap is swallowed: the first must still reach xterm so the
    // usual tap-to-focus (and the soft keyboard) still happens.
    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(true);
  });

  it("closes the pad when the OS cancels the touch", () => {
    bind();
    dispatch("touchstart", [{ x: 0, y: 0 }], 0);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    child.dispatchEvent(new Event("touchcancel", { bubbles: true }));

    expect(pads[pads.length - 1]).toBeNull();
    dispatch("touchmove", [{ x: 0, y: ARROW_STEP_PX * 3 }], 500);
    expect(keys).toEqual([]);
  });

  it("stays silent when both gestures are off", () => {
    bind({ arrowPad: false, doubleTapTab: false });
    dispatch("touchstart", [{ x: 0, y: 0 }], 0);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    dispatch("touchmove", [{ x: 0, y: ARROW_STEP_PX * 3 }], 400);
    dispatch("touchend", [], 450, [{ x: 0, y: ARROW_STEP_PX * 3 }]);

    expect(keys).toEqual([]);
    expect(pads).toEqual([]);
  });

  it("stops responding after teardown, with no timer left armed", () => {
    bind();
    dispatch("touchstart", [{ x: 0, y: 0 }], 0);
    unbind();
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);

    dispatch("touchstart", [{ x: 0, y: 0 }], 500);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    dispatch("touchmove", [{ x: 0, y: ARROW_STEP_PX * 2 }], 900);

    expect(keys).toEqual([]);
    expect(pads).toEqual([]);
  });
});
