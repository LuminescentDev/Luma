import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";

/*
 * A tiny single-field dialog reused for "New folder" and "Rename". Built on the
 * shared Modal so it inherits focus trapping, Escape, and labelled dialog aria.
 */
export function NameDialog({
  open,
  onOpenChange,
  title,
  label,
  initialValue = "",
  confirmLabel = "Save",
  busy = false,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const trimmed = value.trim();
  const submit = () => {
    if (!trimmed || busy) return;
    onSubmit(trimmed);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!trimmed || busy}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110 disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <label className="block text-xs font-medium text-muted">
        {label}
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          className="mt-1.5 h-10 w-full rounded-lg border border-border bg-raised px-3 text-sm text-foreground outline-none focus:border-accent"
        />
      </label>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </Modal>
  );
}
