import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/*
 * Standard chrome for every screen in the mobile shell: safe-area aware header
 * with an optional back button and trailing action, then a scrolling body that
 * reserves room for the floating tab bar (.pb-tabbar).
 *
 * Hub screens (Vaults, Connections, Profile) use the large iOS-style title and
 * no back button; pushed detail screens use the compact title with one. Screens
 * that own their own scrolling (SFTP, the hosts panel) pass `scroll={false}` and
 * take the remaining flex space themselves.
 */
export function MobileScreen({
  title,
  onBack,
  action,
  leading,
  large = false,
  scroll = true,
  padded = true,
  inSheet = false,
  children,
}: {
  /** Omit for screens that render their own heading (the shared desktop
   * screens do), leaving just a slim back bar so the title is not duplicated. */
  title?: string;
  /** Renders a back chevron when provided. Omit on hub screens. */
  onBack?: () => void;
  /** Trailing header control (add button, menu). */
  action?: ReactNode;
  /** Replaces the back chevron with a custom leading control (the host editor's
   * dismiss button). Takes precedence over `onBack`. */
  leading?: ReactNode;
  /** iOS-style large title, for tab hubs. */
  large?: boolean;
  /** Let this component own vertical scrolling. False when the body scrolls itself. */
  scroll?: boolean;
  /** Horizontal padding on the body. False for edge-to-edge lists. */
  padded?: boolean;
  /** Inside a full-screen sheet, which hides the tab bar — so the body only
   * reserves the home indicator instead of a bar that is not there. */
  inSheet?: boolean;
  children: ReactNode;
}) {
  const lead =
    leading ??
    (onBack ? (
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-accent active:bg-raised"
      >
        <ChevronLeft size={26} strokeWidth={2.25} />
      </button>
    ) : null);

  return (
    <div className="flex h-full flex-col bg-background">
      <header
        className={cn(
          "shrink-0 px-4 pt-safe",
          large ? "pb-2 pt-2" : title ? "border-b border-border/60 pb-3" : "pb-0",
        )}
      >
        <div className={cn("flex items-center gap-1", title ? "min-h-11" : "min-h-0")}>
          {lead}
          {title ? (
            <h1
              className={cn(
                "min-w-0 flex-1 truncate font-semibold",
                large ? "text-[34px] leading-tight tracking-tight" : "text-[17px]",
                // A compact title centers between the back button and the action,
                // the way a UINavigationBar does; a large title stays leading.
                !large && "text-center",
              )}
            >
              {title}
            </h1>
          ) : (
            <span className="flex-1" />
          )}
          {/* Balances the centered compact title when only one side is filled. */}
          {title && !large && !action && lead && <span className="h-11 w-11 shrink-0" />}
          {action && <div className="shrink-0">{action}</div>}
          {title && !large && action && !lead && <span className="h-11 w-11 shrink-0" />}
        </div>
      </header>
      {/* The bottom inset applies either way: when this element scrolls, it pads
          the content so the last row clears the floating bar; when the child owns
          scrolling, it shrinks this box so the child's scroller ends above it. */}
      <div
        className={cn(
          "min-h-0 flex-1",
          inSheet ? "pb-sheet" : "pb-tabbar",
          scroll && "overflow-y-auto",
          padded && "px-4",
          scroll && large && "pt-2",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Grouped inset list container, the iOS Settings visual. Rows are separated by
 * hairlines and the group is a single rounded card. */
export function MobileList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ul
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-surface",
        "divide-y divide-border/70",
        className,
      )}
    >
      {children}
    </ul>
  );
}

/** A navigation row inside a MobileList: icon, label, optional trailing count,
 * disclosure chevron. The whole row is one >=44px touch target. */
export function MobileRow({
  icon: Icon,
  label,
  detail,
  count,
  onSelect,
  iconClassName,
}: {
  icon: LucideIcon;
  label: string;
  /** Secondary line under the label. */
  detail?: string;
  /** Trailing count badge; hidden when undefined (not when 0 — pass undefined). */
  count?: number;
  onSelect: () => void;
  /** Tint for the leading icon; defaults to the foreground monochrome look. */
  iconClassName?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-raised"
      >
        <Icon
          size={22}
          strokeWidth={1.75}
          className={cn("shrink-0 text-foreground", iconClassName)}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[17px] leading-tight">{label}</span>
          {detail && (
            <span className="mt-0.5 block truncate text-xs text-muted">{detail}</span>
          )}
        </span>
        {count !== undefined && (
          <span className="shrink-0 text-sm tabular-nums text-muted">{count}</span>
        )}
        <ChevronRight size={18} className="shrink-0 text-muted" />
      </button>
    </li>
  );
}
