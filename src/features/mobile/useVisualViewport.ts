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
 * Returns the current height in CSS pixels (falls back to window.innerHeight when
 * the API is unavailable, e.g. older WebViews / jsdom).
 */
export function useVisualViewportHeight(activeSessionId: string | null): number {
  const [height, setHeight] = useState<number>(() =>
    typeof window === "undefined"
      ? 0
      : (window.visualViewport?.height ?? window.innerHeight),
  );

  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => {
      setHeight(vv?.height ?? window.innerHeight);
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

  return height;
}
