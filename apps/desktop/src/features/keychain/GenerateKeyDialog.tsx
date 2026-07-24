import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Fingerprint, KeyRound, Loader2 } from "lucide-react";
import { Modal } from "../../components/Modal";
import {
  generateVaultSshKey,
  parseLumaError,
  type GeneratedKeyType,
  type KeyReference,
} from "../../lib/hosts";
import { useInvalidateHosts } from "../../hooks/useHosts";
import {
  emptyGenerateKeyDraft,
  validateGenerateKey,
  type GenerateKeyDraft,
} from "./keygen";

const KEY_TYPES: { value: GeneratedKeyType; label: string; hint: string }[] = [
  { value: "ed25519", label: "Ed25519", hint: "Recommended" },
  { value: "rsa4096", label: "RSA 4096", hint: "Maximum compatibility" },
];

/*
 * Generate a new SSH key pair into the encrypted vault (ssh_key_generate). The
 * whole keychain screen is already gated on an unlocked vault (VaultGate), so
 * generation inherits that gate. On success the derived public key + fingerprint
 * are shown for copying; the key list is invalidated so it appears immediately.
 */
export function GenerateKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateHosts();
  const [draft, setDraft] = useState<GenerateKeyDraft>(emptyGenerateKeyDraft);
  const [result, setResult] = useState<KeyReference | null>(null);

  const generate = useMutation({
    mutationFn: (value: GenerateKeyDraft) =>
      generateVaultSshKey({
        keyType: value.keyType,
        name: value.name.trim(),
        passphrase: value.passphrase || null,
        comment: value.comment.trim() || null,
      }),
    onSuccess: (key) => {
      invalidate();
      setResult(key);
    },
  });

  const reset = () => {
    setDraft(emptyGenerateKeyDraft());
    setResult(null);
    generate.reset();
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const validation = validateGenerateKey(draft);
  const backendError = generate.isError ? parseLumaError(generate.error).message : null;
  // Only surface a validation message once the user has started typing a name.
  const validationError =
    !validation.ok && draft.name.length > 0 ? validation.error : null;

  const submit = () => {
    if (!validation.ok) return;
    generate.mutate(draft);
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="Generate SSH key"
      description="Creates a new key pair stored in your encrypted vault."
      size="md"
      footer={
        result ? (
          <button
            type="button"
            onClick={() => close(false)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
          >
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => close(false)}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!validation.ok || generate.isPending}
              className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              {generate.isPending && <Loader2 size={14} className="animate-spin" />}
              {generate.isPending ? "Generating…" : "Generate key"}
            </button>
          </>
        )
      }
    >
      {result ? (
        <GeneratedKeyResult keyRef={result} />
      ) : (
        <div className="space-y-4">
          <label className="block text-xs text-muted">
            Name
            <input
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="personal-ed25519"
              aria-label="Key name"
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
            />
          </label>

          <div className="block text-xs text-muted">
            Type
            <div className="mt-1 grid grid-cols-2 gap-2">
              {KEY_TYPES.map((type) => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => setDraft({ ...draft, keyType: type.value })}
                  aria-pressed={draft.keyType === type.value}
                  className={
                    draft.keyType === type.value
                      ? "rounded-lg border border-accent bg-accent/10 px-3 py-2 text-left"
                      : "rounded-lg border border-border bg-background px-3 py-2 text-left hover:border-accent/50"
                  }
                >
                  <span className="block text-sm font-medium text-foreground">
                    {type.label}
                  </span>
                  <span className="block text-[11px] text-muted">{type.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <label className="block text-xs text-muted">
            Passphrase (optional)
            <input
              type="password"
              value={draft.passphrase}
              onChange={(e) => setDraft({ ...draft, passphrase: e.target.value })}
              aria-label="Passphrase"
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
            />
          </label>
          {draft.passphrase && (
            <label className="block text-xs text-muted">
              Confirm passphrase
              <input
                type="password"
                value={draft.confirmPassphrase}
                onChange={(e) =>
                  setDraft({ ...draft, confirmPassphrase: e.target.value })
                }
                aria-label="Confirm passphrase"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
              />
            </label>
          )}

          <label className="block text-xs text-muted">
            Comment (optional)
            <input
              value={draft.comment}
              onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
              placeholder="me@laptop"
              aria-label="Comment"
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
            />
          </label>

          {validationError && <p className="text-xs text-danger">{validationError}</p>}
          {backendError && (
            <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {backendError}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function GeneratedKeyResult({ keyRef }: { keyRef: KeyReference }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!keyRef.publicKey) return;
    void navigator.clipboard.writeText(keyRef.publicKey).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-foreground">
        <KeyRound size={15} className="shrink-0 text-accent" />
        <span className="min-w-0 truncate">
          <span className="font-medium">{keyRef.name}</span> generated and stored in
          your vault.
        </span>
      </div>
      {keyRef.fingerprint && (
        <div className="rounded-lg border border-border bg-background px-3 py-2">
          <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted">
            <Fingerprint size={12} /> Fingerprint
          </span>
          <span className="mt-0.5 block select-all break-all font-mono text-xs text-foreground">
            {keyRef.fingerprint}
          </span>
        </div>
      )}
      {keyRef.publicKey && (
        <div>
          <span className="text-xs text-muted">Public key</span>
          <span className="relative mt-1 block">
            <textarea
              readOnly
              aria-label="Generated public key (authorized_keys line)"
              value={keyRef.publicKey}
              rows={4}
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 pr-10 font-mono text-xs text-foreground outline-none"
            />
            <button
              type="button"
              aria-label="Copy public key"
              onClick={copy}
              className="absolute right-2 top-2 rounded p-1 text-muted hover:bg-raised hover:text-foreground"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
