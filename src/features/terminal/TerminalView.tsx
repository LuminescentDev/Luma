import { useEffect, useRef } from "react";
import { RotateCcw, X } from "lucide-react";
import { terminalManager } from "./terminalManager";
import { useSessionStore } from "../../stores/sessionStore";
import type { TerminalSession } from "../../types";

export function TerminalView({ session }: { session: TerminalSession }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const restartSession = useSessionStore((s) => s.restartSession);
  const closeSession = useSessionStore((s) => s.closeSession);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    terminalManager.attach(session.id, host);
    const observer = new ResizeObserver(() => terminalManager.fitSession(session.id));
    observer.observe(host);
    return () => {
      observer.disconnect();
      terminalManager.detach(session.id);
    };
  }, [session.id]);

  const showBanner = session.status === "disconnected" || session.status === "error";

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full pl-2 pt-1.5" />
      {showBanner && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-border bg-surface/95 px-4 py-2.5 text-sm backdrop-blur">
          <span className="text-muted">
            {session.status === "error"
              ? (session.errorMessage ?? "Failed to start shell.")
              : `Shell exited${session.exitCode !== null && session.exitCode !== undefined ? ` (code ${session.exitCode})` : ""}.`}
          </span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void restartSession(session.id)}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-foreground hover:border-accent hover:text-accent"
            >
              <RotateCcw size={13} /> Restart
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
