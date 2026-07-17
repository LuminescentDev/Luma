import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { Modal } from "../../components/Modal";
import {
  createKeyReference,
  deleteKeyReference,
  parseLumaError,
  updateKeyReference,
  generateSshKey,
  type KeyReference,
  type KeyReferenceInput,
  type KeyStorageMode,
} from "../../lib/hosts";
import { useKeyReferences, useInvalidateHosts } from "../../hooks/useHosts";
import { SelectField, TextField } from "./fields";

type Draft = {
  id: string | null;
  name: string;
  storageMode: KeyStorageMode;
  localPath: string;
  publicKey: string;
  fingerprint: string;
  certificate: string;
  passphrase: string;
};

function emptyDraft(): Draft {
  return {
    id: null,
    name: "",
    storageMode: "local-path",
    localPath: "",
    publicKey: "",
    fingerprint: "",
    certificate: "",
    passphrase: "",
  };
}

function draftFrom(key: KeyReference): Draft {
  return {
    id: key.id,
    name: key.name,
    storageMode: key.storageMode,
    localPath: key.localPath ?? "",
    publicKey: key.publicKey ?? "",
    fingerprint: key.fingerprint ?? "",
    certificate: key.certificate ?? "",
    passphrase: "",
  };
}

export function KeyReferencesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: keys } = useKeyReferences();
  const invalidate = useInvalidateHosts();
  const [draft, setDraft] = useState<Draft | null>(null);

  const save = useMutation({
    mutationFn: (input: { id: string | null; data: KeyReferenceInput }) =>
      input.id ? updateKeyReference(input.id, input.data) : createKeyReference(input.data),
    onSuccess: () => {
      invalidate();
      setDraft(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteKeyReference(id),
    onSuccess: invalidate,
  });
  const generate = useMutation({ mutationFn: ({ name, path, passphrase, certificate }: { name: string; path: string; passphrase: string; certificate: string | null }) => generateSshKey(name, path, passphrase, certificate), onSuccess: () => { invalidate(); setDraft(null); } });

  const nameMissing = draft ? !draft.name.trim() : false;
  const pathMissing = draft
    ? draft.storageMode === "local-path" && !draft.localPath.trim()
    : false;
  const canSave = draft ? !nameMissing && !pathMissing : false;

  const submit = () => {
    if (!draft || !canSave) return;
    save.mutate({
      id: draft.id,
      data: {
        name: draft.name.trim(),
        storageMode: draft.storageMode,
        localPath:
          draft.storageMode === "local-path" ? draft.localPath.trim() || null : null,
        publicKey: draft.publicKey.trim() || null,
        fingerprint: draft.fingerprint.trim() || null,
        certificate: draft.certificate.trim() || null,
        passphrase: draft.passphrase || undefined,
      },
    });
  };

  const backendError = save.isError ? parseLumaError(save.error) : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Key references"
      description="Logical SSH keys. Luma never stores private key contents — only a name and path or agent reference."
      size="lg"
    >
      <div className="space-y-3">
        {(keys ?? []).length === 0 && !draft && (
          <p className="text-sm text-muted">
            No key references yet. Add one to point a host at a private key on
            disk or your SSH agent.
          </p>
        )}

        {(keys ?? []).map((key) => (
          <div
            key={key.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-2">
              <KeyRound size={15} className="shrink-0 text-muted" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{key.name}</p>
                <p className="truncate font-mono text-xs text-muted">
                  {key.storageMode === "ssh-agent"
                    ? "SSH agent"
                    : (key.localPath ?? "(no path)")}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                aria-label={`Edit key ${key.name}`}
                onClick={() => setDraft(draftFrom(key))}
                className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-foreground"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                aria-label={`Delete key ${key.name}`}
                onClick={() => remove.mutate(key.id)}
                className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}

        {draft ? (
          <div className="space-y-3 rounded-lg border border-border bg-background p-3">
            <TextField
              label="Label"
              required
              value={draft.name}
              onChange={(v) => setDraft({ ...draft, name: v })}
              placeholder="personal-ed25519"
              error={nameMissing ? "Name is required." : undefined}
            />
            <SelectField
              label="Storage"
              value={draft.storageMode}
              onChange={(v) => setDraft({ ...draft, storageMode: v as KeyStorageMode })}
            >
              <option value="local-path">Local file path</option>
              <option value="ssh-agent">SSH agent</option>
            </SelectField>
            {draft.storageMode === "local-path" && (
              <TextField
                label="Private key file"
                required
                mono
                value={draft.localPath}
                onChange={(v) => setDraft({ ...draft, localPath: v })}
                placeholder="~/.ssh/id_ed25519"
                error={pathMissing ? "A local path is required." : undefined}
              />
            )}
            <TextField
              label="Public key (optional)"
              mono
              value={draft.publicKey}
              onChange={(v) => setDraft({ ...draft, publicKey: v })}
              placeholder="ssh-ed25519 AAAA…"
            />
            <TextField label={draft.id ? "Passphrase (leave blank to keep current)" : "Passphrase (saved in encrypted vault)"} type="password" value={draft.passphrase} onChange={(passphrase) => setDraft({ ...draft, passphrase })} />
            <TextField label="Certificate (optional)" mono value={draft.certificate} onChange={(certificate) => setDraft({ ...draft, certificate })} placeholder="ssh-ed25519-cert-v01@openssh.com …" />
            <TextField
              label="Fingerprint (optional)"
              mono
              value={draft.fingerprint}
              onChange={(v) => setDraft({ ...draft, fingerprint: v })}
              placeholder="SHA256:…"
            />
            {backendError && (
              <p className="text-xs text-danger">{backendError.message}</p>
            )}
            {generate.isError && <p className="text-xs text-danger">{parseLumaError(generate.error).message}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={submit}
                disabled={!canSave || save.isPending}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
              >
                {draft.id ? "Save key" : "Add key"}
              </button>
              {!draft.id && draft.storageMode === "local-path" && <button type="button" onClick={() => generate.mutate({ name: draft.name.trim(), path: draft.localPath.trim(), passphrase: draft.passphrase, certificate: draft.certificate.trim() || null })} disabled={!canSave || generate.isPending} className="rounded-md border border-accent px-3 py-1.5 text-sm text-accent disabled:opacity-50">Generate Ed25519 key pair</button>}
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setDraft(emptyDraft())}
            className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted hover:border-accent hover:text-accent"
          >
            <Plus size={14} /> Add key reference
          </button>
        )}
      </div>
    </Modal>
  );
}
