import { useSyncStore } from "../../stores/syncStore";
import { ConflictDialog } from "./ConflictDialog";
import { PassphrasePrompt } from "./PassphrasePrompt";

/**
 * App-global sync dialogs driven entirely by the sync store, so conflicts and
 * passphrase prompts can be raised from either the settings screen or the
 * title-bar indicator. Mount once near the app root.
 */
export function SyncDialogs() {
  const conflicts = useSyncStore((s) => s.conflicts);
  const conflictDialogOpen = useSyncStore((s) => s.conflictDialogOpen);
  const passphraseDialogOpen = useSyncStore((s) => s.passphraseDialogOpen);
  const busy = useSyncStore((s) => s.busy);
  const errorMessage = useSyncStore((s) => s.errorMessage);
  const errorCategory = useSyncStore((s) => s.errorCategory);
  const resolve = useSyncStore((s) => s.resolve);
  const closeConflicts = useSyncStore((s) => s.closeConflicts);
  const submitPassphrase = useSyncStore((s) => s.submitPassphrase);
  const closePassphrasePrompt = useSyncStore((s) => s.closePassphrasePrompt);

  return (
    <>
      <ConflictDialog
        open={conflictDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeConflicts();
        }}
        conflicts={conflicts}
        busy={busy}
        error={errorCategory === "sync-conflict" ? errorMessage : null}
        onApply={(resolutions) => void resolve(resolutions)}
      />
      <PassphrasePrompt
        open={passphraseDialogOpen}
        onOpenChange={(open) => {
          if (!open) closePassphrasePrompt();
        }}
        title="Enter sync passphrase"
        description="Your sync passphrase is required to encrypt and decrypt this device's data."
        rememberOption
        submitLabel="Unlock and sync"
        busy={busy}
        error={errorCategory && errorCategory !== "vault-locked" ? errorMessage : null}
        onSubmit={(passphrase, remember) => void submitPassphrase(passphrase, remember)}
      />
    </>
  );
}
