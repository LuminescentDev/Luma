import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  Loader2,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { useUpdaterStore } from "../../stores/updaterStore";
import { formatBytes, getVersion } from "../../lib/updater";
import { formatRelativeTime } from "../../lib/sync";
import { useSettings, useSetSetting } from "../../hooks/useSettings";
import { SETTING_KEYS } from "../../types";
import { cn } from "../../lib/utils";

/**
 * Settings "Updates" section: current version, a manual check with inline
 * states (checking / up-to-date / available / error), install progress, a
 * relative last-checked status, and the launch auto-check toggle.
 */
export function UpdatesSection() {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getVersion()
      .then((v) => {
        if (active) setAppVersion(v);
      })
      .catch(() => {
        // Non-Tauri context / unavailable runtime: fall back to no version.
      });
    return () => {
      active = false;
    };
  }, []);

  const { data: settings } = useSettings();
  const setSetting = useSetSetting();
  const checkOnLaunch = settings?.[SETTING_KEYS.checkOnLaunch] !== false; // default on

  const status = useUpdaterStore((s) => s.status);
  const info = useUpdaterStore((s) => s.info);
  const errorMessage = useUpdaterStore((s) => s.errorMessage);
  const lastCheckedAt = useUpdaterStore((s) => s.lastCheckedAt);
  const downloadedBytes = useUpdaterStore((s) => s.downloadedBytes);
  const totalBytes = useUpdaterStore((s) => s.totalBytes);
  const check = useUpdaterStore((s) => s.check);
  const install = useUpdaterStore((s) => s.install);
  const restart = useUpdaterStore((s) => s.restart);

  const checking = status === "checking";
  const downloading = status === "downloading";
  const pct =
    totalBytes && totalBytes > 0
      ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
      : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            Luma {appVersion ?? info?.currentVersion ?? "—"}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {lastCheckedAt
              ? `Last checked ${formatRelativeTime(lastCheckedAt)}`
              : "Not checked yet this session"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void check({ silent: false })}
          disabled={checking || downloading}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground disabled:opacity-60"
        >
          <RefreshCw size={14} className={checking ? "animate-spin" : undefined} />
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>

      {/* Result / progress states (announced politely). */}
      <div aria-live="polite" className="space-y-2">
        {status === "up-to-date" && (
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted">
            <Check size={13} className="text-accent" /> You&apos;re on the latest
            version.
          </div>
        )}

        {status === "error" && (
          <div
            role="alert"
            className="flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {errorMessage ?? "Couldn't check for updates."}
          </div>
        )}

        {(status === "available" ||
          downloading ||
          status === "installed" ||
          status === "restart-failed") &&
          info && (
            <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
              <div className="flex items-start gap-2">
                <ArrowUpCircle size={16} className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    Version {info.version} is available
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    You&apos;re currently on {info.currentVersion}.
                  </p>

                  {info.notes && (
                    <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background px-2.5 py-2 font-sans text-xs text-muted">
                      {info.notes}
                    </pre>
                  )}

                  {status === "installed" ? (
                    <div className="mt-2.5 space-y-2">
                      <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs text-foreground">
                        <Check size={13} className="text-accent" /> Update
                        installed — restarting Luma…
                      </div>
                      <button
                        type="button"
                        aria-label="Restart Luma now to finish updating"
                        onClick={() => void restart()}
                        className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
                      >
                        <RotateCw size={14} /> Restart now
                      </button>
                    </div>
                  ) : status === "restart-failed" ? (
                    <div className="mt-2.5 space-y-2">
                      <div className="flex items-start gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs text-foreground">
                        <Check size={13} className="mt-0.5 shrink-0 text-accent" />
                        {errorMessage ??
                          "Update installed — please restart Luma to finish updating."}
                      </div>
                      <button
                        type="button"
                        aria-label="Restart Luma now to finish updating"
                        onClick={() => void restart()}
                        className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
                      >
                        <RotateCw size={14} /> Restart now
                      </button>
                    </div>
                  ) : downloading ? (
                    <div className="mt-2.5">
                      <p className="text-xs text-muted">
                        Downloading… {formatBytes(downloadedBytes)}
                        {totalBytes ? ` of ${formatBytes(totalBytes)}` : ""}
                        {pct != null ? ` (${pct}%)` : ""}
                      </p>
                      <div
                        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-raised"
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
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void install()}
                      className="mt-2.5 flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
                    >
                      <RotateCw size={14} /> Install update
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

        {checking && (
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted">
            <Loader2 size={13} className="animate-spin" /> Checking for updates…
          </div>
        )}
      </div>

      {/* Auto-check toggle -------------------------------------------------- */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            Automatically check for updates on launch
          </p>
          <p className="text-xs text-muted">
            Runs one silent check shortly after startup. Only contacts the update
            server — no telemetry is sent.
          </p>
        </div>
        <Toggle
          checked={checkOnLaunch}
          disabled={setSetting.isPending}
          onClick={() =>
            setSetting.mutate({
              key: SETTING_KEYS.checkOnLaunch,
              value: !checkOnLaunch,
            })
          }
          label="Automatically check for updates on launch"
        />
      </div>
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onClick,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        checked ? "bg-accent" : "bg-surface",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-foreground shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
