import { useState } from "react";
import {
  Cloud,
  CloudOff,
  Pencil,
  Plus,
  Share2,
  ShieldAlert,
  Trash2,
  Vault as VaultIcon,
} from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { parseLumaError } from "../../lib/hosts";
import type { SyncConfig } from "../../lib/sync";
import {
  buildVaultJoinLink,
  createVaultInvite,
  PERSONAL_VAULT_ID,
  type Vault,
} from "../../lib/vaults";
import { useDeleteVault, useVaults } from "../../hooks/useVaults";
import { useSyncConfigs } from "../../hooks/useSync";
import { useHostGroups, useHosts, useIdentities, useKeyReferences } from "../../hooks/useHosts";
import { useSnippets } from "../../hooks/useSnippets";
import { SyncSection } from "../sync/SyncSection";
import { BackupSection } from "../sync/BackupSection";
import { VaultDialog } from "./VaultDialog";
import { useUiStore } from "../../stores/uiStore";
import { useCapabilityStore } from "../../stores/capabilityStore";
import { cn } from "../../lib/utils";

/**
 * Vault management: the list of vaults, and the sync + backup configuration of
 * whichever one is selected. Each vault has its own remote and passphrase, so
 * sync lives here rather than under Account — Account has the single Luma
 * identity, this has the many scopes it can carry.
 */
export function VaultsSection() {
  const { data: vaults, isLoading } = useVaults();
  const { data: syncConfigs } = useSyncConfigs();
  const remove = useDeleteVault();
  const openJoin = useUiStore((s) => s.openVaultJoin);

  const [selectedId, setSelectedId] = useState(PERSONAL_VAULT_ID);
  const [editing, setEditing] = useState<Vault | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<Vault | null>(null);

  const list = vaults ?? [];
  const selected = list.find((vault) => vault.id === selectedId) ?? list[0] ?? null;
  const syncByVault = new Map((syncConfigs ?? []).map((config) => [config.vaultId, config]));

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openRename = (vault: Vault) => {
    setEditing(vault);
    setDialogOpen(true);
  };

  const deleteError = remove.isError ? parseLumaError(remove.error).message : null;

  if (isLoading) return <p className="text-sm text-muted">Loading vaults…</p>;

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="space-y-2">
          {list.map((vault) => (
            <VaultRow
              key={vault.id}
              vault={vault}
              selected={selected?.id === vault.id}
              syncConfig={syncByVault.get(vault.id)}
              onSelect={() => setSelectedId(vault.id)}
              onRename={() => openRename(vault)}
              onDelete={vault.kind === "personal" ? undefined : () => setDeleting(vault)}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openCreate}
            className="flex min-h-10 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110"
          >
            <Plus size={14} /> New vault
          </button>
          <button
            type="button"
            onClick={() => openJoin()}
            className="min-h-10 rounded-md border border-border bg-raised px-3 py-1.5 text-sm font-medium text-foreground hover:border-accent/60 hover:bg-surface"
          >
            Join a shared vault
          </button>
        </div>

        {deleteError && (
          <p role="alert" className="text-xs text-danger">
            {deleteError}
          </p>
        )}
      </div>

      {selected && (
        <>
          <section className="space-y-4 border-t border-border pt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Sync — {selected.name}
            </h3>
            <SyncSection vault={selected} />
          </section>
          <section className="space-y-4 border-t border-border pt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Encrypted backup — {selected.name}
            </h3>
            <BackupSection vaultId={selected.id} />
          </section>
        </>
      )}

      <VaultDialog open={dialogOpen} onOpenChange={setDialogOpen} vault={editing} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        title="Delete vault"
        destructive
        confirmLabel="Delete vault"
        busy={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              if (selectedId === deleting.id) setSelectedId(PERSONAL_VAULT_ID);
              setDeleting(null);
            },
          })
        }
        message={
          <div className="space-y-2">
            <p>
              Delete{" "}
              <span className="font-medium text-foreground">{deleting?.name}</span> and
              everything in it — hosts, groups, snippets, keys and identities, including
              the private keys stored on this device.
            </p>
            <p>
              This only affects this device. Other members keep their copies, and the
              data stored at the remote is left untouched.
            </p>
          </div>
        }
      />
    </div>
  );
}

function VaultRow({
  vault,
  selected,
  syncConfig,
  onSelect,
  onRename,
  onDelete,
}: {
  vault: Vault;
  selected: boolean;
  syncConfig: SyncConfig | undefined;
  onSelect: () => void;
  onRename: () => void;
  onDelete?: () => void;
}) {
  const counts = useVaultCounts(vault.id);
  const isMobile = useCapabilityStore((state) => state.capabilities.isMobile);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const canShare =
    vault.kind !== "personal" && Boolean(syncConfig?.enabled && syncConfig.provider);

  const share = async () => {
    if (!canShare || !syncConfig?.provider || sharing) return;
    setSharing(true);
    setShareError(null);
    try {
      let inviteSecret: string | null = null;
      if (vault.kind === "managed") {
        const cloudUrl = syncConfig.cloudUrl;
        if (!cloudUrl) {
          throw new Error("This vault has no Luma Cloud URL configured.");
        }
        inviteSecret = (
          await createVaultInvite({
            id: vault.id,
            cloudUrl,
            role: "writer",
          })
        ).secret;
      }
      const link = buildVaultJoinLink({
        name: vault.name,
        provider: syncConfig.provider,
        inviteSecret,
        folderPath: syncConfig.folderPath,
        url: syncConfig.url,
        username: syncConfig.username,
        gistId: syncConfig.gistId,
        cloudUrl: syncConfig.cloudUrl,
      });
      if (isMobile && navigator.share) {
        await navigator.share({ title: `Join ${vault.name} in Luma`, text: link });
      } else {
        await navigator.clipboard.writeText(link);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setShareError(err instanceof Error ? err.message : parseLumaError(err).message);
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="space-y-1">
      <div
        className={cn(
          "group flex items-center gap-2 rounded-lg border px-3 py-2.5 transition-colors",
          selected ? "border-accent bg-accent/10" : "border-border bg-surface hover:border-accent/50",
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "true" : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
              selected ? "bg-accent/20 text-accent" : "bg-raised text-muted",
            )}
          >
            <VaultIcon size={16} />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{vault.name}</span>
              {vault.kind === "shared" && vault.shareSecrets && (
                <span
                  title="Shares private keys and passwords with every member"
                  className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400"
                >
                  <ShieldAlert size={10} /> Secrets shared
                </span>
              )}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
              {syncConfig?.enabled ? <Cloud size={11} /> : <CloudOff size={11} />}
              {counts}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onRename}
          aria-label={`Rename ${vault.name}`}
          title="Rename"
          className="shrink-0 rounded p-1.5 text-muted hover:text-foreground"
        >
          <Pencil size={14} />
        </button>
        {vault.kind !== "personal" && (
          <button
            type="button"
            onClick={() => void share()}
            disabled={!canShare || sharing}
            aria-label={`Share ${vault.name}`}
            title={canShare ? "Share vault" : "Configure sync before sharing"}
            className="shrink-0 rounded p-1.5 text-muted hover:text-accent disabled:opacity-40"
          >
            <Share2 size={14} />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${vault.name}`}
            title="Delete"
            className="shrink-0 rounded p-1.5 text-muted hover:text-danger"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {shareError && (
        <p role="alert" className="px-3 text-xs text-danger">
          {shareError}
        </p>
      )}
    </div>
  );
}

/** "4 hosts · 2 keys · 1 snippet" — what deleting the vault would take with it. */
function useVaultCounts(vaultId: string): string {
  const { data: hosts } = useHosts();
  const { data: groups } = useHostGroups();
  const { data: keys } = useKeyReferences();
  const { data: identities } = useIdentities();
  const { data: snippets } = useSnippets();

  const parts = (
    [
      [(hosts ?? []).filter((h) => h.vaultId === vaultId && !h.isEphemeral).length, "host"],
      [(groups ?? []).filter((g) => g.vaultId === vaultId).length, "group"],
      [(keys ?? []).filter((k) => k.vaultId === vaultId).length, "key"],
      [(identities ?? []).filter((i) => i.vaultId === vaultId).length, "identity", "identities"],
      [(snippets ?? []).filter((s) => s.vaultId === vaultId).length, "snippet"],
    ] as [number, string, string?][]
  )
    .filter(([count]) => count > 0)
    .map(([count, singular, plural]) =>
      count === 1 ? `1 ${singular}` : `${count} ${plural ?? `${singular}s`}`,
    );

  return parts.length > 0 ? parts.join(" · ") : "Empty";
}
