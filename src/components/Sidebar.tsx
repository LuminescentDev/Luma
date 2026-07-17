import { useRef } from "react";
import { KeyRound, ScrollText, Server, Settings, SquareCode } from "lucide-react";
import { useUiStore } from "../stores/uiStore";
import type { SidebarSection } from "../types";
import { cn } from "../lib/utils";

const ITEMS: { section: SidebarSection; label: string; icon: typeof Server }[] = [
  { section: "hosts", label: "Hosts", icon: Server },
  { section: "logs", label: "Logs", icon: ScrollText },
  { section: "snippets", label: "Snippets", icon: SquareCode },
];

type RailItem = {
  key: string;
  label: string;
  icon: typeof Server;
  active: boolean;
  onClick: () => void;
};

export function Sidebar() {
  const mainView = useUiStore((s) => s.mainView);
  const selectSection = useUiStore((s) => s.selectSection);
  const openSettings = useUiStore((s) => s.openSettings);
  const openKeychain = useUiStore((s) => s.openKeychain);

  const items: RailItem[] = [
    { key: "keychain", label: "Keychain", icon: KeyRound, active: mainView === "keychain", onClick: openKeychain },
    ...ITEMS.map((item) => ({
      key: item.section,
      label: item.label,
      icon: item.icon,
      active: mainView === item.section,
      onClick: () => selectSection(item.section),
    })),
    { key: "settings", label: "Settings", icon: Settings, active: mainView === "settings", onClick: openSettings },
  ];
  // Roving tabindex: only the active (or first) rail button is in the Tab order;
  // Arrow/Home/End move focus between them.
  const activeIndex = Math.max(0, items.findIndex((item) => item.active));
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    let next = index;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    btnRefs.current[next]?.focus();
  };

  const lastIndex = items.length - 1;

  return (
    <div className="flex h-full shrink-0">
      <nav
        className="flex w-19 flex-col items-center border-r border-border bg-surface py-3"
        aria-label="Primary"
      >
        <div className="flex w-full flex-col gap-1 px-2">
          {items.slice(0, lastIndex).map((item, index) => (
            <RailButton
              key={item.key}
              item={item}
              tabIndex={index === activeIndex ? 0 : -1}
              buttonRef={(el) => {
                btnRefs.current[index] = el;
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
            />
          ))}
        </div>
        <div className="flex-1" />
        <div className="w-full px-2">
          <RailButton
            item={items[lastIndex]}
            tabIndex={lastIndex === activeIndex ? 0 : -1}
            buttonRef={(el) => {
              btnRefs.current[lastIndex] = el;
            }}
            onKeyDown={(event) => onKeyDown(event, lastIndex)}
          />
        </div>
      </nav>
    </div>
  );
}

function RailButton({
  item,
  tabIndex,
  buttonRef,
  onKeyDown,
}: {
  item: RailItem;
  tabIndex: number;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const { label, active, onClick, icon: Icon } = item;
  return (
    <button
      ref={buttonRef}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      aria-current={active ? "page" : undefined}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        "relative flex h-12 w-full flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] transition-colors",
        active
          ? "bg-raised text-accent shadow-glow"
          : "text-muted hover:bg-raised hover:text-foreground",
      )}
    >
      <Icon size={18} strokeWidth={1.75} />
      <span>{label}</span>
    </button>
  );
}
