import { useEffect, useRef } from "react";
import { Eye, LogOut, RadioTower, Users } from "lucide-react";
import { useCollabStore } from "../../stores/collabStore";
import { terminalManager } from "../terminal/terminalManager";
import {
  attachViewer,
  detachViewer,
  leaveRoom,
  releaseControl,
  requestControl,
  viewerDisplaySessionId,
} from "./collabClient";
import { ConnectionStatusBadge } from "./collabUi";

/*
 * Full-area overlay for a shared-terminal VIEWER/CONTROLLER. It hosts the
 * display-only xterm owned by terminalManager (fed decrypted bytes by
 * collabClient — never React state) and exposes the control lease + leave.
 * Rendered only while the local member is viewing a room.
 */
export function CollaborationViewer() {
  const mode = useCollabStore((s) => s.runtime.mode);
  if (mode !== "viewing") return null;
  return <ViewerSurface />;
}

function ViewerSurface() {
  const status = useCollabStore((s) => s.runtime.status);
  const role = useCollabStore((s) => s.runtime.role);
  const holdsControl = useCollabStore((s) => s.runtime.holdsControl);
  const sessionId = viewerDisplaySessionId();
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !sessionId) return;
    attachViewer(host);
    let fitFrame: number | null = null;
    const scheduleFit = () => {
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        terminalManager.fitSession(sessionId);
      });
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    scheduleFit();
    return () => {
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      observer.disconnect();
      detachViewer();
    };
  }, [sessionId]);

  const isController = role === "controller";

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Users size={15} className="text-accent" /> Shared terminal
        </span>
        <ConnectionStatusBadge status={status} className="ml-1" />
        <div className="ml-auto flex items-center gap-2">
          {isController ? (
            holdsControl ? (
              <button
                type="button"
                onClick={() => releaseControl()}
                className="flex items-center gap-1.5 rounded-md bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/25"
              >
                <RadioTower size={13} /> Release control
              </button>
            ) : (
              <button
                type="button"
                onClick={() => requestControl()}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground"
              >
                <RadioTower size={13} /> Request control
              </button>
            )
          ) : (
            <span className="flex items-center gap-1.5 rounded-md bg-raised px-2.5 py-1 text-xs text-muted">
              <Eye size={13} /> Read-only
            </span>
          )}
          <button
            type="button"
            onClick={() => void leaveRoom()}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-danger"
          >
            <LogOut size={13} /> Leave
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {isController && holdsControl && (
          <div className="pointer-events-none absolute right-3 top-2 z-10 flex items-center gap-1 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
            <RadioTower size={11} /> You have control
          </div>
        )}
        <div ref={hostRef} className="h-full w-full pl-2 pt-1.5" />
      </div>
    </div>
  );
}
