import * as RadixContextMenu from "@radix-ui/react-context-menu";
import { cn } from "../lib/utils";

/**
 * A single entry in a context (right-click) menu, or a separator. The same
 * shape is reused to drive the app's existing 3-dot dropdown menus so a
 * right-click menu and its dropdown counterpart never drift apart.
 */
export type MenuAction =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      icon?: React.ReactNode;
      /** Right-aligned keyboard-shortcut hint (e.g. "Ctrl+Shift+C"). */
      hint?: string;
      destructive?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    };

/**
 * Shared right-click menu. Wraps a single trigger element (`children`) and
 * renders `actions` at the cursor using the exact styling of the app's Radix
 * dropdown menus. The native browser context menu is suppressed only on the
 * wrapped element, so inputs/textareas keep their native menus.
 */
export function ContextMenu({
  actions,
  children,
  minWidth = "min-w-40",
  onOpenChange,
  disabled,
}: {
  actions: MenuAction[];
  children: React.ReactNode;
  /** Tailwind min-width utility for the panel; defaults to `min-w-40`. */
  minWidth?: string;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <RadixContextMenu.Root onOpenChange={onOpenChange}>
      <RadixContextMenu.Trigger asChild disabled={disabled}>
        {children}
      </RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content
          className={cn(
            "z-50 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow",
            minWidth,
          )}
        >
          {actions.map((action, index) =>
            "separator" in action && action.separator ? (
              <RadixContextMenu.Separator
                key={`sep-${index}`}
                className="my-1 h-px bg-border"
              />
            ) : (
              <RadixContextMenu.Item
                key={action.label}
                disabled={action.disabled}
                onSelect={action.onSelect}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
                  action.destructive
                    ? "text-danger data-[highlighted]:text-danger"
                    : "data-[highlighted]:text-accent",
                )}
              >
                {action.icon && <span className="shrink-0">{action.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                {action.hint && (
                  <span className="shrink-0 text-xs text-muted">{action.hint}</span>
                )}
              </RadixContextMenu.Item>
            ),
          )}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}
