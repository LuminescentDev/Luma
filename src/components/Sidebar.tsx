import {
  FolderOpen,
  Search,
  Server,
  Settings,
  SquareCode,
  SquareTerminal,
} from "lucide-react";
import { useUiStore } from "../stores/uiStore";
import { useSessionStore } from "../stores/sessionStore";
import type { SidebarSection } from "../types";
import { cn } from "../lib/utils";
import { SidebarPanel } from "./SidebarPanel";

const ITEMS: { section: SidebarSection; label: string; icon: typeof Search }[] = [
  { section: "search", label: "Search", icon: Search },
  { section: "hosts", label: "Hosts", icon: Server },
  { section: "sessions", label: "Sessions", icon: SquareTerminal },
  { section: "sftp", label: "SFTP", icon: FolderOpen },
  { section: "snippets", label: "Snippets", icon: SquareCode },
];

export function Sidebar() {
  const section = useUiStore((s) => s.section);
  const setSection = useUiStore((s) => s.setSection);
  const sessionCount = useSessionStore((s) => s.sessions.length);

  return (
    <div className="flex h-full shrink-0">
      <nav
        className="flex w-12 flex-col items-center gap-1 border-r border-border bg-surface py-2"
        aria-label="Primary"
      >
        {ITEMS.map(({ section: item, label, icon: Icon }) => (
          <RailButton
            key={item}
            label={label}
            active={section === item}
            onClick={() => setSection(item)}
            badge={item === "sessions" && sessionCount > 0 ? sessionCount : undefined}
          >
            <Icon size={18} strokeWidth={1.75} />
          </RailButton>
        ))}
        <div className="flex-1" />
        <RailButton
          label="Settings"
          active={section === "settings"}
          onClick={() => setSection("settings")}
        >
          <Settings size={18} strokeWidth={1.75} />
        </RailButton>
      </nav>
      {section !== "settings" && <SidebarPanel section={section} />}
    </div>
  );
}

function RailButton({
  label,
  active,
  onClick,
  badge,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
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
        "relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
        active
          ? "bg-raised text-accent shadow-glow"
          : "text-muted hover:bg-raised hover:text-foreground",
      )}
    >
      {children}
      {badge !== undefined && (
        <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-foreground">
          {badge}
        </span>
      )}
    </button>
  );
}
