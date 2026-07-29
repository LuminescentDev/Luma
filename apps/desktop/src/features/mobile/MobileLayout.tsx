import { lazy, Suspense, useEffect, useRef } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import {
  useActiveRoute,
  useMobileNavStore,
  type MobileRoute,
} from "../../stores/mobileNavStore";
import { MobileTabBar } from "./MobileTabBar";
import { useNativeTabBar } from "./useNativeTabBar";
import { MobileVaultsHub } from "./MobileVaultsHub";
import { MobileConnectionsScreen } from "./MobileConnectionsScreen";
import { MobileProfileHub } from "./MobileProfileHub";
import { MobileTerminalView } from "./MobileTerminalView";
import { MobileHostsScreen } from "./MobileHostsScreen";
import { MobileSftpScreen } from "./MobileSftpScreen";
import { MobileLogsScreen } from "./MobileLogsScreen";
import { MobilePortForwardsScreen } from "./MobilePortForwardsScreen";
import { MobileScreen } from "./MobileScreen";
import { KeychainScreen } from "../keychain/KeychainScreen";
import { SnippetsScreen } from "../snippets/SnippetsScreen";
import { KnownHostsScreen } from "../knownHosts/KnownHostsScreen";
import { SnippetRunner } from "../snippets/SnippetRunner";
import { MultiHostRunDialog } from "../snippets/MultiHostRunDialog";
import { MobileFontSizeSetup } from "./MobileFontSizeSetup";
import {
  MobileAboutScreen,
  MobileAccountScreen,
  MobileAppearanceScreen,
  MobileBackupScreen,
  MobileCollaborationScreen,
  MobileSshSettingsScreen,
  MobileSyncScreen,
  MobileTerminalSettingsScreen,
} from "./MobileSettingsScreens";

/*
 * Mobile application shell: three tabs (Vaults, Connections, Profile), each with
 * its own route stack, over a floating tab bar. Navigation lives in
 * mobileNavStore rather than local state so the native iOS tab bar can drive it
 * and deep links can jump straight to a screen; the desktop layout still runs on
 * uiStore.mainView and is untouched.
 *
 * Opening a terminal session takes over the whole viewport, hiding the tab bar
 * (natively too — the plugin's view is hidden, not just covered).
 */

const SyncDialogs = lazy(() =>
  import("../sync/SyncDialogs").then((m) => ({ default: m.SyncDialogs })),
);

export function MobileLayout() {
  const tab = useMobileNavStore((s) => s.tab);
  const route = useActiveRoute();
  const pop = useMobileNavStore((s) => s.pop);
  const navigate = useMobileNavStore((s) => s.navigate);
  const fullscreen = useMobileNavStore((s) => s.fullscreen);
  const setFullscreen = useMobileNavStore((s) => s.setFullscreen);

  const tabCount = useSessionStore((s) => s.tabs.length);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);
  const prevCount = useRef(tabCount);

  const showingSession = fullscreen && tabCount > 0;
  const { native } = useNativeTabBar({
    sessionCount: tabCount,
    hidden: showingSession,
  });

  // A newly opened session (tab count rose) jumps to Connections and opens
  // full-screen. Covers connecting from Hosts and any other open path.
  useEffect(() => {
    if (tabCount > prevCount.current) {
      navigate("connections");
      setFullscreen(true);
    } else if (tabCount === 0) {
      setFullscreen(false);
    }
    prevCount.current = tabCount;
  }, [tabCount, navigate, setFullscreen]);

  const goToHosts = () => navigate("vaults", "hosts");

  if (showingSession) {
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
        {route ? (
          <RouteScreen route={route} onBack={pop} />
        ) : tab === "vaults" ? (
          <MobileVaultsHub />
        ) : tab === "connections" ? (
          <MobileConnectionsScreen
            onGoHosts={goToHosts}
            onOpen={(tabId) => {
              setActiveTab(tabId);
              setFullscreen(true);
            }}
          />
        ) : (
          <MobileProfileHub />
        )}
      </main>
      {/* The native bar owns the chrome when it attached; otherwise the web
          capsule renders. Never both. */}
      {!native && <MobileTabBar sessionCount={tabCount} />}
      <SnippetRunner />
      <MultiHostRunDialog />
      <Suspense fallback={null}>
        <SyncDialogs />
      </Suspense>
      <MobileFontSizeSetup />
    </div>
  );
}

/** Renders the screen for a pushed route. Screens that predate the mobile shell
 * (keychain, snippets, known hosts) are desktop components, so they are wrapped
 * in MobileScreen chrome for the back button and safe-area header. */
function RouteScreen({
  route,
  onBack,
}: {
  route: MobileRoute;
  onBack: () => void;
}) {
  switch (route) {
    case "hosts":
      return <MobileHostsScreen onBack={onBack} />;
    case "keychain":
      return (
        <MobileScreen onBack={onBack} scroll={false} padded={false}>
          <KeychainScreen />
        </MobileScreen>
      );
    case "port-forwards":
      return <MobilePortForwardsScreen onBack={onBack} />;
    case "snippets":
      return (
        <MobileScreen onBack={onBack} scroll={false} padded={false}>
          <SnippetsScreen />
        </MobileScreen>
      );
    case "known-hosts":
      return (
        <MobileScreen onBack={onBack} scroll={false} padded={false}>
          <KnownHostsScreen />
        </MobileScreen>
      );
    case "sftp":
      return (
        <MobileScreen title="Files" onBack={onBack} scroll={false} padded={false}>
          <MobileSftpScreen />
        </MobileScreen>
      );
    case "logs":
      return <MobileLogsScreen onBack={onBack} />;
    case "settings-account":
      return <MobileAccountScreen onBack={onBack} />;
    case "settings-appearance":
      return <MobileAppearanceScreen onBack={onBack} />;
    case "settings-terminal":
      return <MobileTerminalSettingsScreen onBack={onBack} />;
    case "settings-ssh":
      return <MobileSshSettingsScreen onBack={onBack} />;
    case "settings-sync":
      return <MobileSyncScreen onBack={onBack} />;
    case "settings-collaboration":
      return <MobileCollaborationScreen onBack={onBack} />;
    case "settings-backup":
      return <MobileBackupScreen onBack={onBack} />;
    case "settings-about":
      return <MobileAboutScreen onBack={onBack} />;
  }
}
