import { Check, ChevronRight, type LucideIcon } from "lucide-react";
import type { HTMLInputTypeAttribute, ReactNode } from "react";
import { cn } from "../../lib/utils";

/*
 * Shared form primitives for the mobile screens. The first group (Section /
 * Field / Toggle) is the settings-screen treatment, extracted from the old
 * single-scroll MobileSettingsScreen when it was split into a Profile hub plus
 * pushed detail screens.
 *
 * The second group (GroupTitle / RowGroup / InputRow / NavRow / SwitchRow /
 * ChoiceRow) is the denser iOS grouped-table treatment used by the mobile host
 * editor: one concern per hairline-separated row inside a rounded inset card.
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

/* ------------------------------------------------------------------ *
 * Grouped inset rows
 * ------------------------------------------------------------------ */

/** Uppercase caption above a card, naming the group of settings under it. */
export function GroupTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 mt-7 px-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted first:mt-0">
      {children}
    </h2>
  );
}

/** A rounded inset card of hairline-separated rows. `title` renders as a bold
 * heading inside the card, for a group that names itself rather than sitting
 * under a caption. */
export function RowGroup({
  title,
  footer,
  className,
  children,
}: {
  title?: string;
  /** Explanatory text under the card, in the iOS grouped-table position. */
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mt-3 first:mt-0", className)}>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        {title && (
          <h3 className="px-4 pb-1 pt-3.5 text-[19px] font-semibold">{title}</h3>
        )}
        <div className="divide-y divide-border/70">{children}</div>
      </div>
      {footer && <p className="mt-2 px-4 text-xs leading-relaxed text-muted">{footer}</p>}
    </div>
  );
}

/**
 * A text row. The field name is the placeholder while the row is empty — the
 * compact treatment the design copies — and demotes to a caption above the
 * value once there is one, so a filled form still says what each value is.
 */
export function InputRow({
  label,
  value,
  onChange,
  hint,
  error,
  type = "text",
  mono = false,
  inputMode,
  trailing,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Muted trailing text: "Required", a unit, or the default that applies. */
  hint?: string;
  error?: string;
  type?: HTMLInputTypeAttribute;
  mono?: boolean;
  inputMode?: "text" | "numeric" | "url" | "email";
  trailing?: ReactNode;
}) {
  const filled = value.length > 0;
  return (
    <div className="px-4 py-2">
      <div className="flex min-h-11 items-center gap-3">
        <label className="min-w-0 flex-1">
          {filled && (
            <span className="block text-[11px] leading-tight text-muted">{label}</span>
          )}
          <input
            type={type}
            inputMode={inputMode}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-label={label}
            placeholder={label}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={cn(
              "w-full bg-transparent text-[17px] outline-none placeholder:text-foreground/85",
              // Only the value is monospaced — the field name doubling as the
              // placeholder should read in the UI face like every other label.
              mono && filled && "font-mono text-[15px]",
            )}
          />
        </label>
        {hint && <span className="shrink-0 text-[15px] text-muted">{hint}</span>}
        {trailing}
      </div>
      {error && <p className="pb-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** A disclosure row: name on the left, current selection on the right, pushes a
 * picker screen. */
export function NavRow({
  label,
  value,
  placeholder,
  icon: Icon,
  onSelect,
  error,
}: {
  label: string;
  /** Current selection, shown muted next to the chevron. */
  value?: string | null;
  /** Shown in place of an empty value. */
  placeholder?: string;
  icon?: LucideIcon;
  onSelect: () => void;
  error?: string;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onSelect}
        className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left active:bg-raised"
      >
        {Icon && <Icon size={20} strokeWidth={1.75} className="shrink-0 text-muted" />}
        <span className="min-w-0 shrink-0 text-[17px]">{label}</span>
        <span className="min-w-0 flex-1 truncate text-right text-[15px] text-muted">
          {value || placeholder}
        </span>
        <ChevronRight size={18} className="shrink-0 text-accent" />
      </button>
      {error && <p className="px-4 pb-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** A row whose only control is a switch. */
export function SwitchRow({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] leading-tight">{label}</span>
        {detail && <span className="mt-0.5 block text-xs text-muted">{detail}</span>}
      </span>
      <Toggle checked={checked} label={label} onClick={() => onChange(!checked)} />
    </div>
  );
}

/** A row in a picker screen: one option, checked when it is the current one. */
export function ChoiceRow({
  label,
  detail,
  selected,
  onSelect,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left active:bg-raised"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[17px] leading-tight">{label}</span>
        {detail && <span className="mt-0.5 block truncate text-xs text-muted">{detail}</span>}
      </span>
      <Check
        size={20}
        strokeWidth={2.5}
        className={cn("shrink-0 text-accent", !selected && "invisible")}
      />
    </button>
  );
}
