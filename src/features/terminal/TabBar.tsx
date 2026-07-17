import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Columns2,
  Command,
  Loader2,
  MoreHorizontal,
  Plus,
  Rows2,
  Server,
  X,
} from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { useProfiles, useShells } from "../../hooks/useShells";
import { findLeaf } from "./paneTree";
import { cn } from "../../lib/utils";
import type { TerminalSession, WorkspaceTab } from "../../types";

export function TabBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const tabs = useSessionStore((s) => s.tabs);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);
  const closeTab = useSessionStore((s) => s.closeTab);
  const splitActivePane = useSessionStore((s) => s.splitActivePane);
  const openPalette = useUiStore((s) => s.openPalette);
  const openNewTab = useUiStore((s) => s.openNewTab);
  const newTabOpen = useUiStore((s) => s.newTabOpen);

  const activeSessionOf = (tab: WorkspaceTab): TerminalSession | undefined => {
    const leaf = findLeaf(tab.root, tab.activePaneId);
    return leaf ? sessions.find((s) => s.id === leaf.sessionId) : undefined;
  };

  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-1">
      <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const session = activeSessionOf(tab);
          const active = tab.id === activeTabId;
          const title = session?.title ?? "Terminal";
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex h-7 min-w-32 max-w-52 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs",
                active
                  ? "border-border bg-raised text-foreground"
                  : "border-transparent text-muted hover:bg-raised hover:text-foreground",
              )}
            >
              <button
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1.5 text-left"
              >
                <TabIcon session={session} />
                <span className="truncate">{title}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${title}`}
                onClick={() => closeTab(tab.id)}
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

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label="New tab"
          title="New tab (Ctrl+Shift+T)"
          onClick={openNewTab}
          className={cn("flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-foreground", newTabOpen && "bg-raised text-foreground")}
        >
          <Plus size={15} />
        </button>
        {activeTabId && (
          <>
            <button
              type="button"
              aria-label="Split right"
              title="Split right (Ctrl+Shift+D)"
              onClick={() => void splitActivePane("row")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-foreground"
            >
              <Columns2 size={15} />
            </button>
            <button
              type="button"
              aria-label="Split down"
              title="Split down (Ctrl+Shift+E)"
              onClick={() => void splitActivePane("column")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-foreground"
            >
              <Rows2 size={15} />
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="Command palette"
          title="Command palette (Ctrl+Shift+P)"
          onClick={() => openPalette()}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-foreground"
        >
          <Command size={15} />
        </button>
        <button
          type="button"
          aria-label="Workspace options"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-foreground"
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
    </div>
  );
}

function TabIcon({ session }: { session: TerminalSession | undefined }) {
  if (!session) return null;
  if (session.status === "connecting") {
    return <Loader2 size={12} className="shrink-0 animate-spin text-accent" />;
  }
  if (session.type === "ssh") {
    return (
      <Server
        size={12}
        className={cn(
          "shrink-0",
          session.status === "error"
            ? "text-danger"
            : session.status === "disconnected"
              ? "text-muted"
              : "text-accent",
        )}
      />
    );
  }
  if (session.status === "disconnected") {
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted" />;
  }
  if (session.status === "error") {
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />;
  }
  return null;
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
