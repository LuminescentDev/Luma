import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw,
  Square,
} from "lucide-react";
import { Modal } from "../../components/Modal";
import {
  useWebPreviewStore,
  selectPreviewsForHost,
} from "../../stores/webPreviewStore";
import { previewUrl, type WebListener } from "../../lib/webPreview";
import { cn } from "../../lib/utils";

/*
 * Discovers HTTP servers listening on a connected SSH host and previews them
 * through a temporary local forward bound to 127.0.0.1. The preview opens in
 * the system browser rather than an in-app webview; the local URL stays
 * visible and copyable so it also works if the system handler fails.
 *
 * Previews are per-host, not per-session: closing the terminal that started
 * one leaves it running until it is closed from the list below.
 */
export function WebPreviewDialog({
  open,
  onOpenChange,
  hostId,
  hostLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostId: string | null;
  hostLabel?: string;
}) {
  const listeners = useWebPreviewStore((s) => s.listeners);
  const discovering = useWebPreviewStore((s) => s.discovering);
  const discoverError = useWebPreviewStore((s) => s.discoverError);
  const opening = useWebPreviewStore((s) => s.opening);
  const openError = useWebPreviewStore((s) => s.openError);
  const discover = useWebPreviewStore((s) => s.discover);
  const openPreview = useWebPreviewStore((s) => s.open);
  const launch = useWebPreviewStore((s) => s.launch);
  const closePreview = useWebPreviewStore((s) => s.close);
  const clearErrors = useWebPreviewStore((s) => s.clearErrors);
  // Select the raw record and derive here: returning a fresh array from a
  // zustand v5 selector re-renders forever (useSyncExternalStore identity).
  const allPreviews = useWebPreviewStore((s) => s.previews);
  const previews = useMemo(
    () => selectPreviewsForHost({ previews: allPreviews }, hostId),
    [allPreviews, hostId],
  );

  const [manualPort, setManualPort] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !hostId) return;
    setManualPort("");
    clearErrors();
    void discover(hostId);
  }, [open, hostId, discover, clearErrors]);

  if (!hostId) return null;

  const manual = Number.parseInt(manualPort, 10);
  const manualValid =
    Number.isInteger(manual) && manual > 0 && manual <= 65535;

  const previewFor = (port: number) =>
    previews.find((preview) => preview.port === port);

  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).then(
      () => setCopied(url),
      () => {},
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Preview web server"
      description={
        hostLabel
          ? `HTTP servers listening on ${hostLabel}`
          : "HTTP servers listening on this host"
      }
      size="lg"
      footer={
        <button
          type="button"
          disabled={discovering}
          onClick={() => void discover(hostId)}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
        >
          <RefreshCw
            size={14}
            className={cn(discovering && "animate-spin")}
          />
          Rescan
        </button>
      }
    >
      <div className="space-y-4">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Discovered listeners
          </h3>
          {discovering ? (
            <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
              <Loader2 size={16} className="animate-spin text-muted" />
              <p className="text-xs text-muted">Scanning for web servers…</p>
            </div>
          ) : discoverError ? (
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-danger">{discoverError}</p>
              <p className="mt-1 text-xs text-muted">
                Enter a port manually below to preview it anyway.
              </p>
            </div>
          ) : listeners.length === 0 ? (
            <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-border text-center">
              <p className="text-sm font-medium">No web servers found</p>
              <p className="mt-1 text-xs text-muted">
                Nothing HTTP-like is listening, or the host hides other users&apos;
                sockets. Enter a port manually below.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {listeners.map((listener) => (
                <ListenerRow
                  key={listener.port}
                  listener={listener}
                  busy={!!opening[listener.port]}
                  previewLocalPort={previewFor(listener.port)?.localPort}
                  onOpen={() =>
                    void openPreview(
                      hostId,
                      listener.port,
                      listener.bindAddress,
                    )
                  }
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Preview a specific port
          </h3>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!manualValid) return;
              void openPreview(hostId, manual);
            }}
          >
            <input
              type="text"
              inputMode="numeric"
              value={manualPort}
              onChange={(event) => setManualPort(event.target.value)}
              placeholder="Remote port, e.g. 5173"
              aria-label="Remote port"
              className="w-48 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={!manualValid || !!opening[manual]}
              className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110 disabled:opacity-50"
            >
              {manualValid && opening[manual] ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Globe size={14} />
              )}
              Open preview
            </button>
          </form>
          {openError && <p className="mt-2 text-xs text-danger">{openError}</p>}
        </section>

        {previews.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Open previews
            </h3>
            <div className="space-y-2">
              {previews.map((preview) => {
                const url = previewUrl(preview);
                return (
                  <div
                    key={preview.tunnelId}
                    className="flex items-start gap-2 rounded-lg border border-border bg-background p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                          preview
                        </span>
                        <span className="truncate font-mono text-xs text-foreground">
                          {url}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted">
                        {preview.remoteBind}:{preview.port} → 127.0.0.1:
                        {preview.localPort}
                      </p>
                      {copied === url && (
                        <p className="mt-1 text-xs text-muted">
                          Copied to clipboard.
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Copy URL for port ${preview.port}`}
                        onClick={() => copy(url)}
                        className="rounded-md p-1.5 text-muted hover:text-foreground"
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Reopen preview for port ${preview.port}`}
                        onClick={() => void launch(preview)}
                        className="rounded-md p-1.5 text-muted hover:text-accent"
                      >
                        <ExternalLink size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Close preview for port ${preview.port}`}
                        onClick={() => void closePreview(preview.tunnelId)}
                        className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:border-danger hover:text-danger"
                      >
                        <Square size={12} /> Close
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}

function ListenerRow({
  listener,
  busy,
  previewLocalPort,
  onOpen,
}: {
  listener: WebListener;
  busy: boolean;
  previewLocalPort?: number;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-background p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm font-semibold text-foreground">
            :{listener.port}
          </span>
          {listener.kind && (
            <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-accent">
              {listener.kind}
            </span>
          )}
          {previewLocalPort !== undefined && (
            <span className="flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              Previewing
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-muted">
          {listener.bindAddress}
          {listener.process ? ` · ${listener.process}` : ""}
          {listener.pid !== null ? ` · pid ${listener.pid}` : ""}
        </p>
      </div>
      <button
        type="button"
        aria-label={`Open preview for port ${listener.port}`}
        disabled={busy}
        onClick={onOpen}
        className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
      >
        {busy ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <ExternalLink size={12} />
        )}
        {previewLocalPort === undefined ? "Open preview" : "Reopen"}
      </button>
    </div>
  );
}
