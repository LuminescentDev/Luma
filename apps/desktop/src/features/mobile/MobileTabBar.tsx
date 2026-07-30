import { FolderLock, Terminal, User } from "lucide-react";
import { useMobileNavStore, type MobileTab } from "../../stores/mobileNavStore";
import { cn } from "../../lib/utils";

/*
 * Web fallback tab bar: a floating capsule that hovers over the scrolling
 * content (screens reserve room with .pb-tabbar). Used on Android and on iOS
 * versions where the native Liquid Glass bar is unavailable — when the native
 * bar IS active it owns the chrome and this component renders nothing, so the
 * two can never both be on screen. See mobile/tabBar.ts for that handoff.
 */

export const TAB_ITEMS: {
  tab: MobileTab;
  label: string;
  icon: typeof FolderLock;
  /** SF Symbol used by the native iOS bar for this tab. */
  sfSymbol: string;
}[] = [
  { tab: "vaults", label: "Vaults", icon: FolderLock, sfSymbol: "lock.square.stack" },
  { tab: "connections", label: "Connections", icon: Terminal, sfSymbol: "terminal" },
  { tab: "profile", label: "Profile", icon: User, sfSymbol: "person.crop.circle" },
];

export function MobileTabBar({ sessionCount }: { sessionCount: number }) {
  const tab = useMobileNavStore((s) => s.tab);
  const selectTab = useMobileNavStore((s) => s.selectTab);

  return (
    <nav
      aria-label="Primary"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center pb-safe"
    >
      <ul
        className={cn(
          "pointer-events-auto mb-2 flex items-center gap-1 rounded-full p-1.5",
          // Glassmorphism approximation of the native material: a translucent
          // surface with a blurred backdrop and a bright top edge.
          "border border-border bg-surface/85 shadow-lg shadow-black/20",
          "backdrop-blur-2xl backdrop-saturate-150",
        )}
      >
        {TAB_ITEMS.map((item) => {
          const isActive = tab === item.tab;
          const Icon = item.icon;
          return (
            <li key={item.tab}>
              <button
                type="button"
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
                onClick={() => selectTab(item.tab)}
                className={cn(
                  "flex min-h-14 min-w-[92px] flex-col items-center justify-center gap-0.5 rounded-full px-4 text-[11px] transition-colors",
                  isActive
                    ? "bg-raised/80 text-foreground"
                    : "text-muted active:text-foreground",
                )}
              >
                <span className="relative">
                  <Icon size={20} strokeWidth={1.75} />
                  {item.tab === "connections" && sessionCount > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-accent-foreground">
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
