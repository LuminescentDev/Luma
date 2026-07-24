import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Server, SquareTerminal, Star } from "lucide-react";
import { Modal } from "../../components/Modal";
import { useHosts } from "../../hooks/useHosts";
import { useSessionStore } from "../../stores/sessionStore";
import { cn } from "../../lib/utils";
import type { RestoreDescriptor } from "../../types";

/**
 * Pick a connection to split the CURRENT pane with. Choosing a host splits the
 * active pane and spawns that SSH connection (or a local shell) alongside it —
 * making an ad-hoc, unsaved two-connection group. Reuses the same host rows and
 * data as the New tab launcher.
 */
export function SplitWithHostDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: hosts = [] } = useHosts();
  const splitActivePaneWith = useSessionStore((s) => s.splitActivePaneWith);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      // Focus after Radix finishes its open transition/focus trap.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const needle = query.trim().toLowerCase();
  const matching = useMemo(
    () =>
      hosts.filter((host) =>
        [host.name, host.hostname, host.username, ...host.tags]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle)),
      ),
    [hosts, needle],
  );

  const split = (restore: RestoreDescriptor) => {
    void splitActivePaneWith("row", restore);
    onOpenChange(false);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Split with host" size="md">
      <div className="relative">
        <Search
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search hosts"
          aria-label="Search hosts"
          className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-accent"
        />
      </div>

      <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
        {!needle && (
          <button
            type="button"
            onClick={() => split({ kind: "local" })}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-raised"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <SquareTerminal size={15} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">Local terminal</span>
              <span className="block text-xs text-muted">Open your default shell</span>
            </span>
          </button>
        )}
        {matching.map((host) => (
          <button
            key={host.id}
            type="button"
            onClick={() =>
              split({
                kind: "ssh",
                hostId: host.id,
                title: host.name,
                connectionTarget: host.hostname,
              })
            }
            className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-raised"
          >
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted group-hover:text-accent",
                host.favorite && "text-amber-400",
              )}
            >
              {host.favorite ? (
                <Star size={15} fill="currentColor" />
              ) : (
                <Server size={15} />
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{host.name}</span>
              <span className="block truncate text-xs text-muted">
                {host.username ? `${host.username}@` : ""}
                {host.hostname}:{host.port}
              </span>
            </span>
            <span className="ml-auto text-xs text-muted">SSH</span>
          </button>
        ))}
        {matching.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-muted">
            No hosts match “{query}”.
          </p>
        )}
      </div>
    </Modal>
  );
}
