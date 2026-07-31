import { useId } from "react";
import { Ban, Plus, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";

/*
 * Small labelled form controls shared by the host feature dialogs. Every
 * control is associated with its label via htmlFor/id for accessibility, and
 * surfaces an inline error message when provided.
 */

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  mono,
  error,
  required,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
  error?: string;
  required?: boolean;
  hint?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted">
          {label}
          {required && <span className="text-danger"> *</span>}
        </span>
        {hint}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(
          "w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted/60 focus:border-accent",
          error ? "border-danger" : "border-border",
          mono && "font-mono",
        )}
      />
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
  mono,
  error,
  required,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  error?: string;
  required?: boolean;
  hint?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted">
          {label}
          {required && <span className="text-danger"> *</span>}
        </span>
        {hint}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(
          "w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted/60 focus:border-accent",
          error ? "border-danger" : "border-border",
          mono && "font-mono",
        )}
      />
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  children,
  error,
  required,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  error?: string;
  required?: boolean;
  hint?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted">
          {label}
          {required && <span className="text-danger"> *</span>}
        </span>
        {hint}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(
          "w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent",
          error ? "border-danger" : "border-border",
        )}
      >
        {children}
      </select>
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** A small set of accent presets for the tab color swatch row. */
const TAB_COLOR_PRESETS = [
  "#4cc9f0",
  "#60a5fa",
  "#4ade80",
  "#facc15",
  "#fb923c",
  "#f87171",
  "#c084fc",
  "#f472b6",
];

/** Tab accent picker: a "none" option plus preset swatches. The chosen color is
 * stored as "#RRGGBB" (or "" for none) and drives the colored tab. */
export function TabColorField({
  value,
  onChange,
  label = "Tab color",
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="block text-xs font-medium text-muted">{label}</span>
        {hint}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="No tab color"
          aria-pressed={value === ""}
          title="None"
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full border text-muted",
            value === "" ? "border-accent ring-1 ring-accent" : "border-border",
          )}
        >
          <Ban size={13} />
        </button>
        {TAB_COLOR_PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            aria-label={`Tab color ${color}`}
            aria-pressed={value.toLowerCase() === color.toLowerCase()}
            title={color}
            style={{ backgroundColor: color }}
            className={cn(
              "h-6 w-6 rounded-full border transition-transform hover:scale-110",
              value.toLowerCase() === color.toLowerCase()
                ? "border-foreground ring-2 ring-foreground/40"
                : "border-transparent",
            )}
          />
        ))}
      </div>
    </div>
  );
}

export type EnvRow = { key: string; value: string };

export function EnvironmentEditor({
  rows,
  onChange,
  label = "Environment variables (optional)",
  emptyLabel = "No variables set.",
  hint,
}: {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
  label?: string;
  emptyLabel?: string;
  hint?: React.ReactNode;
}) {
  const update = (index: number, partial: Partial<EnvRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...partial } : row)));

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        <div className="flex items-center gap-2">
          {hint}
          <button
            type="button"
            onClick={() => onChange([...rows, { key: "", value: "" }])}
            className="flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <Plus size={11} /> Add
          </button>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted/70">{emptyLabel}</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                aria-label={`Variable ${index + 1} name`}
                value={row.key}
                onChange={(e) => update(index, { key: e.target.value })}
                placeholder="KEY"
                className="w-2/5 rounded-md border border-border bg-background px-2 py-1 font-mono text-sm outline-none focus:border-accent"
              />
              <input
                aria-label={`Variable ${index + 1} value`}
                value={row.value}
                onChange={(e) => update(index, { value: e.target.value })}
                placeholder="value"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-sm outline-none focus:border-accent"
              />
              <button
                type="button"
                aria-label={`Remove variable ${index + 1}`}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
                className="shrink-0 rounded p-1 text-muted hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-border accent-accent"
      />
      <span>{label}</span>
    </label>
  );
}
