import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { EmptyState } from "./EmptyState";
import { PaneTreeView } from "./PaneTreeView";
import { SearchBar } from "./SearchBar";
import { NewTabLauncher } from "./NewTabLauncher";
import { useSyncExternalStore } from "react";
import { detachedTabIds, detachedTabsVersion, subscribeDetachedTabs } from "./detachedTabs";

export function Workspace() {
  useSyncExternalStore(subscribeDetachedTabs, detachedTabsVersion, detachedTabsVersion);
  const sessions = useSessionStore((s) => s.sessions);
  const tabs = useSessionStore((s) => s.tabs);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const searchOpen = useUiStore((s) => s.terminalSearchOpen);
  const newTabIds = useUiStore((s) => s.newTabIds);
  const activeNewTabId = useUiStore((s) => s.activeNewTabId);

  const activeTab = tabs.find((t) => t.id === activeTabId && !detachedTabIds().has(t.id));

  return (
    <div className="relative h-full min-w-0">
      {/* data-tab-drop-workspace carries the visible tab's id so a tab dragged
          from the strip into this area groups (splits) with it — see TabBar. */}
      <div
        className={activeNewTabId ? "hidden" : "h-full"}
        data-tab-drop-workspace={activeTab?.id}
      >
      {activeTab ? (
        <>
          {searchOpen && activeSessionId && <SearchBar sessionId={activeSessionId} />}
          {/* Keying by tab id detaches the previous tab's terminals and attaches
              this tab's on switch, exactly matching the single-terminal flow. */}
          <PaneTreeView key={activeTab.id} tab={activeTab} sessions={sessions} />
        </>
      ) : (
        <EmptyState />
      )}
      </div>
      {newTabIds.map((tabId) => (
        <NewTabLauncher
          key={tabId}
          tabId={tabId}
          active={tabId === activeNewTabId}
        />
      ))}
    </div>
  );
}
