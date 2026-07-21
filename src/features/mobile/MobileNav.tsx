import { FolderOpen, Server, Settings, SquareCode, SquareTerminal } from "lucide-react";
import { cn } from "../../lib/utils";

export type MobileTab = "hosts" | "sessions" | "sftp" | "snippets" | "settings";

const ITEMS: { tab: MobileTab; label: string; icon: typeof Server }[] = [
  { tab: "hosts", label: "Hosts", icon: Server },
  { tab: "sessions", label: "Sessions", icon: SquareTerminal },
  { tab: "sftp", label: "SFTP", icon: FolderOpen },
  { tab: "snippets", label: "Snippets", icon: SquareCode },
  { tab: "settings", label: "Settings", icon: Settings },
];

/** Fixed bottom navigation for the mobile shell. Five primary destinations, each
 * a >=44px touch target, with the home-indicator inset respected via pb-safe. */
export function MobileNav({
  active,
  onSelect,
  sessionCount,
}: {
  active: MobileTab;
  onSelect: (tab: MobileTab) => void;
  sessionCount: number;
}) {
  return (
    <nav
      aria-label="Primary"
      className="shrink-0 border-t border-border bg-surface pb-safe"
    >
      <ul className="flex items-stretch">
        {ITEMS.map((item) => {
          const isActive = active === item.tab;
          const Icon = item.icon;
          return (
            <li key={item.tab} className="flex-1">
              <button
                type="button"
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
                onClick={() => onSelect(item.tab)}
                className={cn(
                  "relative flex min-h-14 w-full flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] transition-colors",
                  isActive ? "text-accent" : "text-muted active:text-foreground",
                )}
              >
                <span className="relative">
                  <Icon size={20} strokeWidth={1.75} />
                  {item.tab === "sessions" && sessionCount > 0 && (
                    <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-accent-foreground">
                      {sessionCount}
                    </span>
                  )}
                </span>
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
