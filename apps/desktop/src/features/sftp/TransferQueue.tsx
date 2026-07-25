import { useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  Folder,
  Link2,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useSftpStore,
  type TransferRecord,
} from "../../stores/sftpStore";
import { formatBytes, formatRate, type TransferState } from "../../lib/sftp";
import { cn } from "../../lib/utils";

/*
 * The transfer queue drawer at the bottom of the SFTP screen. Rows are fed by
 * Channel progress events routed through the sftp store — there is no polling.
 * Finished rows persist (with retry) until cleared and survive navigating away,
 * since the queue lives in the store.
 *
 * File rows show a single progress bar. Directory rows show aggregate progress
 * (files done/total, bytes, current file) and an expandable list of the skipped
 * symlinks and failed entries reported on the job's "entry" events.
 */

const STATE_CHIP: Record<TransferState, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-accent/15 text-accent" },
  completed: { label: "Done", className: "bg-green-500/15 text-green-400" },
  failed: { label: "Failed", className: "bg-danger/15 text-danger" },
  cancelled: { label: "Cancelled", className: "bg-muted/15 text-muted" },
  skipped: { label: "Skipped", className: "bg-amber-400/15 text-amber-400" },
};

export function TransferQueue() {
  const transfers = useSftpStore((s) => s.transfers);
  const cancelTransfer = useSftpStore((s) => s.cancelTransfer);
  const retryTransfer = useSftpStore((s) => s.retryTransfer);
  const clearFinished = useSftpStore((s) => s.clearFinished);
  const [collapsed, setCollapsed] = useState(true);

  const active = transfers.filter((t) => t.state === "running").length;
  const finished = transfers.length - active;

  if (transfers.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-border bg-surface">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="flex items-center gap-2 text-xs font-semibold text-foreground"
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          Transfers
          {active > 0 && (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
              {active} active
            </span>
          )}
        </button>
        <div className="flex-1" />
        {finished > 0 && (
          <button
            type="button"
            onClick={clearFinished}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground"
          >
            <Trash2 size={12} /> Clear finished
          </button>
        )}
      </div>

      {!collapsed && (
        <ul className="max-h-52 overflow-y-auto px-2 pb-2">
          {transfers.map((record) => (
            <TransferRow
              key={record.transferId}
              record={record}
              onCancel={() => cancelTransfer(record.transferId)}
              onRetry={() => retryTransfer(record.transferId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TransferRow({
  record,
  onCancel,
  onRetry,
}: {
  record: TransferRecord;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const chip = STATE_CHIP[record.state] ?? STATE_CHIP.running;
  const indeterminate = record.total === null;
  const percent =
    record.total && record.total > 0
      ? Math.min(100, Math.round((record.transferred / record.total) * 100))
      : 0;
  const uploadFailurePartial =
    record.kind === "up" &&
    (record.state === "failed" || record.state === "cancelled");
  const hasEntries = record.entries.length > 0;
  const failedEntries = record.entries.filter((e) => e.state === "failed").length;
  const skippedEntries = record.entries.length - failedEntries;
  const resumed = record.resumedFrom != null && record.resumedFrom > 0;
  // Backend-known transfers resume their incomplete entries via sftp_retry;
  // synthetic pre-start failures ("failed-…") re-run the whole job instead.
  const isResumable = !record.transferId.startsWith("failed-");

  return (
    <li className="rounded-md px-2 py-1.5 text-xs hover:bg-raised">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-muted">
          {record.isDirectory ? (
            <Folder size={14} />
          ) : record.kind === "up" ? (
            <Upload size={14} />
          ) : (
            <Download size={14} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {record.isDirectory ? (
              <span className="shrink-0 text-muted">
                {record.kind === "up" ? <Upload size={11} /> : <Download size={11} />}
              </span>
            ) : null}
            <span
              className="truncate font-medium text-foreground"
              title={record.name}
            >
              {record.name || "…"}
            </span>
            {record.isDirectory && (
              <span className="shrink-0 rounded-full bg-muted/15 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                Folder
              </span>
            )}
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                chip.className,
              )}
            >
              {chip.label}
            </span>
            {resumed && (
              <span
                title="This transfer resumed from a partial file"
                className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent"
              >
                resumed
              </span>
            )}
          </div>

          {record.state === "running" && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-border">
              <div
                className={cn(
                  "h-full rounded-full bg-accent",
                  indeterminate && "w-1/3 animate-pulse",
                )}
                style={indeterminate ? undefined : { width: `${percent}%` }}
              />
            </div>
          )}

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted">
            {record.isDirectory && record.aggregate ? (
              <span>
                {record.aggregate.filesDone}/{record.aggregate.totalFiles} files ·{" "}
                {formatBytes(record.aggregate.bytesDone)}
                {record.aggregate.totalBytes > 0 &&
                  ` / ${formatBytes(record.aggregate.totalBytes)}`}
              </span>
            ) : (
              <span>
                {formatBytes(record.transferred)}
                {record.total != null && ` / ${formatBytes(record.total)}`}
              </span>
            )}
            {record.state === "running" && record.rate > 0 && (
              <span>{formatRate(record.rate)}</span>
            )}
            {record.isDirectory &&
              record.state === "running" &&
              record.aggregate?.currentFilePath && (
                <span
                  className="min-w-0 max-w-[60%] truncate text-muted/80"
                  title={record.aggregate.currentFilePath}
                >
                  {record.aggregate.currentFilePath}
                </span>
              )}
            {record.state === "failed" && record.errorMessage && (
              <span className="truncate text-danger" title={record.errorMessage}>
                {record.errorMessage}
              </span>
            )}
            {uploadFailurePartial && !record.isDirectory && (
              <span className="text-muted/80">
                a partial file may remain on the remote
              </span>
            )}
          </div>

          {hasEntries && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-1 flex items-center gap-1 text-[10px] text-muted hover:text-foreground"
            >
              {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {failedEntries > 0 && (
                <span className="text-danger">
                  {failedEntries} failed
                </span>
              )}
              {failedEntries > 0 && skippedEntries > 0 && <span>·</span>}
              {skippedEntries > 0 && (
                <span className="text-amber-400">{skippedEntries} skipped</span>
              )}
            </button>
          )}
        </div>

        {record.state === "running" ? (
          <button
            type="button"
            onClick={onCancel}
            aria-label={`Cancel transfer of ${record.name}`}
            title="Cancel"
            className="shrink-0 rounded p-1 text-muted hover:text-danger"
          >
            <X size={14} />
          </button>
        ) : record.state === "failed" || record.state === "cancelled" ? (
          <button
            type="button"
            onClick={onRetry}
            aria-label={`${isResumable ? "Resume" : "Retry"} transfer of ${record.name}`}
            title={
              isResumable
                ? record.isDirectory
                  ? "Resume failed and incomplete entries"
                  : "Resume"
                : "Retry"
            }
            className="shrink-0 rounded p-1 text-muted hover:text-accent"
          >
            <RotateCcw size={14} />
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}
      </div>

      {hasEntries && expanded && (
        <ul className="mt-1.5 space-y-1 border-l border-border pl-3">
          {record.entries.map((entry, index) => (
            <li
              key={`${entry.path}-${index}`}
              className="flex items-start gap-1.5 text-[10px]"
            >
              <span className="mt-0.5 shrink-0">
                {entry.state === "skipped" ? (
                  <Link2 size={11} className="text-amber-400" />
                ) : (
                  <AlertCircle size={11} className="text-danger" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <span
                  className="block truncate font-mono text-foreground/90"
                  title={entry.path}
                >
                  {entry.path || "(unknown)"}
                </span>
                <span
                  className={cn(
                    entry.state === "skipped" ? "text-amber-400/80" : "text-danger",
                  )}
                >
                  {entry.state === "skipped"
                    ? (entry.errorMessage ?? "skipped (symlink)")
                    : (entry.errorMessage ?? "failed")}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
