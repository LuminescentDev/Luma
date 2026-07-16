import { FolderOpen, KeyRound, ScrollText, Server, Settings, SquareCode, TerminalSquare } from "lucide-react";
import { useUiStore } from "../stores/uiStore";
import type { SidebarSection } from "../types";
import { cn } from "../lib/utils";

const ITEMS: { section: SidebarSection; label: string; icon: typeof Server }[] = [
  { section: "terminal", label: "Terminal", icon: TerminalSquare },
  { section: "hosts", label: "Hosts", icon: Server },
  { section: "logs", label: "Logs", icon: ScrollText },
  { section: "sftp", label: "SFTP", icon: FolderOpen },
  { section: "snippets", label: "Snippets", icon: SquareCode },
];

export function Sidebar() {
  const section = useUiStore((s) => s.section);
  const view = useUiStore((s) => s.view);
  const selectSection = useUiStore((s) => s.selectSection);
  const openSettings = useUiStore((s) => s.openSettings);
  const openKeychain = useUiStore((s) => s.openKeychain);

  return (
    <div className="flex h-full shrink-0">
      <nav
        className="flex w-19 flex-col items-center border-r border-border bg-surface py-3"
        aria-label="Primary"
      >
        <div className="flex w-full flex-col gap-1 px-2">
        <RailButton label="Keychain" active={view === "keychain"} onClick={openKeychain}><KeyRound size={18} strokeWidth={1.75} /></RailButton>
        {ITEMS.map(({ section: item, label, icon: Icon }) => (
          <RailButton
            key={item}
            label={label}
            active={view === "workspace" && section === item}
            onClick={() => selectSection(item)}
          >
            <Icon size={18} strokeWidth={1.75} />
          </RailButton>
        ))}
        </div>
        <div className="flex-1" />
        <RailButton
          label="Settings"
          active={view === "settings"}
          onClick={openSettings}
        >
          <Settings size={18} strokeWidth={1.75} />
        </RailButton>
      </nav>
    </div>
  );
}

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "relative flex h-12 w-full flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] transition-colors",
        active
          ? "bg-raised text-accent shadow-glow"
          : "text-muted hover:bg-raised hover:text-foreground",
      )}
    >
      {children}<span>{label}</span>
    </button>
  );
}
