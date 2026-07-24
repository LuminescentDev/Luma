import { RotateCcw, ServerOff, X } from "lucide-react";

/*
 * Prominent centered card shown when the SSH host-key PREFLIGHT fails before the
 * terminal is ever spawned (unreachable host, DNS failure, timeout, key-scan or
 * known_hosts-file problems, missing OpenSSH, invalid input). Unlike a runtime
 * disconnect — which is a quiet bottom banner — a connection-setup failure means
 * nothing ever started, so it earns the middle of the pane.
 *
 * This is NOT the security-critical host-key-changed state (that keeps its
 * danger-red alert). A reachability/scan failure gets a neutral accent
 * treatment: recoverable, not alarming. Retry re-runs the full preflight.
 */
export function ConnectionErrorAlert({
  hostTitle,
  message,
  onRetry,
  onClose,
}: {
  hostTitle: string;
  message: string;
  /** Re-run connect (which re-runs the host-key preflight). */
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="connection-error-title"
      aria-describedby="connection-error-message"
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/95 p-6 backdrop-blur"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-glow">
        <div className="flex items-center gap-2 text-accent">
          <ServerOff size={20} className="shrink-0" />
          <h2 id="connection-error-title" className="text-sm font-semibold text-foreground">
            Couldn&apos;t verify the server
          </h2>
        </div>
        <p className="mt-1 break-all font-mono text-xs text-muted">{hostTitle}</p>
        <p id="connection-error-message" className="mt-3 text-sm text-muted">
          {message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:border-danger hover:text-danger"
          >
            <X size={14} /> Close
          </button>
          <button
            type="button"
            autoFocus
            onClick={onRetry}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90"
          >
            <RotateCcw size={14} /> Retry
          </button>
        </div>
      </div>
    </div>
  );
}
