import { useEffect, useRef, useState } from "react";
import { terminalManager } from "../terminal/terminalManager";
import { createTerminalGestures, type PadState } from "./terminalGestures";

/*
 * Binds the terminal touch gestures (see terminalGestures.ts) to a pane's xterm
 * host element and routes what they produce into terminalManager's synthetic-key
 * path — the same one the accessory bar uses, so any armed sticky Ctrl/Alt still
 * applies and terminal bytes never pass through React.
 *
 * Listeners are registered in the CAPTURE phase on the host, which is xterm's
 * parent: that way an engaged gesture can stopPropagation() before xterm's own
 * viewport handlers see the event. Nothing is swallowed until a gesture actually
 * engages, so ordinary touch scrolling and selection behave exactly as before.
 *
 * The DOM wiring lives in bindTerminalGestures rather than inside the effect so
 * it can be tested against a real element without a React renderer.
 */

export type BindOptions = {
  arrowPad: boolean;
  doubleTapTab: boolean;
  /** A key sequence the gestures produced. */
  onKey: (data: string) => void;
  /** Pad opened, changed direction, or closed (null). */
  onPad: (pad: PadState | null) => void;
};

/** Short confirmation buzz when the pad takes over, so the user knows the long
 * press registered without looking. Android honours this; iOS WKWebView has no
 * vibration API, where the pad appearing is the only feedback. */
function pulse(): void {
  navigator.vibrate?.(8);
}

/**
 * Attach the gesture listeners to `host`.
 * @returns a teardown that removes them and closes any open pad.
 */
export function bindTerminalGestures(
  host: HTMLElement,
  options: BindOptions,
): () => void {
  const gestures = createTerminalGestures({
    arrowPad: options.arrowPad,
    doubleTapTab: options.doubleTapTab,
    onKey: options.onKey,
    onPad: options.onPad,
    schedule: (fn, ms) => {
      const id = window.setTimeout(fn, ms);
      return () => window.clearTimeout(id);
    },
  });

  const pointFrom = (touch: Touch, event: TouchEvent) => ({
    x: touch.clientX,
    y: touch.clientY,
    t: event.timeStamp,
  });

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (touch) gestures.start(pointFrom(touch, event), event.touches.length);
  };

  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    if (gestures.move(pointFrom(touch, event))) {
      // Non-passive, so this genuinely stops the viewport from scrolling under
      // the pad; stopPropagation keeps the drag away from xterm's selection.
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onTouchEnd = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    if (gestures.end(pointFrom(touch, event))) {
      // Suppresses the click/dblclick this touch would synthesize — which is
      // what would otherwise trigger xterm's word-select on a double-tap.
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onTouchCancel = () => gestures.cancel();

  const active = { capture: true, passive: false } as const;
  const listening = { capture: true, passive: true } as const;
  host.addEventListener("touchstart", onTouchStart, listening);
  host.addEventListener("touchmove", onTouchMove, active);
  host.addEventListener("touchend", onTouchEnd, active);
  host.addEventListener("touchcancel", onTouchCancel, listening);

  return () => {
    host.removeEventListener("touchstart", onTouchStart, { capture: true });
    host.removeEventListener("touchmove", onTouchMove, { capture: true });
    host.removeEventListener("touchend", onTouchEnd, { capture: true });
    host.removeEventListener("touchcancel", onTouchCancel, { capture: true });
    // Fires the pad-closed callback if a gesture was mid-flight.
    gestures.cancel();
  };
}

/**
 * React binding: keeps the listeners attached to the pane's host element and
 * returns the pad state for the overlay. That state is gesture metadata, not
 * terminal output — it re-renders only when the pad opens, changes direction,
 * or closes.
 */
export function useTerminalGestures({
  sessionId,
  hostRef,
  arrowPad,
  doubleTapTab,
}: {
  sessionId: string;
  /** The element terminalManager attached the terminal into. */
  hostRef: React.RefObject<HTMLDivElement | null>;
  arrowPad: boolean;
  doubleTapTab: boolean;
}): PadState | null {
  const [pad, setPad] = useState<PadState | null>(null);
  // Tracked separately so the haptic only fires on open, not on every direction
  // change, without re-binding the listeners.
  const padOpen = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || (!arrowPad && !doubleTapTab)) return;

    const unbind = bindTerminalGestures(host, {
      arrowPad,
      doubleTapTab,
      onKey: (data) => terminalManager.sendAccessoryKey(sessionId, data),
      onPad: (next) => {
        if (next && !padOpen.current) pulse();
        padOpen.current = next !== null;
        setPad(next);
      },
    });

    return () => {
      unbind();
      padOpen.current = false;
      setPad(null);
    };
  }, [sessionId, hostRef, arrowPad, doubleTapTab]);

  return pad;
}
