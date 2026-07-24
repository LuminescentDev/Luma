import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { HostRunState, HostRunStatus } from "../../stores/snippetHostRunStore";
import { describeSshError } from "../hosts/sshErrors";
import { cn } from "../../lib/utils";

/*
 * Per-host result rows for a multi-host snippet run. Output is keyed strictly by
 * hostId (the store never mixes hosts), with stdout and stderr shown as visually
 * distinct blocks. Failures explain the SSH category; "unsupported" hosts get a
 * dedicated hint since embedded exec is unavailable for system-OpenSSH hosts.
 */

const STATUS_CHIP: Record<HostRunStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-muted/15 text-muted" },
  running: { label: "Running", className: "bg-accent/15 text-accent" },
  ok: { label: "OK", className: "bg-green-500/15 text-green-400" },
  failed: { label: "Failed", className: "bg-danger/15 text-danger" },
  cancelled: { label: "Cancelled", className: "bg-muted/15 text-muted" },
  unsupported: { label: "Unsupported", className: "bg-amber-400/15 text-amber-400" },
};

export function SnippetRunResults({
  hosts,
  hostName,
}: {
  hosts: HostRunState[];
  hostName: (hostId: string) => string;
}) {
  return (
    <ul className="space-y-1.5">
      {hosts.map((host) => (
        <HostResultRow key={host.hostId} host={host} name={hostName(host.hostId)} />
      ))}
    </ul>
  );
}

function HostResultRow({ host, name }: { host: HostRunState; name: string }) {
  const hasOutput = host.stdout.length > 0 || host.stderr.length > 0;
  const isFailure =
    host.status === "failed" || host.status === "cancelled" || host.status === "unsupported";
  // Auto-expand rows that have something to show; still user-collapsible.
  const [expanded, setExpanded] = useState(hasOutput || isFailure);
  const chip = STATUS_CHIP[host.status];
  const canToggle = hasOutput || isFailure;

  return (
    <li className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => canToggle && setExpanded((v) => !v)}
        aria-expanded={canToggle ? expanded : undefined}
        disabled={!canToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:cursor-default"
      >
        <span className="shrink-0 text-muted">
          {canToggle ? (
            expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            <span className="inline-block w-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={name}>
          {name}
        </span>
        {host.status === "ok" && host.exitCode != null && host.exitCode !== 0 && (
          <span className="shrink-0 text-[10px] text-muted">exit {host.exitCode}</span>
        )}
        {host.status === "running" ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
        ) : null}
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            chip.className,
          )}
        >
          {chip.label}
        </span>
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-border bg-background/40 px-3 py-2">
          {host.status === "unsupported" && (
            <p className="text-xs text-amber-400">
              This host requires system OpenSSH, so non-interactive snippet
              execution is unavailable — run it in a terminal instead.
            </p>
          )}
          {host.status === "failed" && (
            <p className="text-xs text-danger">
              {describeSshError(host.errorCategory, host.errorMessage)}
            </p>
          )}
          {host.status === "cancelled" && (
            <p className="text-xs text-muted">
              {host.errorMessage ?? "Cancelled."}
            </p>
          )}
          {host.stdout && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background px-2.5 py-2 font-mono text-[11px] text-foreground/90">
              {host.stdout}
            </pre>
          )}
          {host.stderr && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-danger/30 bg-danger/5 px-2.5 py-2 font-mono text-[11px] text-danger/90">
              {host.stderr}
            </pre>
          )}
          {!hasOutput &&
            (host.status === "ok" || host.status === "running") && (
              <p className="text-xs text-muted/70">
                {host.status === "running" ? "Waiting for output…" : "No output."}
              </p>
            )}
        </div>
      )}
    </li>
  );
}
