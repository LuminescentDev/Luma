import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Modal } from "../../components/Modal";
import { parseLumaError } from "../../lib/hosts";
import { useCreateManagedVault, useCreateVault, useUpdateVault } from "../../hooks/useVaults";
import { DEFAULT_LUMA_CLOUD_URL } from "../../lib/sync";
import type { Vault } from "../../lib/vaults";
import { cn } from "../../lib/utils";

/**
 * Create a vault, or rename an existing one. Secret sharing is offered at
 * creation (decision: explicit opt-in, default off) and can be changed later
 * from the vault's own sync settings.
 */
export function VaultDialog({
  open,
  onOpenChange,
  vault,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vault: Vault | null;
}) {
  const create = useCreateVault();
  const createManaged = useCreateManagedVault();
  const update = useUpdateVault();
  const editing = vault !== null;

  const [name, setName] = useState("");
  const [shareSecrets, setShareSecrets] = useState(false);
  const [managed, setManaged] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(vault?.name ?? "");
    setShareSecrets(vault?.shareSecrets ?? false);
    setManaged(false);
    create.reset();
    createManaged.reset();
    update.reset();
    // Re-seeding on open only; the mutations are stable enough to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vault]);

  const trimmed = name.trim();
  const busy = create.isPending || createManaged.isPending || update.isPending;
  const error = create.isError
    ? parseLumaError(create.error).message
    : createManaged.isError
      ? parseLumaError(createManaged.error).message
      : update.isError
        ? parseLumaError(update.error).message
        : null;

  const submit = () => {
    if (!trimmed || busy) return;
    const done = () => onOpenChange(false);
    if (vault) {
      update.mutate(
        { id: vault.id, input: { name: trimmed, shareSecrets: vault.shareSecrets, sortOrder: vault.sortOrder } },
        { onSuccess: done },
      );
    } else if (managed) {
      createManaged.mutate(
        { name: trimmed, cloudUrl: DEFAULT_LUMA_CLOUD_URL, shareSecrets },
        { onSuccess: done },
      );
    } else {
      create.mutate({ name: trimmed, shareSecrets, sortOrder: 0 }, { onSuccess: done });
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Rename vault" : "New vault"}
      description={
        editing
          ? undefined
          : "A vault is a separate set of hosts, groups, keys, identities and snippets with its own remote and passphrase."
      }
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
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {busy ? "Saving…" : editing ? "Save name" : "Create vault"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block text-xs font-medium text-muted">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Infra"
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted/60 focus:border-accent"
          />
        </label>

        {!editing && (
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted">Sharing</legend>
            <label className="flex items-start gap-2.5">
              <input
                type="radio"
                name="vault-sharing"
                checked={!managed}
                onChange={() => setManaged(false)}
                className="mt-0.5"
              />
              <span className="text-sm">
                Passphrase
                <span className="mt-0.5 block text-xs text-muted">
                  Works with any remote. Members need the location and a passphrase
                  you pass on yourself.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5">
              <input
                type="radio"
                name="vault-sharing"
                checked={managed}
                onChange={() => setManaged(true)}
                className="mt-0.5"
              />
              <span className="text-sm">
                Luma Cloud
                <span className="mt-0.5 block text-xs text-muted">
                  Invite by link, no passphrase to pass on, and members can be
                  removed. Requires a signed-in Luma account.
                </span>
              </span>
            </label>
          </fieldset>
        )}

        {!editing && (
          <div className="space-y-2">
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={shareSecrets}
                onChange={(e) => setShareSecrets(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm">
                Share private keys and passwords
                <span className="mt-0.5 block text-xs text-muted">
                  Off by default. You can change this later.
                </span>
              </span>
            </label>
            {shareSecrets && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2",
                  "text-xs text-amber-400",
                )}
              >
                <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                Every member of this vault gets its private keys and passwords,
                permanently. Removing someone later does not take back what they
                already have. Only share with people you trust.
              </div>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
