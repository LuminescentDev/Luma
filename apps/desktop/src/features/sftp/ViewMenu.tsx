import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowDownUp, Check, ChevronRight, Eye, EyeOff } from "lucide-react";
import {
  SORT_FIELD_LABELS,
  toggleSort,
  type SortField,
  type ViewPrefs,
} from "./viewPrefs";
import { cn } from "../../lib/utils";

/*
 * The sort + hidden-files controls, as dropdown items both browsers embed in
 * their own overflow menu. Kept here rather than duplicated so the two surfaces
 * cannot drift on ordering semantics or labels; the menu shell (trigger,
 * placement, whatever else each surface puts above these) stays with the caller.
 */

const ITEM_CLASS =
  "flex cursor-default items-center gap-2 rounded-md px-2.5 outline-none data-[highlighted]:bg-surface data-[highlighted]:text-accent";

const CONTENT_CLASS =
  "z-50 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow";

/**
 * "Sort by" submenu plus a "Hidden files" toggle.
 *
 * @param compact Desktop sizing (shorter rows). Mobile leaves this off so every
 * row keeps a 44px touch target.
 */
export function ViewMenuItems({
  prefs,
  onChange,
  compact,
}: {
  prefs: ViewPrefs;
  onChange: (next: ViewPrefs) => void;
  compact?: boolean;
}) {
  const rowHeight = compact ? "py-1.5" : "min-h-11";
  const fields = Object.keys(SORT_FIELD_LABELS) as SortField[];
  return (
    <>
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger
          className={cn(ITEM_CLASS, rowHeight, "justify-between")}
        >
          <span className="flex items-center gap-2">
            <ArrowDownUp size={15} />
            <span>
              Sort by
              <span className="ml-1.5 text-xs text-muted">
                {SORT_FIELD_LABELS[prefs.sortField]}
              </span>
            </span>
          </span>
          <ChevronRight size={14} className="text-muted" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent
            sideOffset={4}
            className={cn(CONTENT_CLASS, "min-w-44")}
          >
            {fields.map((field) => {
              const active = prefs.sortField === field;
              return (
                <DropdownMenu.Item
                  key={field}
                  // Selecting the active field flips direction rather than
                  // closing on a no-op, so one menu can both pick and reverse.
                  onSelect={(event) => {
                    if (active) event.preventDefault();
                    onChange(toggleSort(prefs, field));
                  }}
                  className={cn(ITEM_CLASS, rowHeight, "justify-between")}
                >
                  <span className="flex items-center gap-2">
                    <Check
                      size={14}
                      className={active ? "text-accent" : "invisible"}
                    />
                    {SORT_FIELD_LABELS[field]}
                  </span>
                  {active && (
                    <span className="text-xs text-muted">
                      {prefs.sortDirection === "asc" ? "↑" : "↓"}
                    </span>
                  )}
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>

      <DropdownMenu.Item
        onSelect={() => onChange({ ...prefs, showHidden: !prefs.showHidden })}
        className={cn(ITEM_CLASS, rowHeight)}
      >
        {prefs.showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
        Hidden files
        <span className="ml-auto text-xs text-muted">
          {prefs.showHidden ? "Shown" : "Hidden"}
        </span>
      </DropdownMenu.Item>
    </>
  );
}

export const MENU_CONTENT_CLASS = CONTENT_CLASS;
export const MENU_ITEM_CLASS = ITEM_CLASS;
