import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";

/**
 * Reusable passphrase prompt. Used for setting the sync passphrase, unlocking
 * before a sync, and export/import. The passphrase lives only in this
 * component's transient state and is cleared whenever the dialog closes — it is
 * never lifted into a store, cache, or storage.
 */
export function PassphrasePrompt({
  open,
  onOpenChange,
  title,
  description,
  confirm = false,
  rememberOption = false,
  rememberDefault = false,
  submitLabel = "Continue",
  busy = false,
  error,
  minLength = 8,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirm?: boolean;
  rememberOption?: boolean;
  rememberDefault?: boolean;
  submitLabel?: string;
  busy?: boolean;
  error?: string | null;
  minLength?: number;
  onSubmit: (passphrase: string, remember: boolean) => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmValue, setConfirmValue] = useState("");
  const [remember, setRemember] = useState(rememberDefault);

  // Clear the transient secret whenever the dialog is opened or closed.
  useEffect(() => {
    setPassphrase("");
    setConfirmValue("");
    setRemember(rememberDefault);
  }, [open, rememberDefault]);

  const tooShort = passphrase.length < minLength;
  const mismatch = confirm && passphrase !== confirmValue;
  const canSubmit = !tooShort && !mismatch && !busy;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(passphrase, remember);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
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
            disabled={!canSubmit}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {busy ? "Please wait…" : submitLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-xs text-muted">
          Passphrase
          <input
            autoFocus
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
          />
        </label>
        {confirm && (
          <label className="block text-xs text-muted">
            Confirm passphrase
            <input
              type="password"
              value={confirmValue}
              onChange={(e) => setConfirmValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
            />
          </label>
        )}
        {rememberOption && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="mt-1"
            />
            <span>
              Remember on this device
              <span className="block text-xs text-muted">
                Stores the passphrase in your OS keychain so sync runs without
                prompting.
              </span>
            </span>
          </label>
        )}
        {mismatch && confirmValue.length > 0 && (
          <p className="text-xs text-danger">Passphrases do not match.</p>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
