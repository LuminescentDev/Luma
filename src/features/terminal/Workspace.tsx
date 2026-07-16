import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { TabBar } from "./TabBar";
import { EmptyState } from "./EmptyState";
import { TerminalView } from "./TerminalView";
import { SearchBar } from "./SearchBar";

export function Workspace() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const searchOpen = useUiStore((s) => s.terminalSearchOpen);

  const active = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <TabBar />
      <div className="relative min-h-0 flex-1">
        {active ? (
          <>
            {searchOpen && <SearchBar sessionId={active.id} />}
            <TerminalView key={active.id} session={active} />
          </>
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}
