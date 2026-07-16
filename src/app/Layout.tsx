import { Sidebar } from "../components/Sidebar";
import { Workspace } from "../features/terminal/Workspace";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import { useUiStore } from "../stores/uiStore";
import { useTheme } from "../hooks/useTheme";

export function Layout() {
  // Applies the persisted theme to <html> and tracks system changes.
  useTheme();
  const section = useUiStore((s) => s.section);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 bg-background">
        {section === "settings" ? <SettingsScreen /> : <Workspace />}
      </main>
    </div>
  );
}
