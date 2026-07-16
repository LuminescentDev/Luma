import { useId } from "react";
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
  hint?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted">
          {label}
          {required && <span className="text-danger"> *</span>}
        </span>
        {hint && <span className="text-[11px] text-muted/80">{hint}</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={cn(
          "w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted/60 focus:border-accent",
          error ? "border-danger" : "border-border",
          mono && "font-mono",
        )}
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
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
  hint?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted">
          {label}
          {required && <span className="text-danger"> *</span>}
        </span>
        {hint && <span className="text-[11px] text-muted/80">{hint}</span>}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cn(
          "w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted/60 focus:border-accent",
          error ? "border-danger" : "border-border",
          mono && "font-mono",
        )}
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  error?: string;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        className={cn(
          "w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent",
          error ? "border-danger" : "border-border",
        )}
      >
        {children}
      </select>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
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
