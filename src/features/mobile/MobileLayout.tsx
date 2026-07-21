import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { MobileNav, type MobileTab } from "./MobileNav";
import { MobileHostsScreen } from "./MobileHostsScreen";
import { MobileSessionsList } from "./MobileSessionsList";
import { MobileTerminalView } from "./MobileTerminalView";
import { MobileSftpScreen } from "./MobileSftpScreen";
import { MobileSettingsScreen } from "./MobileSettingsScreen";
import { SnippetsScreen } from "../snippets/SnippetsScreen";
import { SnippetRunner } from "../snippets/SnippetRunner";
import { MultiHostRunDialog } from "../snippets/MultiHostRunDialog";

/*
 * Mobile application shell. A bottom-navigation container (Hosts, Sessions,
 * SFTP, Snippets, Settings) with no title bar, sidebar, or window controls.
 * Opening a terminal session shows it full-screen over the nav. Navigation is
 * driven by local state (not the desktop uiStore.mainView), so the desktop
 * layout is untouched; new sessions auto-open full-screen by watching the shared
 * session store's tab count.
 */

const SyncDialogs = lazy(() =>
  import("../sync/SyncDialogs").then((m) => ({ default: m.SyncDialogs })),
);

export function MobileLayout() {
  const [tab, setTab] = useState<MobileTab>("hosts");
  // Whether the Sessions tab is showing a session full-screen (vs the list).
  const [fullscreen, setFullscreen] = useState(false);

  const tabCount = useSessionStore((s) => s.tabs.length);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);
  const prevCount = useRef(tabCount);

  // A newly opened session (tab count rose) jumps to the Sessions tab and opens
  // full-screen. Covers connecting from Hosts and any other open path.
  useEffect(() => {
    if (tabCount > prevCount.current) {
      setTab("sessions");
      setFullscreen(true);
    } else if (tabCount === 0) {
      setFullscreen(false);
    }
    prevCount.current = tabCount;
  }, [tabCount]);

  const goToHosts = () => {
    setFullscreen(false);
    setTab("hosts");
  };

  const onSelectTab = (next: MobileTab) => {
    setFullscreen(false);
    setTab(next);
  };

  // Full-screen terminal takes over the whole viewport (nav hidden).
  if (tab === "sessions" && fullscreen && tabCount > 0) {
    return (
      <>
        <MobileTerminalView
          onExit={() => setFullscreen(false)}
          onNewConnection={goToHosts}
        />
        <SnippetRunner />
        <MultiHostRunDialog />
        <Suspense fallback={null}>
          <SyncDialogs />
        </Suspense>
      </>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <main id="main-content" tabIndex={-1} className="min-h-0 flex-1">
        {tab === "hosts" && <MobileHostsScreen />}
        {tab === "sessions" && (
          <MobileSessionsList
            onGoHosts={goToHosts}
            onOpen={(tabId) => {
              setActiveTab(tabId);
              setFullscreen(true);
            }}
          />
        )}
        {tab === "sftp" && <MobileSftpScreen />}
        {tab === "snippets" && (
          <div className="h-full overflow-y-auto pt-safe">
            <SnippetsScreen />
          </div>
        )}
        {tab === "settings" && <MobileSettingsScreen />}
      </main>
      <MobileNav active={tab} onSelect={onSelectTab} sessionCount={tabCount} />
      <SnippetRunner />
      <MultiHostRunDialog />
      <Suspense fallback={null}>
        <SyncDialogs />
      </Suspense>
    </div>
  );
}
