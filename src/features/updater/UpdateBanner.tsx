import { AlertTriangle, ArrowUpCircle, RotateCw, X } from "lucide-react";
import { useUpdaterStore } from "../../stores/updaterStore";
import { formatBytes } from "../../lib/updater";
import { cn } from "../../lib/utils";

/**
 * Non-intrusive launch notification shown when the automatic check finds an
 * update. Dismissible, keyboard-operable, and announces progress politely.
 * The manual Settings flow does not raise this banner.
 */
export function UpdateBanner() {
  const visible = useUpdaterStore((s) => s.notificationVisible);
  const info = useUpdaterStore((s) => s.info);
  const status = useUpdaterStore((s) => s.status);
  const errorMessage = useUpdaterStore((s) => s.errorMessage);
  const downloadedBytes = useUpdaterStore((s) => s.downloadedBytes);
  const totalBytes = useUpdaterStore((s) => s.totalBytes);
  const install = useUpdaterStore((s) => s.install);
  const restart = useUpdaterStore((s) => s.restart);
  const dismiss = useUpdaterStore((s) => s.dismissNotification);

  if (!visible || !info) return null;

  const downloading = status === "downloading";
  const installed = status === "installed";
  const restartFailed = status === "restart-failed";
  const errored = status === "error";
  const pct =
    totalBytes && totalBytes > 0
      ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
      : null;

  return (
    <div
      role="region"
      aria-label="Software update available"
      className="fixed bottom-4 right-4 z-50 w-[calc(100vw-2rem)] max-w-sm rounded-xl border border-border bg-surface p-4 shadow-glow"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-accent">
          {errored ? (
            <AlertTriangle size={18} className="text-danger" />
          ) : (
            <ArrowUpCircle size={18} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {installed || restartFailed
              ? "Update installed"
              : errored
                ? "Update failed"
                : `Update available — ${info.version}`}
          </p>

          <div aria-live="polite">
            {installed ? (
              <p className="mt-0.5 text-xs text-muted">
                Update installed — restarting Luma…
              </p>
            ) : restartFailed ? (
              <p className="mt-0.5 text-xs text-muted">
                Update installed — please restart Luma to finish updating.
              </p>
            ) : errored ? (
              <p className="mt-0.5 text-xs text-danger">
                {errorMessage ?? "Something went wrong."}
              </p>
            ) : downloading ? (
              <p className="mt-1 text-xs text-muted">
                Downloading…{" "}
                {formatBytes(downloadedBytes)}
                {totalBytes ? ` of ${formatBytes(totalBytes)}` : ""}
                {pct != null ? ` (${pct}%)` : ""}
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-muted">
                You&apos;re on {info.currentVersion}. Install {info.version} now?
              </p>
            )}
          </div>

          {downloading && (
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-raised"
              role="progressbar"
              aria-label="Update download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? undefined}
            >
              <div
                className={cn(
                  "h-full rounded-full bg-accent transition-[width]",
                  pct == null && "animate-pulse",
                )}
                style={{ width: pct != null ? `${pct}%` : "40%" }}
              />
            </div>
          )}

          {!downloading && (
            <div className="mt-2.5 flex items-center gap-2">
              {installed || restartFailed ? (
                <button
                  type="button"
                  aria-label="Restart Luma now to finish updating"
                  onClick={() => void restart()}
                  className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground"
                >
                  <RotateCw size={13} />
                  Restart now
                </button>
              ) : errored ? (
                <button
                  type="button"
                  onClick={dismiss}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground"
                >
                  Dismiss
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void install()}
                    className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground"
                  >
                    <RotateCw size={13} />
                    Install now
                  </button>
                  <button
                    type="button"
                    onClick={dismiss}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground"
                  >
                    Later
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          aria-label="Dismiss update notification"
          onClick={dismiss}
          className="shrink-0 rounded p-1 text-muted hover:bg-raised hover:text-foreground"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
