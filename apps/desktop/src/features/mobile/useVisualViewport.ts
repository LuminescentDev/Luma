import { useEffect, useState } from "react";
import { terminalManager } from "../terminal/terminalManager";

/**
 * Track the visual viewport height and refit a terminal as it changes. On mobile
 * the on-screen keyboard shrinks the visual viewport without changing the layout
 * viewport, so sizing the terminal container to `visualViewport.height` keeps the
 * prompt visible above the keyboard. Rotation fires the same resize path, so the
 * grid refits (which triggers the backend ssh_resize through xterm's onResize)
 * without corrupting sizing.
 *
 * Returns the visible height and its offset within the layout viewport. iOS can
 * pan the visual viewport when a regular form field receives focus; applying
 * both values keeps the mobile shell aligned instead of leaving its top clipped.
 */
export function useVisualViewportMetrics(activeSessionId: string | null): {
  height: number;
  offsetTop: number;
} {
  const [metrics, setMetrics] = useState(() => ({
    height:
      typeof window === "undefined"
        ? 0
        : (window.visualViewport?.height ?? window.innerHeight),
    offsetTop:
      typeof window === "undefined"
        ? 0
        : (window.visualViewport?.offsetTop ?? 0),
  }));

  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => {
      setMetrics({
        height: vv?.height ?? window.innerHeight,
        offsetTop: vv?.offsetTop ?? 0,
      });
      // Refit on the next frame so the container has taken its new height first,
      // then let xterm's onResize propagate the size to the backend.
      if (activeSessionId) {
        requestAnimationFrame(() => terminalManager.fitSession(activeSessionId));
      }
    };
    update();
    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
    }
    window.addEventListener("orientationchange", update);
    window.addEventListener("resize", update);
    return () => {
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      }
      window.removeEventListener("orientationchange", update);
      window.removeEventListener("resize", update);
    };
  }, [activeSessionId]);

  return metrics;
}
