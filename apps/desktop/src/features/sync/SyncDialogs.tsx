import { useVault } from "../../hooks/useVaults";
import { selectVault, useSyncStore } from "../../stores/syncStore";
import { useUiStore } from "../../stores/uiStore";
import { JoinVaultDialog } from "../vaults/JoinVaultDialog";
import { ConflictDialog } from "./ConflictDialog";
import { PassphrasePrompt } from "./PassphrasePrompt";

/**
 * App-global sync dialogs driven entirely by the sync store, so conflicts and
 * passphrase prompts can be raised from either the settings screen or the
 * title-bar indicator. Mount once near the app root.
 *
 * One dialog pair serves every vault: `activeVaultId` names the one being
 * shown, and its name is in the title so a prompt can never be answered for the
 * wrong vault. The vault-join dialog lives here too — a `luma://vault?…` deep
 * link can arrive whatever screen is open.
 */
export function SyncDialogs() {
  const activeVaultId = useSyncStore((s) => s.activeVaultId);
  const runtime = useSyncStore((s) => selectVault(s, s.activeVaultId));
  const conflictDialogOpen = useSyncStore((s) => s.conflictDialogOpen);
  const passphraseDialogOpen = useSyncStore((s) => s.passphraseDialogOpen);
  const resolve = useSyncStore((s) => s.resolve);
  const closeConflicts = useSyncStore((s) => s.closeConflicts);
  const submitPassphrase = useSyncStore((s) => s.submitPassphrase);
  const closePassphrasePrompt = useSyncStore((s) => s.closePassphrasePrompt);
  const vault = useVault(activeVaultId);
  const vaultJoinOpen = useUiStore((s) => s.vaultJoinOpen);
  const vaultJoinLink = useUiStore((s) => s.vaultJoinLink);
  const closeVaultJoin = useUiStore((s) => s.closeVaultJoin);

  const vaultLabel = vault?.name ?? "this vault";

  return (
    <>
      <ConflictDialog
        open={conflictDialogOpen && activeVaultId != null}
        onOpenChange={(open) => {
          if (!open) closeConflicts();
        }}
        title={`Resolve conflicts in ${vaultLabel}`}
        conflicts={runtime.conflicts}
        busy={runtime.busy}
        error={runtime.errorCategory === "sync-conflict" ? runtime.errorMessage : null}
        onApply={(resolutions) => {
          if (activeVaultId) void resolve(activeVaultId, resolutions);
        }}
      />
      <PassphrasePrompt
        open={passphraseDialogOpen && activeVaultId != null}
        onOpenChange={(open) => {
          if (!open) closePassphrasePrompt();
        }}
        title={`Enter the sync passphrase for ${vaultLabel}`}
        description="This passphrase encrypts and decrypts this vault's data. Every device and every member uses the same one."
        rememberOption
        submitLabel="Unlock and sync"
        busy={runtime.busy}
        error={
          runtime.errorCategory && runtime.errorCategory !== "sync-passphrase-required"
            ? runtime.errorMessage
            : null
        }
        onSubmit={(passphrase, remember) => {
          if (activeVaultId) void submitPassphrase(activeVaultId, passphrase, remember);
        }}
      />
      <JoinVaultDialog
        open={vaultJoinOpen}
        onOpenChange={(open) => {
          if (!open) closeVaultJoin();
        }}
        link={vaultJoinLink}
      />
    </>
  );
}
