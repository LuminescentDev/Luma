import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/*
 * Shared form primitives for the mobile settings screens. Extracted from the
 * old single-scroll MobileSettingsScreen when it was split into a Profile hub
 * plus pushed detail screens, so every settings screen keeps the same card,
 * label and switch treatment.
 */

/** Titled card grouping related fields. */
export function Section({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-6 first:mt-3">
      {title && (
        <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
          {title}
        </h2>
      )}
      <div className="space-y-5 rounded-xl border border-border bg-surface p-4">
        {children}
      </div>
    </section>
  );
}

/** Labelled field with an optional explanatory hint. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
      </div>
      {hint && <p className="mb-2 text-xs text-muted">{hint}</p>}
      {children}
    </div>
  );
}

/** iOS-style switch. `label` is the accessible name, since the visible label
 * lives in the surrounding Field. */
export function Toggle({
  checked,
  onClick,
  label,
}: {
  checked: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        checked ? "bg-accent" : "bg-surface",
      )}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 rounded-full bg-foreground shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
