import { lazy, Suspense, useEffect, useRef } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { useMobileNavStore, type MobileRoute } from "../../stores/mobileNavStore";
import { MobileStackNav } from "./MobileStackNav";
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
import { MobileAnalyticsConsentSheet } from "../privacy/MobileAnalyticsConsentSheet";
import { useAnalyticsConsent } from "../privacy/useAnalyticsConsent";
import { VoiceComposerDialog } from "../voiceComposer/VoiceComposerDialog";
import { MobileAgentInboxScreen } from "./MobileAgentInboxScreen";
import { MobileHostSurfaces } from "./MobileHostSurfaces";
import { MobileCollabSurfaces, useCollabViewing } from "./MobileCollabSurfaces";
import { ServerStatsScreen } from "../serverStats/ServerStatsScreen";
import { FleetOverviewScreen } from "../fleet/FleetOverviewScreen";
import { useServerStatsStore } from "../../stores/serverStatsStore";
import { useUiStore } from "../../stores/uiStore";
import {
  MobileAboutScreen,
  MobileAccountScreen,
  MobileAppearanceScreen,
  MobileCollaborationScreen,
  MobilePrivacyScreen,
  MobileSshSettingsScreen,
  MobileTerminalSettingsScreen,
  MobileVaultsScreen,
} from "./MobileSettingsScreens";

/*
 * Mobile application shell: three tabs (Vaults, Connections, Profile), each with
 * its own route stack, over a floating tab bar. Navigation lives in
 * mobileNavStore rather than local state so the native iOS tab bar can drive it
 * and deep links can jump straight to a screen; the desktop layout still runs on
 * uiStore.mainView and is untouched.
 *
 * The stack is rendered by MobileStackNav, which slides pushed screens in from
 * the right and lets a left-edge drag pop them back — so the back chevron is a
 * fallback rather than the only way out of a detail screen.
 *
 * Opening a terminal session takes over the whole viewport, hiding the tab bar
 * (natively too — the plugin's view is hidden, not just covered).
 */

const SyncDialogs = lazy(() =>
  import("../sync/SyncDialogs").then((m) => ({ default: m.SyncDialogs })),
);

export function MobileLayout() {
  const tab = useMobileNavStore((s) => s.tab);
  const stack = useMobileNavStore((s) => s.stacks[s.tab]);
  const pop = useMobileNavStore((s) => s.pop);
  const navigate = useMobileNavStore((s) => s.navigate);
  const fullscreen = useMobileNavStore((s) => s.fullscreen);
  const setFullscreen = useMobileNavStore((s) => s.setFullscreen);
  const sheetOpen = useMobileNavStore((s) => s.sheetOpen);

  const tabCount = useSessionStore((s) => s.tabs.length);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);
  const focusSession = useSessionStore((s) => s.focusSession);
  const prevCount = useRef(tabCount);

  // Decides which of the two first-run prompts owns the screen; see the mount
  // at the bottom of the shell.
  const consentPending = useAnalyticsConsent().shouldPrompt;

  const showingSession = fullscreen && tabCount > 0;
  // A shared terminal joined as a viewer covers the whole shell, like a session.
  const collabViewing = useCollabViewing();
  const { native } = useNativeTabBar({
    sessionCount: tabCount,
    // A full-screen sheet is a DOM overlay, which cannot cover the native bar —
    // so the bar is told to hide for those too, not just for a session.
    hidden: showingSession || sheetOpen || collabViewing,
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
        {/* Only reachable from the terminal accessory bar, so it is mounted
            with the session view rather than the whole shell. */}
        <MobileVoiceComposer />
        {/* The terminal's own menu offers Repository, Workspaces and Preview
            for the session's host, so their surfaces mount here too. */}
        <MobileHostSurfaces />
        {/* Same menu offers "Share terminal…", and a join deep link can arrive
            while a session is open. */}
        <MobileCollabSurfaces />
        <Suspense fallback={null}>
          <SyncDialogs />
        </Suspense>
        {/* Also mounted here, unlike MobileFontSizeSetup: workspace restore can
            drop a returning user straight into a session, and the consent
            prompt has to be answered before anything is collected. */}
        <MobileAnalyticsConsentSheet />
      </>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <main id="main-content" tabIndex={-1} className="min-h-0 flex-1">
        <MobileStackNav
          rootKey={tab}
          stack={stack}
          onPop={pop}
          renderPane={(route) =>
            route ? (
              <RouteScreen
                route={route as MobileRoute}
                onBack={pop}
                onOpenSession={(sessionId) => {
                  focusSession(sessionId);
                  setFullscreen(true);
                }}
              />
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
            )
          }
        />
      </main>
      {/* The native bar owns the chrome when it attached; otherwise the web
          capsule renders. Never both. */}
      {!native && !sheetOpen && !collabViewing && (
        <MobileTabBar sessionCount={tabCount} />
      )}
      <SnippetRunner />
      <MultiHostRunDialog />
      <MobileHostSurfaces />
      <MobileCollabSurfaces />
      <Suspense fallback={null}>
        <SyncDialogs />
      </Suspense>
      {/* Exclusive: on a fresh install both would otherwise stack. Consent is
          answered first, then the font-size picker. */}
      {consentPending ? <MobileAnalyticsConsentSheet /> : <MobileFontSizeSetup />}
    </div>
  );
}

/** Binds the shared voice-composer dialog to the uiStore target, so the mobile
 * accessory bar opens the same reviewed-draft flow the desktop pane menu does. */
function MobileVoiceComposer() {
  const voiceTarget = useUiStore((s) => s.voiceTarget);
  const closeVoice = useUiStore((s) => s.closeVoice);
  return (
    <VoiceComposerDialog
      open={voiceTarget !== null}
      onOpenChange={(o) => !o && closeVoice()}
      sessionId={voiceTarget?.sessionId ?? null}
      label={voiceTarget?.label}
    />
  );
}

/**
 * The server dashboard: CPU, memory, disk, network, processes and Docker health
 * for one host. The screen picks its own host and remembers the choice, so back
 * from the dashboard returns to that picker and back from the picker leaves the
 * route — matching how a pushed stack behaves elsewhere.
 */
function MobileServersRoute({ onBack }: { onBack: () => void }) {
  const clear = useServerStatsStore((s) => s.clear);
  return (
    <MobileScreen
      // Leaving the route drops the dashboard's cached SSH connection; the
      // screen's own "choose another host" control stays for switching hosts
      // without leaving.
      onBack={() => {
        clear();
        onBack();
      }}
      scroll={false}
      padded={false}
    >
      <ServerStatsScreen />
    </MobileScreen>
  );
}

/** Fleet health across favorite hosts. "Details" hands off to the dashboard
 * route rather than the desktop's section navigation. */
function MobileFleetRoute({ onBack }: { onBack: () => void }) {
  const push = useMobileNavStore((s) => s.push);
  return (
    <MobileScreen onBack={onBack} scroll={false} padded={false}>
      <FleetOverviewScreen
        onOpenHost={() => push("servers")}
        onChooseHosts={() => push("hosts")}
      />
    </MobileScreen>
  );
}

/** Renders the screen for a pushed route. Screens that predate the mobile shell
 * (keychain, snippets, known hosts) are desktop components, so they are wrapped
 * in MobileScreen chrome for the back button and safe-area header. */
function RouteScreen({
  route,
  onBack,
  onOpenSession,
}: {
  route: MobileRoute;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  switch (route) {
    case "hosts":
      return <MobileHostsScreen onBack={onBack} />;
    case "servers":
      return <MobileServersRoute onBack={onBack} />;
    case "fleet":
      return <MobileFleetRoute onBack={onBack} />;
    case "agent-inbox":
      return (
        <MobileAgentInboxScreen onBack={onBack} onOpenSession={onOpenSession} />
      );
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
    case "settings-vaults":
      return <MobileVaultsScreen onBack={onBack} />;
    case "settings-collaboration":
      return <MobileCollaborationScreen onBack={onBack} />;
    case "settings-privacy":
      return <MobilePrivacyScreen onBack={onBack} />;
    case "settings-about":
      return <MobileAboutScreen onBack={onBack} />;
  }
}
