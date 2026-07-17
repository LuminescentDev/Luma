import { ShieldAlert, X } from "lucide-react";
import type { HostKeyFingerprint } from "../../lib/ssh";

/*
 * Blocking, full-pane warning shown when SSH reports host-key-changed. This is
 * a security-critical state: the remote host key no longer matches the known
 * record, which can indicate a man-in-the-middle. We deliberately do NOT offer
 * an auto-accept — the user must verify the server out-of-band and update their
 * known_hosts manually before reconnecting.
 */
export function HostKeyChangedAlert({
  hostTitle,
  message,
  scannedKeys,
  knownKeys,
  onClose,
}: {
  hostTitle: string;
  message: string;
  /** Keys observed on the network now (what the server is presenting). */
  scannedKeys?: HostKeyFingerprint[];
  /** Previously trusted keys, shown alongside for out-of-band comparison. */
  knownKeys?: HostKeyFingerprint[];
  onClose: () => void;
}) {
  const hasComparison =
    (scannedKeys?.length ?? 0) > 0 || (knownKeys?.length ?? 0) > 0;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="host-key-changed-title"
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/95 p-6 backdrop-blur"
    >
      <div className="w-full max-w-md rounded-xl border border-danger/50 bg-surface p-5 shadow-glow">
        <div className="flex items-center gap-2 text-danger">
          <ShieldAlert size={20} className="shrink-0" />
          <h2 id="host-key-changed-title" className="text-sm font-semibold">
            Host key changed for {hostTitle}
          </h2>
        </div>
        <p className="mt-3 text-sm text-muted">{message}</p>
        {hasComparison && (
          <div className="mt-3 space-y-3 rounded-lg border border-border bg-background p-3">
            <FingerprintList
              label="Previously trusted"
              keys={knownKeys}
              tone="muted"
            />
            <FingerprintList
              label="Presented now"
              keys={scannedKeys}
              tone="danger"
            />
          </div>
        )}
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
          <li>
            If you expected this (the server was rebuilt or its key rotated),
            verify the new fingerprint through a trusted channel.
          </li>
          <li>
            Then remove the stale entry from your <code>known_hosts</code> file
            before reconnecting.
          </li>
          <li>
            If you did not expect this, do not connect — the connection may be
            intercepted.
          </li>
        </ul>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:border-accent hover:text-accent"
          >
            <X size={14} /> Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function FingerprintList({
  label,
  keys,
  tone,
}: {
  label: string;
  keys?: HostKeyFingerprint[];
  tone: "muted" | "danger";
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      {keys && keys.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {keys.map((key) => (
            <li key={`${key.keyType}:${key.fingerprint}`} className="break-all font-mono text-xs">
              <span className="text-muted">{key.keyType} </span>
              <span className={tone === "danger" ? "text-danger" : "text-foreground"}>
                {key.fingerprint}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-1 text-xs text-muted">Not available.</div>
      )}
    </div>
  );
}
