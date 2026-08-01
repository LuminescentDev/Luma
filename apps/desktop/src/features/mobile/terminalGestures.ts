/*
 * Touch gestures for the mobile terminal, kept as a pure state machine so the
 * recognition rules are testable without a DOM. useTerminalGestures feeds it
 * coordinates and timestamps and forwards whatever it emits to
 * terminalManager.sendAccessoryKey — the same synthetic-key path the accessory
 * bar uses, so terminal bytes still never pass through React.
 *
 * Two gestures, each independently toggleable in settings:
 *   - Long-press, then drag: opens a floating d-pad and emits one arrow key per
 *     ARROW_STEP_PX of travel, so a drag scrubs through shell history (vertical)
 *     or along the input line (horizontal).
 *   - Double-tap: sends Tab, for shell completion.
 *
 * A drag that starts before the long-press timer fires is a scroll or a
 * selection: the machine steps aside and lets xterm handle it untouched. That
 * "rejected" state is what keeps the terminal's normal touch behaviour intact.
 */

export type Direction = "up" | "down" | "left" | "right";

/** The escape sequences a hardware arrow key would produce (xterm normal mode). */
export const ARROW_SEQUENCES: Record<Direction, string> = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
};

export const TAB_SEQUENCE = "\t";

/** How long a finger must rest before the arrow pad takes over. Deliberately
 * under iOS's own ~500ms long-press so ours wins the gesture. */
export const LONG_PRESS_MS = 350;
/** Movement past this (from the press point) before the timer fires means the
 * user is scrolling, not summoning the pad. */
export const MOVE_SLOP_PX = 10;
/** Drag distance per emitted arrow key. Roughly one comfortable thumb notch. */
export const ARROW_STEP_PX = 26;
/** Drag distance before the pad highlights a direction. Only cosmetic. */
export const DIRECTION_DEADZONE_PX = 8;
/** Maximum gap between the two taps of a double-tap. */
export const DOUBLE_TAP_MS = 300;
/** How far apart the two taps may land and still count as a double-tap. */
export const DOUBLE_TAP_SLOP_PX = 32;
/** A press longer than this is not a tap, so it cannot start or finish a
 * double-tap (it is a long press, or a hesitation). */
export const TAP_MAX_MS = 250;
/** Guard against a pathological single move event emitting unbounded keys. */
const MAX_STEPS_PER_MOVE = 32;

/** Where the pad is anchored (viewport coordinates) and which way the finger is
 * currently pulling, for the overlay to highlight. */
export type PadState = {
  x: number;
  y: number;
  direction: Direction | null;
};

export type TouchPoint = {
  x: number;
  y: number;
  /** Event timestamp in ms. Any monotonic clock works; only deltas are used. */
  t: number;
};

export type GestureOptions = {
  /** Long-press + drag emits arrow keys. */
  arrowPad: boolean;
  /** Double-tap emits Tab. */
  doubleTapTab: boolean;
  /** Deliver a key sequence to the session. */
  onKey: (data: string) => void;
  /** Pad opened, changed direction, or closed (null). */
  onPad: (pad: PadState | null) => void;
  /** Arm the long-press timer; returns its canceller. Injected so tests drive
   * the timer directly instead of waiting on wall-clock. */
  schedule: (fn: () => void, ms: number) => () => void;
};

export type GestureRecognizer = {
  /** A finger went down. `touchCount` is the number of active touches — more
   * than one is a pinch or two-finger scroll, which cancels everything. */
  start: (point: TouchPoint, touchCount: number) => void;
  /** @returns true when the pad consumed the move, so the caller should
   * preventDefault/stopPropagation and keep it away from xterm. */
  move: (point: TouchPoint) => boolean;
  /** @returns true when the gesture consumed the release (pad drag finished, or
   * a double-tap fired), so the caller should suppress the synthesized click. */
  end: (point: TouchPoint) => boolean;
  /** The OS took the gesture away (call interruption, system edge swipe). */
  cancel: () => void;
  /** Whether the arrow pad is currently open. */
  isPadActive: () => boolean;
};

type Phase =
  /** No finger down, or the previous gesture is fully resolved. */
  | "idle"
  /** Finger down, still deciding: could become a tap, or the pad. */
  | "pressing"
  /** Long press engaged; drags emit arrow keys. */
  | "pad"
  /** Handed back to xterm for this touch (scroll, selection, multi-touch). */
  | "rejected";

/** Dominant-axis direction of a delta, or null inside the deadzone. */
function directionOf(dx: number, dy: number, deadzone: number): Direction | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < deadzone) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

function distance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function createTerminalGestures(options: GestureOptions): GestureRecognizer {
  let phase: Phase = "idle";
  /** Where this touch started — the pad's anchor and the tap's reference point. */
  let origin: TouchPoint | null = null;
  /** Ratcheting reference for arrow emission: advances one ARROW_STEP_PX at a
   * time on the dominant axis, so a continuous drag keeps emitting. */
  let anchorX = 0;
  let anchorY = 0;
  let direction: Direction | null = null;
  let cancelTimer: (() => void) | null = null;
  /** The previous completed tap, still eligible to become a double-tap. */
  let lastTap: TouchPoint | null = null;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const closePad = () => {
    if (phase === "pad") options.onPad(null);
    direction = null;
  };

  const engagePad = () => {
    cancelTimer = null;
    if (phase !== "pressing" || !origin) return;
    phase = "pad";
    anchorX = origin.x;
    anchorY = origin.y;
    direction = null;
    // A long press is not the first half of a double-tap; drop any pending tap
    // so releasing the pad cannot combine with an earlier one.
    lastTap = null;
    options.onPad({ x: origin.x, y: origin.y, direction: null });
  };

  /** Emit one arrow per whole step the finger has travelled past the anchor,
   * advancing the anchor as it goes so a long drag keeps producing keys. */
  const emitSteps = (point: TouchPoint) => {
    for (let steps = 0; steps < MAX_STEPS_PER_MOVE; steps += 1) {
      const dx = point.x - anchorX;
      const dy = point.y - anchorY;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      const primary = horizontal ? dx : dy;
      if (Math.abs(primary) < ARROW_STEP_PX) return;
      const stepDirection: Direction = horizontal
        ? dx > 0
          ? "right"
          : "left"
        : dy > 0
          ? "down"
          : "up";
      options.onKey(ARROW_SEQUENCES[stepDirection]);
      if (horizontal) anchorX += Math.sign(dx) * ARROW_STEP_PX;
      else anchorY += Math.sign(dy) * ARROW_STEP_PX;
    }
  };

  return {
    start(point, touchCount) {
      clearTimer();
      if (touchCount > 1) {
        // A second finger means pinch or two-finger scroll: close anything open
        // and stay out of the way until every finger lifts.
        closePad();
        phase = "rejected";
        origin = null;
        lastTap = null;
        return;
      }
      closePad();
      origin = point;
      phase = "pressing";
      if (options.arrowPad) cancelTimer = options.schedule(engagePad, LONG_PRESS_MS);
    },

    move(point) {
      if (phase === "pressing") {
        if (origin && distance(point, origin) > MOVE_SLOP_PX) {
          // Moved before the pad engaged: this is a scroll or a selection drag.
          clearTimer();
          phase = "rejected";
        }
        return false;
      }
      if (phase !== "pad" || !origin) return false;
      emitSteps(point);
      const next = directionOf(
        point.x - origin.x,
        point.y - origin.y,
        DIRECTION_DEADZONE_PX,
      );
      if (next !== direction) {
        direction = next;
        options.onPad({ x: origin.x, y: origin.y, direction });
      }
      return true;
    },

    end(point) {
      clearTimer();
      const previousPhase = phase;
      const start = origin;
      phase = "idle";
      origin = null;

      if (previousPhase === "pad") {
        options.onPad(null);
        direction = null;
        return true;
      }
      if (previousPhase !== "pressing" || !start) {
        // A rejected touch (scroll, multi-touch) breaks any double-tap sequence.
        lastTap = null;
        return false;
      }
      if (!options.doubleTapTab) return false;

      const isTap =
        point.t - start.t <= TAP_MAX_MS && distance(point, start) <= MOVE_SLOP_PX;
      if (!isTap) {
        lastTap = null;
        return false;
      }

      const previousTap = lastTap;
      lastTap = point;
      if (
        previousTap &&
        point.t - previousTap.t <= DOUBLE_TAP_MS &&
        distance(point, previousTap) <= DOUBLE_TAP_SLOP_PX
      ) {
        // Consume both taps so a third tap starts a fresh sequence rather than
        // firing Tab again on every subsequent tap.
        lastTap = null;
        options.onKey(TAB_SEQUENCE);
        return true;
      }
      return false;
    },

    cancel() {
      clearTimer();
      closePad();
      phase = "idle";
      origin = null;
      lastTap = null;
    },

    isPadActive() {
      return phase === "pad";
    },
  };
}
