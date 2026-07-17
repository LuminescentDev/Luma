import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Download,
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
 */

const STATE_CHIP: Record<TransferState, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-accent/15 text-accent" },
  completed: { label: "Done", className: "bg-green-500/15 text-green-400" },
  failed: { label: "Failed", className: "bg-danger/15 text-danger" },
  cancelled: { label: "Cancelled", className: "bg-muted/15 text-muted" },
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
  const chip = STATE_CHIP[record.state];
  const indeterminate = record.total === null;
  const percent =
    record.total && record.total > 0
      ? Math.min(100, Math.round((record.transferred / record.total) * 100))
      : 0;
  const uploadFailurePartial =
    record.kind === "up" &&
    (record.state === "failed" || record.state === "cancelled");

  return (
    <li className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-raised">
      <span className="shrink-0 text-muted">
        {record.kind === "up" ? <Upload size={14} /> : <Download size={14} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-foreground" title={record.name}>
            {record.name || "…"}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              chip.className,
            )}
          >
            {chip.label}
          </span>
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

        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
          <span>
            {formatBytes(record.transferred)}
            {record.total != null && ` / ${formatBytes(record.total)}`}
          </span>
          {record.state === "running" && record.rate > 0 && (
            <span>{formatRate(record.rate)}</span>
          )}
          {record.state === "failed" && record.errorMessage && (
            <span className="truncate text-danger" title={record.errorMessage}>
              {record.errorMessage}
            </span>
          )}
          {uploadFailurePartial && (
            <span className="text-muted/80">
              a partial file may remain on the remote
            </span>
          )}
        </div>
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
          aria-label={`Retry transfer of ${record.name}`}
          title="Retry"
          className="shrink-0 rounded p-1 text-muted hover:text-accent"
        >
          <RotateCcw size={14} />
        </button>
      ) : (
        <span className="w-6 shrink-0" />
      )}
    </li>
  );
}
