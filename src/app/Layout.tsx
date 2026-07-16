import { useEffect } from "react";
import { Sidebar } from "../components/Sidebar";
import { Workspace } from "../features/terminal/Workspace";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import { terminalManager } from "../features/terminal/terminalManager";
import { useUiStore } from "../stores/uiStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { parseShellRef } from "../lib/terminal";
import { SETTING_KEYS } from "../types";

export function Layout() {
  // Applies the persisted theme to <html> and tracks system changes.
  useTheme();
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

  // Global shortcut: new terminal tab.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = navigator.userAgent.includes("Mac") ? event.metaKey : event.ctrlKey;
      if (mod && event.shiftKey && event.code === "KeyT") {
        event.preventDefault();
        void useSessionStore.getState().openLocalSession();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 bg-background">
        <div className={section === "settings" ? "hidden" : "h-full"}>
          <Workspace />
        </div>
        {section === "settings" && <SettingsScreen />}
      </main>
    </div>
  );
}
