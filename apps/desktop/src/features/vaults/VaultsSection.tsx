import { useState } from "react";
import {
  Check,
  Cloud,
  CloudOff,
  Link2,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
  Vault as VaultIcon,
} from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { parseLumaError } from "../../lib/hosts";
import type { SyncConfig } from "../../lib/sync";
import { buildVaultJoinLink, PERSONAL_VAULT_ID, type Vault } from "../../lib/vaults";
import { useDeleteVault, useVaults } from "../../hooks/useVaults";
import { useSyncConfigs } from "../../hooks/useSync";
import { useHostGroups, useHosts, useIdentities, useKeyReferences } from "../../hooks/useHosts";
import { useSnippets } from "../../hooks/useSnippets";
import { SyncSection } from "../sync/SyncSection";
import { BackupSection } from "../sync/BackupSection";
import { VaultDialog } from "./VaultDialog";
import { useUiStore } from "../../stores/uiStore";
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
              syncEnabled={syncByVault.get(vault.id)?.enabled ?? false}
              onSelect={() => setSelectedId(vault.id)}
              onRename={() => openRename(vault)}
              onDelete={vault.kind === "personal" ? undefined : () => setDeleting(vault)}
            />
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openCreate}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110"
          >
            <Plus size={14} /> New vault
          </button>
          <button
            type="button"
            onClick={() => openJoin()}
            className="rounded-md border border-border bg-raised px-3 py-1.5 text-sm font-medium text-foreground hover:border-accent/60 hover:bg-surface"
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
            {selected.kind === "shared" && (
              <InviteRow vault={selected} config={syncByVault.get(selected.id)} />
            )}
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

/**
 * The link that lets someone else point their Luma at this vault's remote. It
 * carries the location only — the passphrase is shared out of band, and the
 * link alone reveals nothing readable.
 */
function InviteRow({ vault, config }: { vault: Vault; config: SyncConfig | undefined }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = () => {
    if (!config?.provider) return;
    try {
      const link = buildVaultJoinLink({
        name: vault.name,
        provider: config.provider,
        folderPath: config.folderPath,
        url: config.url,
        username: config.username,
        gistId: config.gistId,
        cloudUrl: config.cloudUrl,
      });
      setError(null);
      void navigator.clipboard.writeText(link).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Invite link</p>
          <p className="text-xs text-muted">
            Names the remote only. Send the passphrase separately — together they are
            full access to this vault.
          </p>
        </div>
        <button
          type="button"
          onClick={copy}
          disabled={!config?.enabled || !config.provider}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-raised px-3 py-1.5 text-sm font-medium text-foreground hover:border-accent/60 hover:bg-surface disabled:opacity-50"
        >
          {copied ? <Check size={14} className="text-accent" /> : <Link2 size={14} />}
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      {!config?.enabled && (
        <p className="text-xs text-muted">Configure a provider above before inviting anyone.</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function VaultRow({
  vault,
  selected,
  syncEnabled,
  onSelect,
  onRename,
  onDelete,
}: {
  vault: Vault;
  selected: boolean;
  syncEnabled: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete?: () => void;
}) {
  const counts = useVaultCounts(vault.id);
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
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
            {syncEnabled ? <Cloud size={11} /> : <CloudOff size={11} />}
            {counts}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onRename}
        aria-label={`Rename ${vault.name}`}
        title="Rename"
        className="invisible shrink-0 rounded p-1 text-muted hover:text-foreground group-hover:visible"
      >
        <Pencil size={14} />
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${vault.name}`}
          title="Delete"
          className="invisible shrink-0 rounded p-1 text-muted hover:text-danger group-hover:visible"
        >
          <Trash2 size={14} />
        </button>
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
