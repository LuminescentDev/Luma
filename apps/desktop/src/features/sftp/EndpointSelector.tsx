import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Loader2, Monitor, Plug, Server } from "lucide-react";
import { cn } from "../../lib/utils";
import type { Host } from "../../lib/hosts";
import type { PaneEndpoint } from "../../stores/sftpStore";

/*
 * The pane header control: shows what this pane is pointed at and swaps it for
 * this computer or any saved host. Both panes use it, so either side can hold
 * either kind of endpoint.
 */

type EndpointSelectorProps = {
  endpoint: Exclude<PaneEndpoint, { kind: "none" }>;
  /** Host record behind a remote endpoint, once the host list has loaded. */
  host: Host | null;
  hosts: Host[];
  /** The other pane is already showing this computer. */
  otherIsLocal: boolean;
  connectingHostId: string | null;
  onSelectLocal: () => void;
  onSelectHost: (hostId: string) => void;
  onDisconnect: () => void;
};

export function EndpointSelector({
  endpoint,
  host,
  hosts,
  otherIsLocal,
  connectingHostId,
  onSelectLocal,
  onSelectHost,
  onDisconnect,
}: EndpointSelectorProps) {
  const isLocal = endpoint.kind === "local";
  const name = isLocal ? "This computer" : (host?.name ?? "Remote");
  const detail =
    !isLocal && host
      ? `${host.username ? `${host.username}@` : ""}${host.hostname}`
      : null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-raised"
        >
          {connectingHostId ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
          ) : isLocal ? (
            <Monitor size={13} className="shrink-0 text-accent" />
          ) : (
            <Server size={13} className="shrink-0 text-accent" />
          )}
          <span className="truncate text-xs font-semibold uppercase tracking-wider text-foreground">
            {name}
          </span>
          {detail && (
            <span className="truncate text-[11px] normal-case text-muted/70">
              {detail}
            </span>
          )}
          <ChevronDown size={12} className="shrink-0 text-muted" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 max-h-80 min-w-56 overflow-y-auto rounded-lg border border-border bg-raised p-1 text-sm shadow-glow"
        >
          <DropdownMenu.Item
            disabled={otherIsLocal}
            onSelect={onSelectLocal}
            className={cn(
              "flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface data-[highlighted]:text-accent",
              otherIsLocal && "opacity-40 data-[highlighted]:text-foreground",
              isLocal && "text-accent",
            )}
          >
            <Monitor size={14} />
            <span className="flex-1">This computer</span>
            {otherIsLocal && (
              <span className="text-[10px] text-muted">in other pane</span>
            )}
          </DropdownMenu.Item>

          {hosts.length > 0 && (
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
          )}
          {hosts.map((candidate) => (
            <DropdownMenu.Item
              key={candidate.id}
              onSelect={() => onSelectHost(candidate.id)}
              className={cn(
                "flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface data-[highlighted]:text-accent",
                !isLocal && host?.id === candidate.id && "text-accent",
              )}
            >
              <Server size={14} className="shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{candidate.name}</span>
                <span className="block truncate text-[11px] text-muted">
                  {candidate.username ? `${candidate.username}@` : ""}
                  {candidate.hostname}
                </span>
              </span>
            </DropdownMenu.Item>
          ))}

          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            onSelect={onDisconnect}
            className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-danger outline-none data-[highlighted]:bg-surface"
          >
            <Plug size={14} />
            {isLocal ? "Close pane" : "Disconnect"}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
