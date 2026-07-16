import { useEffect, useRef } from "react";
import { RotateCcw, X } from "lucide-react";
import { terminalManager } from "./terminalManager";
import { useSessionStore } from "../../stores/sessionStore";
import type { TerminalSession } from "../../types";
import { cn } from "../../lib/utils";
import { describeSshError } from "../hosts/sshErrors";
import { HostKeyChangedAlert } from "../hosts/HostKeyChangedAlert";

/*
 * A single split-pane leaf. Owns the host element for one managed terminal and
 * attaches/detaches it via terminalManager (terminal bytes never touch React).
 * Clicking the pane focuses it; the focused pane draws an accent ring.
 */
export function PaneView({
  session,
  focused,
  showFocusRing,
  onFocus,
}: {
  session: TerminalSession;
  focused: boolean;
  /** Only draw the focus ring when the tab actually has more than one pane. */
  showFocusRing: boolean;
  onFocus: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const restartSession = useSessionStore((s) => s.restartSession);
  const closeSession = useSessionStore((s) => s.closeSession);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    terminalManager.attach(session.id, host);
    const observer = new ResizeObserver(() =>
      terminalManager.fitSession(session.id),
    );
    observer.observe(host);
    return () => {
      observer.disconnect();
      terminalManager.detach(session.id);
    };
  }, [session.id]);

  const isSsh = session.type === "ssh";
  const showBanner =
    session.status === "disconnected" || session.status === "error";

  // host-key-changed is a security-critical, blocking state.
  const hostKeyChanged =
    isSsh &&
    session.status === "error" &&
    session.errorCategory === "host-key-changed";

  const bannerMessage = () => {
    if (session.status === "error") {
      if (isSsh) return describeSshError(session.errorCategory, session.errorMessage);
      return session.errorMessage ?? "Failed to start shell.";
    }
    const code =
      session.exitCode !== null && session.exitCode !== undefined
        ? ` (code ${session.exitCode})`
        : "";
    return isSsh ? `Connection closed${code}.` : `Shell exited${code}.`;
  };

  return (
    <div
      className={cn(
        "relative h-full w-full min-h-0 min-w-0 overflow-hidden",
        showFocusRing &&
          (focused
            ? "rounded-md ring-1 ring-accent/70"
            : "rounded-md ring-1 ring-transparent"),
      )}
      onMouseDownCapture={() => {
        if (!focused) onFocus();
      }}
    >
      <div ref={hostRef} className="h-full w-full pl-2 pt-1.5" />

      {hostKeyChanged && (
        <HostKeyChangedAlert
          hostTitle={session.title}
          message={describeSshError(session.errorCategory, session.errorMessage)}
          onClose={() => closeSession(session.id)}
        />
      )}

      {showBanner && !hostKeyChanged && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-border bg-surface/95 px-4 py-2.5 text-sm backdrop-blur">
          <span className="min-w-0 flex-1 text-muted">{bannerMessage()}</span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void restartSession(session.id)}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-foreground hover:border-accent hover:text-accent"
            >
              <RotateCcw size={13} /> {isSsh ? "Reconnect" : "Restart"}
            </button>
            <button
              type="button"
              onClick={() => closeSession(session.id)}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-muted hover:border-danger hover:text-danger"
            >
              <X size={13} /> Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
