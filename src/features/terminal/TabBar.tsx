import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Loader2, Plus, X } from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useProfiles, useShells } from "../../hooks/useShells";
import { cn } from "../../lib/utils";

export function TabBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const closeSession = useSessionStore((s) => s.closeSession);
  const openLocalSession = useSessionStore((s) => s.openLocalSession);

  if (sessions.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-1 border-b border-border bg-surface px-1 pt-1">
      <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
        {sessions.map((session) => {
          const active = session.id === activeSessionId;
          return (
            <div
              key={session.id}
              className={cn(
                "group flex min-w-0 max-w-48 shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-sm",
                active
                  ? "border-border bg-background text-foreground"
                  : "border-transparent text-muted hover:bg-raised hover:text-foreground",
              )}
            >
              <button
                type="button"
                onClick={() => setActiveSession(session.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1.5 text-left"
              >
                {session.status === "connecting" && (
                  <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
                )}
                {session.status === "disconnected" && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted" />
                )}
                {session.status === "error" && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
                )}
                <span className="truncate">{session.title}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${session.title}`}
                onClick={() => closeSession(session.id)}
                className={cn(
                  "shrink-0 rounded p-0.5 hover:bg-raised hover:text-danger",
                  active ? "" : "invisible group-hover:visible",
                )}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="my-auto flex shrink-0 items-center">
        <button
          type="button"
          aria-label="New terminal (default shell)"
          title="New terminal"
          onClick={() => void openLocalSession()}
          className="flex h-7 w-6 items-center justify-center rounded-l-md text-muted hover:bg-raised hover:text-foreground"
        >
          <Plus size={15} />
        </button>
        <NewTerminalMenu>
          <button
            type="button"
            aria-label="Choose shell"
            className="flex h-7 w-4 items-center justify-center rounded-r-md text-muted hover:bg-raised hover:text-foreground"
          >
            <ChevronDown size={12} />
          </button>
        </NewTerminalMenu>
      </div>
    </div>
  );
}

export function NewTerminalMenu({ children }: { children: React.ReactNode }) {
  const openLocalSession = useSessionStore((s) => s.openLocalSession);
  const { data: shells } = useShells();
  const { data: profiles } = useProfiles();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-44 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow"
        >
          {(shells ?? []).map((shell) => (
            <DropdownMenu.Item
              key={shell.id}
              onSelect={() =>
                void openLocalSession({ kind: "shell", id: shell.id }, shell.name)
              }
              className="cursor-default rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface data-[highlighted]:text-accent"
            >
              {shell.name}
            </DropdownMenu.Item>
          ))}
          {(profiles?.length ?? 0) > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className="px-2.5 py-1 text-xs uppercase tracking-wider text-muted">
                Profiles
              </DropdownMenu.Label>
              {(profiles ?? []).map((profile) => (
                <DropdownMenu.Item
                  key={profile.id}
                  onSelect={() =>
                    void openLocalSession({ kind: "profile", id: profile.id }, profile.name)
                  }
                  className="cursor-default rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface data-[highlighted]:text-accent"
                >
                  {profile.name}
                </DropdownMenu.Item>
              ))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
