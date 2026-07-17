import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef } from "react";
import {
  Cable,
  Columns2,
  Command,
  Loader2,
  MoreHorizontal,
  Plus,
  SquarePlus,
  Rows2,
  Server,
  X,
} from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { useProfiles, useShells } from "../../hooks/useShells";
import { findLeaf } from "./paneTree";
import { cn } from "../../lib/utils";
import { DistroIcon } from "../../components/DistroIcon";
import { ContextMenu, type MenuAction } from "../../components/ContextMenu";
import type { SplitDirection, TerminalSession, WorkspaceTab } from "../../types";

/**
 * The shared workspace action list backing both the 3-dot "Workspace options"
 * dropdown and the terminal-tab right-click menu, so they never drift apart.
 * Split/close entries are conditioned exactly like the toolbar buttons.
 */
function workspaceActions(deps: {
  openNewTab: () => void;
  splitActivePane: (direction: SplitDirection) => Promise<void>;
  closeActivePane: () => void;
  openPalette: () => void;
  hasTab: boolean;
  hasSession: boolean;
  onCloseTab?: () => void;
}): MenuAction[] {
  const actions: MenuAction[] = [
    {
      label: "New tab",
      icon: <Plus size={15} />,
      hint: "Ctrl+Shift+T",
      onSelect: () => deps.openNewTab(),
    },
  ];
  if (deps.hasTab) {
    actions.push(
      {
        label: "Split right",
        icon: <Columns2 size={15} />,
        hint: "Ctrl+Shift+D",
        onSelect: () => void deps.splitActivePane("row"),
      },
      {
        label: "Split down",
        icon: <Rows2 size={15} />,
        hint: "Ctrl+Shift+E",
        onSelect: () => void deps.splitActivePane("column"),
      },
    );
  }
  if (deps.hasSession) {
    actions.push({
      label: "Close pane",
      icon: <X size={15} />,
      hint: "Ctrl+Shift+W",
      onSelect: () => deps.closeActivePane(),
    });
  }
  actions.push({ separator: true });
  actions.push({
    label: "Command palette",
    icon: <Command size={15} />,
    hint: "Ctrl+Shift+P",
    onSelect: () => deps.openPalette(),
  });
  if (deps.onCloseTab) {
    actions.push({ separator: true });
    actions.push({
      label: "Close tab",
      icon: <X size={15} />,
      onSelect: deps.onCloseTab,
    });
  }
  return actions;
}

export function TabBar() {
  const tabListRef = useRef<HTMLDivElement>(null);
  const sessions = useSessionStore((s) => s.sessions);
  const tabs = useSessionStore((s) => s.tabs);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);
  const closeTab = useSessionStore((s) => s.closeTab);
  const splitActivePane = useSessionStore((s) => s.splitActivePane);
  const closeActivePane = useSessionStore((s) => s.closeActivePane);
  const openPalette = useUiStore((s) => s.openPalette);
  const openNewTab = useUiStore((s) => s.openNewTab);
  const closeNewTab = useUiStore((s) => s.closeNewTab);
  const newTabOpen = useUiStore((s) => s.newTabOpen);
  // A terminal tab is "active" only when the terminal workspace is the current
  // main view; selecting a sidebar section deselects the tabs (they stay in the
  // bar so the user can click one to return).
  const terminalActive = useUiStore((s) => s.mainView === "terminal");

  const activeSessionOf = (tab: WorkspaceTab): TerminalSession | undefined => {
    const leaf = findLeaf(tab.root, tab.activePaneId);
    return leaf ? sessions.find((s) => s.id === leaf.sessionId) : undefined;
  };

  // Keep keyboard-selected tabs visible when the strip overflows. Mouse wheels
  // usually report vertical deltas, so translate those into horizontal motion
  // while the pointer is over the tab strip.
  useEffect(() => {
    tabListRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, terminalActive, newTabOpen]);

  const scrollTabs = (event: React.WheelEvent<HTMLDivElement>) => {
    const tabList = event.currentTarget;
    if (
      tabList.scrollWidth <= tabList.clientWidth ||
      Math.abs(event.deltaX) >= Math.abs(event.deltaY)
    ) {
      return;
    }

    event.preventDefault();
    tabList.scrollLeft += event.deltaY;
  };

  return (
    <div
      data-tauri-drag-region
      className="flex h-full min-w-0 flex-1 items-center gap-1"
    >
      <div
        ref={tabListRef}
        role="tablist"
        aria-label="Terminal tabs"
        onWheel={scrollTabs}
        className="flex min-w-0 flex-1 touch-pan-x items-center gap-1 overflow-x-auto overflow-y-hidden"
      >
        {tabs.map((tab) => {
          const session = activeSessionOf(tab);
          const active = tab.id === activeTabId && terminalActive && !newTabOpen;
          const title = session?.title ?? "Terminal";
          const tabActions = workspaceActions({
            openNewTab,
            splitActivePane,
            closeActivePane,
            openPalette,
            hasTab: true,
            hasSession: Boolean(session),
            onCloseTab: () => closeTab(tab.id),
          });
          return (
            <ContextMenu
              key={tab.id}
              actions={tabActions}
              minWidth="min-w-52"
              // Activating the tab first makes Split/Close pane target it,
              // matching the toolbar buttons that act on the active tab.
              onOpenChange={(open) => {
                if (open) setActiveTab(tab.id);
              }}
            >
            <div
              role="presentation"
              onDoubleClick={(event) => event.stopPropagation()}
              className={cn(
                "group flex h-7 min-w-32 max-w-52 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors",
                active
                  ? "bg-raised text-foreground shadow-sm"
                  : "bg-raised/45 text-muted hover:bg-raised/75 hover:text-foreground",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-current={active ? "page" : undefined}
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
            </ContextMenu>
          );
        })}
        {newTabOpen && (
          <div
            role="presentation"
            onDoubleClick={(event) => event.stopPropagation()}
            className="group flex h-7 min-w-32 max-w-52 shrink-0 items-center gap-1.5 rounded-lg bg-raised px-2.5 text-xs text-foreground shadow-sm"
          >
            <button
              type="button"
              role="tab"
              aria-selected="true"
              aria-current="page"
              onClick={openNewTab}
              className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1.5 text-left"
            >
              <SquarePlus size={13} className="shrink-0 text-accent" />
              <span className="truncate">New tab</span>
            </button>
            <button
              type="button"
              aria-label="Close New tab"
              onClick={closeNewTab}
              className="shrink-0 rounded p-0.5 hover:bg-surface hover:text-danger"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>

      <div
        onDoubleClick={(event) => event.stopPropagation()}
        className="flex shrink-0 items-center"
      >
        <button
          type="button"
          aria-label="New tab"
          title="New tab (Ctrl+Shift+T)"
          onClick={openNewTab}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-foreground"
        >
          <Plus size={15} />
        </button>
        <WorkspaceMenu>
          <button
            type="button"
            aria-label="Workspace options"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-foreground data-[state=open]:bg-raised data-[state=open]:text-foreground"
          >
            <MoreHorizontal size={15} />
          </button>
        </WorkspaceMenu>
      </div>
    </div>
  );
}

/** The three-dots "Workspace options" dropdown. Mirrors NewTerminalMenu's
 * Radix pattern/styling and exposes the same workspace actions as the standalone
 * toolbar buttons and their keyboard chords. Split/close items only appear when
 * a tab/session exists, matching how the toolbar buttons are conditioned. */
function WorkspaceMenu({ children }: { children: React.ReactNode }) {
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const splitActivePane = useSessionStore((s) => s.splitActivePane);
  const closeActivePane = useSessionStore((s) => s.closeActivePane);
  const openNewTab = useUiStore((s) => s.openNewTab);
  const openPalette = useUiStore((s) => s.openPalette);

  const actions = workspaceActions({
    openNewTab,
    splitActivePane,
    closeActivePane,
    openPalette,
    hasTab: Boolean(activeTabId),
    hasSession: Boolean(activeSessionId),
  });

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-52 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow"
        >
          {actions.map((action, index) =>
            "separator" in action && action.separator ? (
              <DropdownMenu.Separator
                key={`sep-${index}`}
                className="my-1 h-px bg-border"
              />
            ) : (
              <DropdownMenu.Item
                key={action.label}
                onSelect={action.onSelect}
                className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface data-[highlighted]:text-accent"
              >
                <span className="shrink-0 text-muted">{action.icon}</span>
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                {action.hint && (
                  <span className="shrink-0 text-xs text-muted">{action.hint}</span>
                )}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function TabIcon({ session }: { session: TerminalSession | undefined }) {
  if (!session) return null;
  if (session.status === "connecting") {
    return <Loader2 size={12} className="shrink-0 animate-spin text-accent" />;
  }
  if (session.type === "ssh" || session.type === "serial") {
    // A live/previously-authenticated SSH session shows the detected distro logo
    // in place of the generic server icon. Error sessions keep the danger server
    // (an error usually means auth never completed, so no distro was detected);
    // a disconnected session keeps its logo but dimmed. "unknown" and undetected
    // ids fall through to the generic server icon below.
    if (
      session.type === "ssh" &&
      session.osId &&
      session.osId !== "unknown" &&
      (session.status === "connected" || session.status === "disconnected")
    ) {
      return (
        <DistroIcon
          osId={session.osId}
          size={13}
          label={session.osPrettyName ?? undefined}
          className={cn(
            "shrink-0",
            session.status === "disconnected" && "opacity-50 grayscale",
          )}
        />
      );
    }
    const Icon = session.type === "serial" ? Cable : Server;
    return (
      <Icon
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
