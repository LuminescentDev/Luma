import { useEffect } from "react";
import { Sidebar } from "../components/Sidebar";
import { Workspace } from "../features/terminal/Workspace";
import { TabBar } from "../features/terminal/TabBar";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import { terminalManager } from "../features/terminal/terminalManager";
import { useUiStore } from "../stores/uiStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTunnelStore } from "../stores/tunnelStore";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { parseShellRef } from "../lib/terminal";
import { SETTING_KEYS } from "../types";
import { TitleBar } from "../components/TitleBar";
import { KeychainScreen } from "../features/keychain/KeychainScreen";
import { HostsScreen } from "../features/hosts/HostsScreen";
import { SectionScreen } from "../features/workspace/SectionScreen";
import { SnippetsScreen } from "../features/snippets/SnippetsScreen";
import { SnippetRunner } from "../features/snippets/SnippetRunner";
import { CommandPalette } from "../features/palette/CommandPalette";
import { SyncDialogs } from "../features/sync/SyncDialogs";

export function Layout() {
  // Applies the persisted theme to <html> and tracks system changes.
  useTheme();
  const view = useUiStore((s) => s.view);
  const navOpen = useUiStore((s) => s.navOpen);
  const section = useUiStore((s) => s.section);
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

  // Global keyboard shortcuts. Terminal chords are swallowed by the xterm key
  // handler (see terminalManager) so they reach this window listener cleanly.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = navigator.userAgent.includes("Mac") ? event.metaKey : event.ctrlKey;
      if (!mod || !event.shiftKey) return;
      const session = useSessionStore.getState();
      switch (event.code) {
        case "KeyT":
          event.preventDefault();
          void session.openLocalSession();
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
          if (session.activeSessionId) {
            event.preventDefault();
            session.closeActivePane();
          }
          break;
        case "KeyP":
          event.preventDefault();
          useUiStore.getState().togglePalette();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        {navOpen && <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col bg-background">
        {view === "workspace" && section === "terminal" && <TabBar />}
        <div className="relative min-h-0 flex-1">
          {/* Keep the workspace mounted (hidden) under settings so terminals
              stay attached and refit cleanly when switching back. */}
          <div className={view !== "workspace" || section !== "terminal" ? "hidden" : "h-full"}>
            <Workspace />
          </div>
          {view === "workspace" && section === "hosts" && <HostsScreen />}
          {view === "workspace" && section === "logs" && <SectionScreen section="logs" />}
          {view === "workspace" && section === "sftp" && <SectionScreen section="sftp" />}
          {view === "workspace" && section === "snippets" && <SnippetsScreen />}
          {view === "settings" && <SettingsScreen />}
          {view === "keychain" && <KeychainScreen />}
        </div>
        </main>
      </div>
      <CommandPalette />
      <SnippetRunner />
      <SyncDialogs />
    </div>
  );
}
