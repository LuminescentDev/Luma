import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import {
  Cable,
  Columns2,
  Combine,
  Command,
  Loader2,
  MoreHorizontal,
  Plus,
  Save,
  SplitSquareHorizontal,
  SquarePlus,
  Rows2,
  Server,
  X,
} from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { useProfiles, useShells } from "../../hooks/useShells";
import { collectLeaves, findLeaf } from "./paneTree";
import { cn } from "../../lib/utils";
import { DistroIcon } from "../../components/DistroIcon";
import { ContextMenu, type MenuAction } from "../../components/ContextMenu";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
import { SplitWithHostDialog } from "./SplitWithHostDialog";
import { useTabDragStore, type TabDropZone } from "../../stores/tabDragStore";
import type { SplitDirection, TerminalSession, WorkspaceTab } from "../../types";

/** A tab is restorable (saveable as a template) when at least one of its panes
 * hosts a session with a restore descriptor. */
function tabHasRestorable(
  tab: WorkspaceTab,
  sessions: TerminalSession[],
): boolean {
  return collectLeaves(tab.root).some((leaf) =>
    sessions.some((s) => s.id === leaf.sessionId && s.restore),
  );
}

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
  /** Open the "Split with host…" picker (splits the active pane with a
   * different connection). */
  onSplitWithHost?: () => void;
  /** Save the active tab's layout as a workspace template. */
  onSaveTemplate?: () => void;
  /** Whether the active tab has anything restorable to save. */
  canSaveTemplate?: boolean;
  /** Merge this tab into the previous tab (tab context menu only). */
  onMergeIntoPrevious?: () => void;
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
    if (deps.onSplitWithHost) {
      actions.push({
        label: "Split with host…",
        icon: <SplitSquareHorizontal size={15} />,
        onSelect: deps.onSplitWithHost,
      });
    }
  }
  if (deps.hasSession) {
    actions.push({
      label: "Close pane",
      icon: <X size={15} />,
      hint: "Ctrl+Shift+W",
      onSelect: () => deps.closeActivePane(),
    });
  }
  if (deps.onSaveTemplate) {
    actions.push({ separator: true });
    actions.push({
      label: "Save tab as template",
      icon: <Save size={15} />,
      disabled: deps.canSaveTemplate === false,
      onSelect: deps.onSaveTemplate,
    });
  }
  actions.push({ separator: true });
  actions.push({
    label: "Command palette",
    icon: <Command size={15} />,
    hint: "Ctrl+Shift+P",
    onSelect: () => deps.openPalette(),
  });
  if (deps.onMergeIntoPrevious || deps.onCloseTab) {
    actions.push({ separator: true });
  }
  if (deps.onMergeIntoPrevious) {
    actions.push({
      label: "Merge into previous tab",
      icon: <Combine size={15} />,
      onSelect: deps.onMergeIntoPrevious,
    });
  }
  if (deps.onCloseTab) {
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
  const mergeTabs = useSessionStore((s) => s.mergeTabs);
  const openPalette = useUiStore((s) => s.openPalette);
  const openNewTab = useUiStore((s) => s.openNewTab);
  const closeNewTab = useUiStore((s) => s.closeNewTab);
  const newTabOpen = useUiStore((s) => s.newTabOpen);

  // Pointer-based drag state. Native HTML drag/drop is unreliable inside a
  // frameless WebView2 titlebar, where it competes with Tauri window dragging.
  const tabDrag = useRef<{
    pointerId: number;
    sourceId: string;
    title: string;
    startX: number;
    startY: number;
    dragging: boolean;
    targetId: string | null;
  } | null>(null);
  const suppressTabClick = useRef(false);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const draggedTabId = useTabDragStore((s) => s.sourceTabId);
  const draggedTitle = useTabDragStore((s) => s.sourceTitle);
  const dragX = useTabDragStore((s) => s.x);
  const dragY = useTabDragStore((s) => s.y);
  const selectedTargetTabId = useTabDragStore((s) => s.targetTabId);
  const selectedDropZone = useTabDragStore((s) => s.zone);
  const beginVisualDrag = useTabDragStore((s) => s.begin);
  const moveVisualDrag = useTabDragStore((s) => s.move);
  const clearVisualDrag = useTabDragStore((s) => s.clear);
  // Workspace-action dialogs (Save template / Split with host). The tab whose
  // layout the save dialog serializes is captured when the action fires.
  const [saveTemplateTab, setSaveTemplateTab] = useState<WorkspaceTab | null>(null);
  const [splitHostOpen, setSplitHostOpen] = useState(false);
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

  const dragWindowFromEmptyStrip = (
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    // Keep native window dragging off the tab elements themselves. Tauri drag
    // regions and HTML5 draggable elements compete for the same pointer gesture
    // in WebView2, which leaves tab targets showing the "not allowed" cursor.
    if (event.button === 0 && event.target === event.currentTarget) {
      void getCurrentWindow().startDragging();
    }
  };

  const startTabDrag = (
    event: React.PointerEvent<HTMLDivElement>,
    tabId: string,
    title: string,
  ) => {
    if (
      event.button !== 0 ||
      (event.target as Element).closest("[data-tab-close]")
    ) {
      return;
    }

    tabDrag.current = {
      pointerId: event.pointerId,
      sourceId: tabId,
      title,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      targetId: null,
    };
    // NB: pointer capture is deliberately NOT set here. Capturing on the outer
    // wrapper makes Chromium/WebView2 retarget the subsequent compatibility
    // `click` event to the capturing element, so the inner role="tab" button's
    // onClick never fires and a plain click can no longer activate the tab.
    // Capture is instead taken once a real drag begins (see moveTabDrag).
  };

  const moveTabDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = tabDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (!drag.dragging) {
      const distance = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (distance < 5) return;
      drag.dragging = true;
      suppressTabClick.current = true;
      // Take pointer capture only now that the gesture is a genuine drag, so
      // pointermove keeps tracking outside the wrapper. Plain clicks never reach
      // this branch and therefore never suffer click retargeting.
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      beginVisualDrag(drag.sourceId, drag.title, event.clientX, event.clientY);
    }

    event.preventDefault();
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const targetId =
      element instanceof Element
        ? element.closest<HTMLElement>("[data-luma-tab-id]")?.dataset.lumaTabId ?? null
        : null;
    const paneTarget =
      element instanceof Element
        ? element.closest<HTMLElement>("[data-tab-drop-pane]")
        : null;
    let dropZone: TabDropZone | null = null;
    if (paneTarget) {
      const rect = paneTarget.getBoundingClientRect();
      const distances: Array<[TabDropZone, number]> = [
        ["left", event.clientX - rect.left],
        ["right", rect.right - event.clientX],
        ["top", event.clientY - rect.top],
        ["bottom", rect.bottom - event.clientY],
      ];
      dropZone = distances.reduce((closest, candidate) =>
        candidate[1] < closest[1] ? candidate : closest,
      )[0];
    }
    drag.targetId = targetId && targetId !== drag.sourceId ? targetId : drag.targetId;
    if (
      targetId &&
      targetId !== drag.sourceId &&
      useTabDragStore.getState().targetTabId !== targetId
    ) {
      setActiveTab(targetId);
    }
    setDragOverTabId((current) =>
      current === targetId ? current : targetId !== drag.sourceId ? targetId : null,
    );
    moveVisualDrag(
      event.clientX,
      event.clientY,
      targetId && targetId !== drag.sourceId ? targetId : undefined,
      dropZone,
      paneTarget?.dataset.tabDropPane ?? null,
    );
  };

  const finishTabDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = tabDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    tabDrag.current = null;
    setDragOverTabId(null);

    if (drag.dragging) {
      event.preventDefault();
      const { targetTabId, targetPaneId, zone } = useTabDragStore.getState();
      if (targetTabId && targetPaneId && zone) {
        const direction = zone === "left" || zone === "right" ? "row" : "column";
        const placement = zone === "left" || zone === "top" ? "before" : "after";
        mergeTabs(
          drag.sourceId,
          targetTabId,
          direction,
          placement,
          targetPaneId,
        );
      } else if (drag.targetId) {
        mergeTabs(drag.sourceId, drag.targetId);
      }
      clearVisualDrag();
      window.setTimeout(() => {
        suppressTabClick.current = false;
      }, 0);
    }
  };

  const cancelTabDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tabDrag.current?.pointerId !== event.pointerId) return;
    tabDrag.current = null;
    suppressTabClick.current = false;
    setDragOverTabId(null);
    clearVisualDrag();
  };

  return (
    <>
    <div
      onMouseDown={dragWindowFromEmptyStrip}
      className="flex h-full min-w-0 flex-1 items-center gap-1"
    >
      <div
        ref={tabListRef}
        role="tablist"
        aria-label="Terminal tabs"
        onMouseDown={dragWindowFromEmptyStrip}
        onWheel={scrollTabs}
        className="flex min-w-0 flex-1 touch-pan-x items-center gap-1 overflow-x-auto overflow-y-hidden"
      >
        {tabs.map((tab, index) => {
          const session = activeSessionOf(tab);
          const active = tab.id === activeTabId && terminalActive && !newTabOpen;
          const title = session?.title ?? "Terminal";
          const paneCount = collectLeaves(tab.root).length;
          const isDropTarget = dragOverTabId === tab.id;
          const isDragging = draggedTabId === tab.id;
          const tabActions = workspaceActions({
            openNewTab,
            splitActivePane,
            closeActivePane,
            openPalette,
            hasTab: true,
            hasSession: Boolean(session),
            onCloseTab: () => closeTab(tab.id),
            onSplitWithHost: () => setSplitHostOpen(true),
            onSaveTemplate: () => setSaveTemplateTab(tab),
            canSaveTemplate: tabHasRestorable(tab, sessions),
            // Only offer merge when there is a previous tab to merge into.
            onMergeIntoPrevious:
              index > 0
                ? () => mergeTabs(tab.id, tabs[index - 1].id)
                : undefined,
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
              data-luma-tab-id={tab.id}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => startTabDrag(event, tab.id, title)}
              onPointerMove={moveTabDrag}
              onPointerUp={finishTabDrag}
              onPointerCancel={cancelTabDrag}
              className={cn(
                "group flex h-7 min-w-32 max-w-52 shrink-0 touch-none cursor-grab items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors active:cursor-grabbing",
                active
                  ? "bg-raised text-foreground shadow-sm"
                  : "bg-raised/45 text-muted hover:bg-raised/75 hover:text-foreground",
                isDropTarget &&
                  "bg-raised ring-2 ring-inset ring-accent",
                isDragging && "scale-95 opacity-40",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-current={active ? "page" : undefined}
                onClick={(event) => {
                  if (suppressTabClick.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  setActiveTab(tab.id);
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1.5 text-left"
              >
                <TabIcon session={session} />
                <span className="truncate">{title}</span>
                {isDropTarget && (
                  <span className="flex shrink-0 items-center gap-1 rounded bg-accent px-1.5 text-[10px] font-semibold leading-4 text-white shadow-sm">
                    <Combine size={10} /> Split
                  </span>
                )}
                {paneCount > 1 && (
                  <span
                    aria-label={`${paneCount} panes`}
                    title={`${paneCount} panes`}
                    className="shrink-0 rounded bg-accent/15 px-1 text-[10px] font-medium leading-4 text-accent"
                  >
                    {paneCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                data-tab-close
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
      {draggedTabId && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[100] flex min-w-44 flex-col gap-1.5 rounded-xl border border-accent/50 bg-raised/95 p-2.5 text-xs text-foreground shadow-glow backdrop-blur"
          style={{
            left: dragX + 14,
            top: dragY + 14,
          }}
        >
          <div className="flex items-center gap-2 font-medium">
            <Combine size={14} className="shrink-0 text-accent" />
            <span className="max-w-48 truncate">{draggedTitle}</span>
          </div>
          <span className={cn(
            "rounded-md px-2 py-1 text-[10px] font-medium",
            dragOverTabId
              ? "bg-accent text-white"
              : "bg-surface text-muted",
          )}>
            {selectedDropZone
              ? `Release to ${selectedDropZone}`
              : selectedTargetTabId
                ? "Choose a split position in the workspace"
                : "Drag onto another tab to split"}
          </span>
        </div>
      )}

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
        <WorkspaceMenu
          onSplitWithHost={() => setSplitHostOpen(true)}
          onSaveTemplate={() => {
            const tab = tabs.find((t) => t.id === activeTabId);
            if (tab) setSaveTemplateTab(tab);
          }}
        >
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
    <SaveTemplateDialog
      open={saveTemplateTab !== null}
      onOpenChange={(open) => {
        if (!open) setSaveTemplateTab(null);
      }}
      tab={saveTemplateTab}
    />
    <SplitWithHostDialog open={splitHostOpen} onOpenChange={setSplitHostOpen} />
    </>
  );
}

/** The three-dots "Workspace options" dropdown. Mirrors NewTerminalMenu's
 * Radix pattern/styling and exposes the same workspace actions as the standalone
 * toolbar buttons and their keyboard chords. Split/close items only appear when
 * a tab/session exists, matching how the toolbar buttons are conditioned. */
function WorkspaceMenu({
  children,
  onSplitWithHost,
  onSaveTemplate,
}: {
  children: React.ReactNode;
  onSplitWithHost: () => void;
  onSaveTemplate: () => void;
}) {
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const splitActivePane = useSessionStore((s) => s.splitActivePane);
  const closeActivePane = useSessionStore((s) => s.closeActivePane);
  const sessions = useSessionStore((s) => s.sessions);
  const activeTab = useSessionStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId),
  );
  const openNewTab = useUiStore((s) => s.openNewTab);
  const openPalette = useUiStore((s) => s.openPalette);

  const actions = workspaceActions({
    openNewTab,
    splitActivePane,
    closeActivePane,
    openPalette,
    hasTab: Boolean(activeTabId),
    hasSession: Boolean(activeSessionId),
    onSplitWithHost: activeTabId ? onSplitWithHost : undefined,
    onSaveTemplate: activeTab ? onSaveTemplate : undefined,
    canSaveTemplate: activeTab ? tabHasRestorable(activeTab, sessions) : false,
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
