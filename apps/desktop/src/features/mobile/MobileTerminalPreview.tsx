import { useEffect, useRef, useState } from "react";
import { terminalManager } from "../terminal/terminalManager";
import { cn } from "../../lib/utils";

/*
 * A live, read-only miniature of an open session, shown on the Connections card
 * for that session. terminalManager.mirrorSession does all the work: it creates
 * a display-only terminal seeded with the tail of the source's buffer and feeds
 * it the same output bytes the source receives. This component only owns the
 * host element and the lifetime — no terminal bytes pass through React.
 *
 * The mirror keeps the SOURCE's grid rather than refitting to the card, so the
 * preview renders exactly what the terminal renders: same wrap points, same
 * right-aligned prompt segments, same TUI layout. Fitting is done by shrinking
 * the font (fitPreview) until that grid fits the card — a scaled-down terminal
 * instead of a re-flowed one.
 *
 * A mirror is a second xterm instance, so one is only kept alive while its card
 * is actually on screen: scrolling a card out of view tears its mirror down, and
 * scrolling back re-seeds a fresh one from the source's current buffer. That
 * keeps the cost proportional to what is visible rather than to how many
 * sessions are open.
 */

/** Rendered off the visible edge so a card just below the fold is already warm
 * by the time it scrolls in. */
const PRELOAD_MARGIN = "200px";

/** Ceiling for the miniature's font. A preview is a glanceable thumbnail, not a
 * second place to read output, so it stays well under the terminal's own size
 * even when the grid would allow more. */
const MAX_PREVIEW_FONT_SIZE = 7;

/** fitPreview scales from the metrics currently on screen, and xterm rounds cell
 * dimensions, so the first pass lands close rather than exact. Re-running it
 * converges within a pass or two; this only bounds the loop so a pathological
 * case (a font whose metrics never settle) cannot spin every frame forever. */
const MAX_FIT_PASSES = 4;

export function MobileTerminalPreview({
  sessionId,
  status,
  className,
}: {
  sessionId: string;
  /** The session's status. Used only as an effect dependency: a session is
   * listed while it is still connecting (before the manager has a terminal to
   * mirror) and a reconnect resets the source's buffer, so both transitions must
   * re-seed the mirror rather than leave it blank or stale. */
  status: string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // No IntersectionObserver (older webview): keep the mirror always on rather
    // than never showing a preview at all.
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { rootMargin: PRELOAD_MARGIN },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !visible) return;
    const previewId = `preview:${sessionId}`;
    let frame: number | null = null;
    // Each pass measures what is actually rendered and applies one correction,
    // so passes are chained across frames — a font change only shows up in the
    // next frame's metrics — until fitPreview reports the size unchanged.
    const scheduleFit = (pass = 0) => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        const before = terminalManager.previewFontSize(previewId);
        const after = terminalManager.fitPreview(previewId, MAX_PREVIEW_FONT_SIZE);
        if (after !== null && after !== before && pass + 1 < MAX_FIT_PASSES) {
          scheduleFit(pass + 1);
        }
      });
    };

    const stopMirror = terminalManager.mirrorSession(previewId, sessionId, {
      // The source's grid changed shape (rotation, or the session being opened
      // full-screen) while this card's box did not, so nothing else would
      // prompt a refit.
      onGridChange: scheduleFit,
    });
    // Mirror first, then attach: attaching an id the manager does not know yet
    // parks the host for the session to claim later, which would bypass the
    // options below.
    terminalManager.attach(previewId, host, {
      focus: false,
      accelerated: false,
      // The mirror owns the source's grid; refitting it to this card is exactly
      // what would re-wrap the output and make the preview stop matching.
      fit: false,
    });
    // The card's width is known only after layout, and the bundled font can
    // still be loading (which changes cell metrics), so fit on every box change
    // rather than once at mount.
    // Wrapped rather than passed directly: ResizeObserver hands its callback an
    // entry list, which would arrive as scheduleFit's pass counter.
    const observer = new ResizeObserver(() => scheduleFit());
    observer.observe(host);
    scheduleFit();

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      terminalManager.detach(previewId);
      stopMirror();
    };
  }, [sessionId, visible, status]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      // The mirror is decorative: the card's own button carries the label and
      // the tap target, so the preview must not swallow touches meant for it.
      className={cn("pointer-events-none overflow-hidden", className)}
    />
  );
}
