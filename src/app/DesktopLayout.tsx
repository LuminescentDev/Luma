import { lazy, Suspense, type ComponentType } from "react";
import { Sidebar } from "../components/Sidebar";
import { Workspace } from "../features/terminal/Workspace";
import { useUiStore } from "../stores/uiStore";
import { TitleBar } from "../components/TitleBar";
import { HostsScreen } from "../features/hosts/HostsScreen";
import { SectionScreen } from "../features/workspace/SectionScreen";
import { SnippetsScreen } from "../features/snippets/SnippetsScreen";
import { SnippetRunner } from "../features/snippets/SnippetRunner";
import { MultiHostRunDialog } from "../features/snippets/MultiHostRunDialog";
import { CommandPalette } from "../features/palette/CommandPalette";
import { SerialConnectDialog } from "../features/terminal/SerialConnectDialog";

/*
 * Desktop application shell — the original Luma layout, unchanged. Heavier,
 * rarely-first-viewed surfaces (settings, SFTP, keychain) and the
 * always-mounted-but-idle sync/updater dialogs are code-split behind Suspense so
 * they stay out of the initial main bundle. The terminal workspace and hosts
 * screen stay eager since one of them is always the first thing shown.
 */
const named = <T extends string>(
  loader: () => Promise<Record<T, ComponentType>>,
  name: T,
) => lazy(() => loader().then((m) => ({ default: m[name] })));

const SettingsScreen = named(
  () => import("../features/settings/SettingsScreen"),
  "SettingsScreen",
);
const KeychainScreen = named(
  () => import("../features/keychain/KeychainScreen"),
  "KeychainScreen",
);
const SftpScreen = named(() => import("../features/sftp/SftpScreen"), "SftpScreen");
const KnownHostsScreen = named(
  () => import("../features/knownHosts/KnownHostsScreen"),
  "KnownHostsScreen",
);
const SyncDialogs = named(
  () => import("../features/sync/SyncDialogs"),
  "SyncDialogs",
);
const UpdateBanner = named(
  () => import("../features/updater/UpdateBanner"),
  "UpdateBanner",
);

/** Minimal centered fallback shown while a lazy screen chunk loads. */
function ScreenFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-background text-sm text-muted">
      Loading…
    </div>
  );
}

export function DesktopLayout() {
  const mainView = useUiStore((s) => s.mainView);
  const navOpen = useUiStore((s) => s.navOpen);

  return (
    <div className="flex h-full flex-col">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        {navOpen && <Sidebar />}
        <main
          id="main-content"
          tabIndex={-1}
          className="flex min-w-0 flex-1 flex-col bg-background"
        >
          <div className="relative min-h-0 flex-1">
            {/* Keep the workspace mounted (hidden) under other views so terminals
                stay attached and refit cleanly when switching back. */}
            <div className={mainView !== "terminal" ? "hidden" : "h-full"}>
              <Workspace />
            </div>
            {mainView === "hosts" && <HostsScreen />}
            {mainView === "logs" && <SectionScreen section="logs" />}
            {mainView === "sftp" && (
              <Suspense fallback={<ScreenFallback />}>
                <SftpScreen />
              </Suspense>
            )}
            {mainView === "snippets" && <SnippetsScreen />}
            {mainView === "settings" && (
              <Suspense fallback={<ScreenFallback />}>
                <SettingsScreen />
              </Suspense>
            )}
            {mainView === "keychain" && (
              <Suspense fallback={<ScreenFallback />}>
                <KeychainScreen />
              </Suspense>
            )}
            {mainView === "known-hosts" && (
              <Suspense fallback={<ScreenFallback />}>
                <KnownHostsScreen />
              </Suspense>
            )}
          </div>
        </main>
      </div>
      <CommandPalette />
      <SerialConnectDialog />
      <SnippetRunner />
      <MultiHostRunDialog />
      {/* Always mounted but idle until triggered; a null fallback keeps them
          invisible while their chunks load. */}
      <Suspense fallback={null}>
        <SyncDialogs />
        <UpdateBanner />
      </Suspense>
    </div>
  );
}
