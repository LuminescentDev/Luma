import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { EmptyState } from "./EmptyState";
import { PaneTreeView } from "./PaneTreeView";
import { SearchBar } from "./SearchBar";

export function Workspace() {
  const sessions = useSessionStore((s) => s.sessions);
  const tabs = useSessionStore((s) => s.tabs);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const searchOpen = useUiStore((s) => s.terminalSearchOpen);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="relative h-full min-w-0">
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
  );
}
