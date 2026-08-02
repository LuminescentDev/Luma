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
 * A mirror is a second xterm instance, so one is only kept alive while its card
 * is actually on screen: scrolling a card out of view tears its mirror down, and
 * scrolling back re-seeds a fresh one from the source's current buffer. That
 * keeps the cost proportional to what is visible rather than to how many
 * sessions are open.
 */

/** Rendered off the visible edge so a card just below the fold is already warm
 * by the time it scrolls in. */
const PRELOAD_MARGIN = "200px";

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
    const stopMirror = terminalManager.mirrorSession(previewId, sessionId);
    // Mirror first, then attach: attaching an id the manager does not know yet
    // parks the host for the session to claim later, which would bypass the
    // focus option below.
    terminalManager.attach(previewId, host, { focus: false, accelerated: false });
    return () => {
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
