import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { Sidebar } from "../components/Sidebar";
import { Workspace } from "../features/terminal/Workspace";
import { terminalManager } from "../features/terminal/terminalManager";
import { useUiStore } from "../stores/uiStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTemplateStore } from "../stores/templateStore";
import { useTunnelStore } from "../stores/tunnelStore";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { parseShellRef } from "../lib/terminal";
import { getAllSettings } from "../lib/settings";
import {
  parseSnapshot,
  startSnapshotPersistence,
} from "../features/terminal/sessionSnapshot";
import { SETTING_KEYS } from "../types";
import { TitleBar } from "../components/TitleBar";
import { HostsScreen } from "../features/hosts/HostsScreen";
import { SectionScreen } from "../features/workspace/SectionScreen";
import { SnippetsScreen } from "../features/snippets/SnippetsScreen";
import { SnippetRunner } from "../features/snippets/SnippetRunner";
import { CommandPalette } from "../features/palette/CommandPalette";
import { SerialConnectDialog } from "../features/terminal/SerialConnectDialog";
import { useUpdaterStore } from "../stores/updaterStore";
import { hasPlatformModifier } from "../lib/platform";

/*
 * Code-split the heavier, rarely-first-viewed surfaces (settings, SFTP,
 * keychain) and the always-mounted-but-usually-idle sync/updater dialogs into
 * their own chunks. This keeps them (and their dependency subtrees) out of the
 * initial main bundle; each loads on demand behind a Suspense boundary. The
 * terminal workspace and hosts screen stay eager since one of them is always the
 * first thing shown.
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

export function Layout() {
  // Applies the persisted theme to <html> and tracks system changes.
  useTheme();
  const mainView = useUiStore((s) => s.mainView);
  const navOpen = useUiStore((s) => s.navOpen);
  const { data: settings } = useSettings();

  // Push persisted terminal settings into the manager (outside React state).
  useEffect(() => {
    if (!settings) return;
    terminalManager.configure({
      fontSize: Number(settings[SETTING_KEYS.fontSize] ?? 14),
      scrollback: Number(settings[SETTING_KEYS.scrollback] ?? 5000),
      defaultShell: parseShellRef(settings[SETTING_KEYS.defaultShell]),
    });
  }, [settings]);

  // Reflect any tunnels the backend already has running (e.g. after a reload).
  useEffect(() => {
    void useTunnelStore.getState().hydrate();
  }, []);

  // Load saved workspace templates once so the New tab launcher can list them.
  useEffect(() => {
    void useTemplateStore.getState().load();
  }, []);

  // Automatic, opt-out update check on launch. Runs one silent check after a
  // short delay when enabled; the store guards against nagging twice per launch
  // and swallows dev-build check failures. Kept separate from session-restore.
  useEffect(() => {
    if (!settings) return;
    if (settings[SETTING_KEYS.checkOnLaunch] === false) return; // default on
    if (useUpdaterStore.getState().autoChecked) return;
    const timer = setTimeout(() => {
      void useUpdaterStore.getState().autoCheck();
    }, 4000);
    return () => clearTimeout(timer);
  }, [settings]);

  // Restore the previous workspace (if enabled) then keep the snapshot fresh.
  // Order matters: the saved snapshot is read into memory BEFORE persistence
  // starts, so an empty-store write can never clobber it mid-restore. Each pane
  // re-spawns from its descriptor; terminal content is never restored.
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void (async () => {
      try {
        const settings = await getAllSettings();
        const restoreEnabled =
          settings[SETTING_KEYS.restoreSessions] !== false; // default on
        const snapshot = parseSnapshot(settings[SETTING_KEYS.workspaceSnapshot]);
        const alreadyOpen = useSessionStore.getState().tabs.length > 0;
        if (
          !cancelled &&
          !alreadyOpen &&
          restoreEnabled &&
          snapshot &&
          snapshot.tabs.length > 0
        ) {
          useSessionStore.getState().restoreFromSnapshot(snapshot);
        }
      } catch {
        // First run or unreadable snapshot: start clean, surface nothing.
      } finally {
        if (!cancelled) stop = startSnapshotPersistence();
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // Global keyboard shortcuts. Terminal chords are swallowed by the xterm key
  // handler (see terminalManager) so they reach this window listener cleanly.
  useEffect(() => {
    const cycleTab = (direction: 1 | -1) => {
      const { tabs, activeTabId, setActiveTab } = useSessionStore.getState();
      if (tabs.length < 2) return;
      const current = tabs.findIndex((tab) => tab.id === activeTabId);
      const base = current === -1 ? 0 : current;
      const next = (base + direction + tabs.length) % tabs.length;
      setActiveTab(tabs[next].id);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const mod = hasPlatformModifier(event);

      // Workspace tab switching (cross-platform). Ctrl+Tab / Ctrl+Shift+Tab is
      // the universal tab-cycle chord (Ctrl even on macOS); mod+PageUp/PageDown
      // mirrors browser tab navigation. These bubble up from xterm because the
      // terminal key handler declines them.
      if (event.ctrlKey && event.code === "Tab") {
        event.preventDefault();
        cycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      if (mod && (event.code === "PageUp" || event.code === "PageDown")) {
        event.preventDefault();
        cycleTab(event.code === "PageUp" ? -1 : 1);
        return;
      }

      if (!mod || !event.shiftKey) return;
      const session = useSessionStore.getState();
      switch (event.code) {
        case "KeyT":
          event.preventDefault();
          useUiStore.getState().openNewTab();
          break;
        case "KeyD":
          event.preventDefault();
          void session.splitActivePane("row");
          break;
        case "KeyE":
          event.preventDefault();
          void session.splitActivePane("column");
          break;
        case "KeyW":
          // Always consume the chord (closeActivePane no-ops when there is no
          // active session). Ctrl/Cmd+Shift+W is a reserved "close" browser
          // accelerator in the webview; preventing default here stops the webview
          // from swallowing/acting on it before the app closes the pane.
          event.preventDefault();
          session.closeActivePane();
          break;
        case "KeyP":
          event.preventDefault();
          useUiStore.getState().togglePalette();
          break;
        default:
          break;
      }
    };
    // Capture phase so the app intercepts reserved chords (notably
    // Ctrl/Cmd+Shift+W) before the webview's default browser-accelerator
    // handling, regardless of which element currently holds focus.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

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
        </div>
        </main>
      </div>
      <CommandPalette />
      <SerialConnectDialog />
      <SnippetRunner />
      {/* Always mounted but idle until triggered; a null fallback keeps them
          invisible while their chunks load. */}
      <Suspense fallback={null}>
        <SyncDialogs />
        <UpdateBanner />
      </Suspense>
    </div>
  );
}
