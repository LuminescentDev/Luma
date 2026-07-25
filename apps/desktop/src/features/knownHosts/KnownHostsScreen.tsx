import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Copy,
  Hash,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldX,
  Trash2,
  X,
} from "lucide-react";
import {
  useInvalidateKnownHosts,
  useKnownHosts,
} from "../../hooks/useKnownHosts";
import {
  hostsDisplay,
  isHashedHosts,
  knownHostsRemove,
  type KnownHostsEntry,
} from "../../lib/knownHosts";
import { parseLumaError } from "../../lib/hosts";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { cn } from "../../lib/utils";

/*
 * Known-hosts manager. Lists Luma's OpenSSH known_hosts trust store so a stale
 * or unexpected host key can be removed — after which reconnecting re-prompts to
 * trust the server. This is the manual remediation path referenced by the
 * changed-host-key alert. Line numbers shift on every removal, so the list is
 * always refetched (never patched) after a remove.
 */
export function KnownHostsScreen() {
  const { data: entries = [], isLoading, isError, error, refetch, isFetching } =
    useKnownHosts();
  const invalidate = useInvalidateKnownHosts();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<KnownHostsEntry | null>(null);

  const remove = useMutation({
    mutationFn: (lineNumber: number) => knownHostsRemove(lineNumber),
    // Line numbers shift after a removal — always refetch, never patch.
    onSuccess: () => {
      invalidate();
      setPending(null);
    },
  });

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (entry) =>
        entry.hosts.toLowerCase().includes(needle) ||
        entry.keyType.toLowerCase().includes(needle) ||
        entry.fingerprint.toLowerCase().includes(needle),
    );
  }, [entries, query]);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-4xl px-8 py-8">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <ShieldCheck size={22} />
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Known hosts</h1>
            <p className="mt-1 text-sm text-muted">
              Server host keys Luma has trusted. Removing an entry makes Luma
              re-prompt to verify that host the next time you connect.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted hover:border-accent hover:text-accent"
          >
            <RefreshCw
              size={14}
              className={isFetching ? "animate-spin" : undefined}
            />
            Refresh
          </button>
        </div>

        <div className="mt-5 flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 focus-within:border-accent">
          <Search size={15} className="text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by host, key type, or fingerprint…"
            aria-label="Filter known hosts"
            className="w-full bg-transparent py-2 text-sm text-foreground outline-none placeholder:text-muted"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => setQuery("")}
              className="rounded p-0.5 text-muted hover:text-foreground"
            >
              <X size={15} />
            </button>
          )}
        </div>

        <div className="mt-5">
          {isLoading ? (
            <Message>Loading known hosts…</Message>
          ) : isError ? (
            <Message tone="danger">
              <AlertTriangle size={18} className="mb-1" />
              {parseLumaError(error).message}
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-3 rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:border-accent"
              >
                Retry
              </button>
            </Message>
          ) : entries.length === 0 ? (
            <Message>
              No known hosts recorded yet. Hosts you trust when connecting appear
              here.
            </Message>
          ) : filtered.length === 0 ? (
            <Message>No entries match “{query}”.</Message>
          ) : (
            <>
              <p className="mb-2 text-xs text-muted">
                {filtered.length} of {entries.length} entr
                {entries.length === 1 ? "y" : "ies"}
              </p>
              <ul className="space-y-2">
                {filtered.map((entry) => (
                  <KnownHostRow
                    key={`${entry.lineNumber}-${entry.fingerprint}`}
                    entry={entry}
                    onRemove={() => setPending(entry)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
            remove.reset();
          }
        }}
        title="Remove known host?"
        destructive
        confirmLabel={remove.isPending ? "Removing…" : "Remove"}
        busy={remove.isPending}
        onConfirm={() => {
          if (pending) remove.mutate(pending.lineNumber);
        }}
        message={
          <div className="space-y-2">
            <p>
              Remove the trusted{" "}
              <span className="font-medium text-foreground">
                {pending ? pending.keyType : ""}
              </span>{" "}
              key for{" "}
              <span className="font-medium text-foreground">
                {pending ? hostsDisplay(pending.hosts) : ""}
              </span>
              ?
            </p>
            <p className="text-xs text-muted">
              The next time you connect to this host, Luma will ask you to verify
              and trust its key again. Only do this if you expected the key to
              change or no longer trust the stored one.
            </p>
            {remove.isError && (
              <p className="text-xs text-danger">
                {parseLumaError(remove.error).message}
              </p>
            )}
          </div>
        }
      />
    </div>
  );
}

function KnownHostRow({
  entry,
  onRemove,
}: {
  entry: KnownHostsEntry;
  onRemove: () => void;
}) {
  const hashed = isHashedHosts(entry.hosts);
  const hosts = hostsDisplay(entry.hosts);
  return (
    <li className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="min-w-0 max-w-full truncate font-mono text-sm text-foreground"
              title={hosts}
            >
              {hosts}
            </span>
            {hashed && (
              <Badge
                className="bg-muted/15 text-muted"
                icon={<Hash size={11} />}
                label="Hashed"
                title="Hostnames in this entry are hashed"
              />
            )}
            <MarkerBadge marker={entry.marker} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted">
              {entry.keyType}
            </span>
            <Fingerprint value={entry.fingerprint} />
          </div>
        </div>
        <button
          type="button"
          aria-label={`Remove known host ${hosts}`}
          title="Remove"
          onClick={onRemove}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted hover:border-danger hover:text-danger"
        >
          <Trash2 size={13} /> Remove
        </button>
      </div>
    </li>
  );
}

function Fingerprint({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span
        className="min-w-0 truncate font-mono text-[11px] text-foreground/80"
        title={value}
      >
        {value}
      </span>
      <button
        type="button"
        aria-label="Copy fingerprint"
        onClick={copy}
        className="shrink-0 rounded p-0.5 text-muted hover:bg-raised hover:text-foreground"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </span>
  );
}

function MarkerBadge({ marker }: { marker: string | null }) {
  if (!marker) return null;
  const revoked = marker.toLowerCase().includes("revok");
  return (
    <Badge
      className={
        revoked ? "bg-danger/15 text-danger" : "bg-accent/15 text-accent"
      }
      icon={revoked ? <ShieldX size={11} /> : <ShieldCheck size={11} />}
      label={marker}
      title={`Marker: ${marker}`}
    />
  );
}

function Badge({
  className,
  icon,
  label,
  title,
}: {
  className: string;
  icon: React.ReactNode;
  label: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        className,
      )}
    >
      {icon}
      {label}
    </span>
  );
}

function Message({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface/50 px-6 py-12 text-center text-sm",
        tone === "danger" ? "text-danger" : "text-muted",
      )}
    >
      {children}
    </div>
  );
}
