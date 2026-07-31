import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Fingerprint, KeyRound, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import {
  createKeyReference,
  listSshAgentIdentities,
  parseLumaError,
  type SshAgentIdentity,
} from "../../lib/hosts";
import { PERSONAL_VAULT_ID } from "../../lib/vaults";

export function AgentKeyDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [keys, setKeys] = useState<SshAgentIdentity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setError(null);
    listSshAgentIdentities()
      .then(setKeys)
      .catch((value) => setError(parseLumaError(value).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const importKey = (key: SshAgentIdentity) => {
    setImporting(key.fingerprint);
    setError(null);
    const name = key.comment.trim() || `${key.algorithm} ${key.fingerprint.slice(-12)}`;
    createKeyReference({
      vaultId: PERSONAL_VAULT_ID,
      name,
      publicKey: key.publicKey,
      storageMode: "ssh-agent",
      localPath: null,
      fingerprint: key.fingerprint,
      certificate: null,
      privateKey: null,
      passphrase: null,
    })
      .then(() => {
        onImported();
        onOpenChange(false);
      })
      .catch((value) => setError(parseLumaError(value).message))
      .finally(() => setImporting(null));
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(92vw,38rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface shadow-glow focus:outline-none"
        >
          <header className="flex items-start gap-3 border-b border-border px-5 py-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <ShieldCheck size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold">
                Import from SSH agent
              </Dialog.Title>
              <p className="mt-0.5 text-xs text-muted">
                Luma stores only the public key. Your agent or security key signs
                requests and controls touch or biometric confirmation.
              </p>
            </div>
            <Dialog.Close className="rounded p-1 text-muted hover:bg-raised hover:text-foreground">
              <X size={16} />
            </Dialog.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-raised px-3 py-2 text-[11px] text-muted">
              <span>
                Agent keys are device-bound and stay in the Personal vault.
              </span>
              <button
                type="button"
                onClick={refresh}
                disabled={loading}
                className="flex shrink-0 items-center gap-1 text-accent disabled:opacity-50"
              >
                <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
                Refresh
              </button>
            </div>

            {error && (
              <div role="alert" className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {error}
              </div>
            )}
            {loading && keys.length === 0 ? (
              <div className="flex min-h-36 items-center justify-center text-muted">
                <Loader2 size={19} className="animate-spin" />
              </div>
            ) : keys.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center">
                <KeyRound size={22} className="mx-auto text-muted" />
                <p className="mt-2 text-sm font-medium">No agent keys available</p>
                <p className="mt-1 text-xs text-muted">
                  Start an OpenSSH-compatible agent and load a key, then refresh.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {keys.map((key) => (
                  <div key={key.fingerprint} className="flex items-center gap-3 rounded-lg bg-raised px-3 py-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
                      {key.hardwareBacked ? <ShieldCheck size={17} /> : <KeyRound size={17} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold">
                          {key.comment || key.algorithm}
                        </span>
                        {key.hardwareBacked && (
                          <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[9px] font-medium text-green-400">
                            Hardware-backed
                          </span>
                        )}
                      </div>
                      <span className="mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] text-muted">
                        <Fingerprint size={10} /> {key.fingerprint}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => importKey(key)}
                      disabled={importing !== null}
                      className="rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-foreground disabled:opacity-50"
                    >
                      {importing === key.fingerprint ? "Importing…" : "Import"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

