import { useState } from "react";
import {
  Check,
  ChevronDown,
  Cloud,
  CloudOff,
  FolderLock,
  FolderTree,
  KeyRound,
  ScrollText,
  Server,
  ShieldCheck,
  SquareCode,
  Users,
  Waypoints,
} from "lucide-react";
import { useVaults } from "../../hooks/useVaults";
import { useHosts, useKeyReferences } from "../../hooks/useHosts";
import { useSnippets } from "../../hooks/useSnippets";
import { useKnownHosts } from "../../hooks/useKnownHosts";
import { useAllPortForwards } from "../../hooks/usePortForwards";
import { useVaultStore, useBrowsingVaultId } from "../../stores/vaultStore";
import { useMobileNavStore } from "../../stores/mobileNavStore";
import { useCapabilityStore } from "../../stores/capabilityStore";
import { MobileList, MobileRow, MobileScreen } from "./MobileScreen";
import { cn } from "../../lib/utils";
import { presentNativeMenu, type NativeMenuItem } from "./nativeMenu";
import type { VaultKind } from "../../lib/vaults";

/*
 * The Vaults tab hub: a vault scope selector over a grouped list of the
 * resources that vault holds. Counts come from the same query hooks the desktop
 * screens use, scoped by vaultStore.activeVaultId, so "All Vaults" and a single
 * vault show consistent numbers without a bespoke count endpoint.
 *
 * SFTP and Logs are session-shaped rather than vault-scoped, so they sit in a
 * second group below the vault's own entities.
 */

/** Menu id standing in for "no vault filter". vaultStore models that as null,
 * which cannot survive the round trip through a native menu's string ids. */
const ALL_VAULTS_ID = "__all__";

/** SF Symbols mirroring the Lucide icons the web sheet uses per vault kind. */
const VAULT_SYMBOL: Record<VaultKind, string> = {
  personal: "iphone",
  shared: "person.2",
  managed: "cloud",
};

export function MobileVaultsHub() {
  const push = useMobileNavStore((s) => s.push);
  const vaultId = useBrowsingVaultId();
  const portForwarding = useCapabilityStore(
    (s) => s.capabilities.features.portForwarding,
  );

  const { data: hosts } = useHosts(vaultId);
  const { data: keys } = useKeyReferences(vaultId);
  const { data: snippets } = useSnippets(vaultId);
  const { data: knownHosts } = useKnownHosts();
  const { data: forwards } = useAllPortForwards();

  // Port forwards belong to hosts, not vaults, so scope them by the hosts the
  // active vault owns rather than showing a global count under one vault.
  const hostIds = new Set((hosts ?? []).map((host) => host.id));
  const forwardCount = (forwards ?? []).filter(
    (forward) => vaultId === undefined || hostIds.has(forward.hostId),
  ).length;

  return (
    <MobileScreen title="Vaults" large action={<VaultPicker />}>
      <MobileList className="mt-2">
        <MobileRow
          icon={Server}
          label="Hosts"
          count={hosts?.length}
          onSelect={() => push("hosts")}
        />
        <MobileRow
          icon={KeyRound}
          label="Keys"
          count={keys?.length}
          onSelect={() => push("keychain")}
        />
        {portForwarding && (
          <MobileRow
            icon={Waypoints}
            label="Port Forwarding"
            count={forwardCount}
            onSelect={() => push("port-forwards")}
          />
        )}
        <MobileRow
          icon={SquareCode}
          label="Snippets"
          count={snippets?.length}
          onSelect={() => push("snippets")}
        />
        <MobileRow
          icon={ShieldCheck}
          label="Known Hosts"
          count={knownHosts?.length}
          onSelect={() => push("known-hosts")}
        />
      </MobileList>

      <MobileList className="mt-6">
        <MobileRow icon={FolderTree} label="Files" onSelect={() => push("sftp")} />
        <MobileRow icon={ScrollText} label="Logs" onSelect={() => push("logs")} />
      </MobileList>
    </MobileScreen>
  );
}

/** Vault scope control in the header: shows the active scope and opens a picker
 * to change it. `null` is the "All Vaults" root, matching vaultStore.
 *
 * On iOS this presents a real UIMenu — Liquid Glass, system checkmarks, system
 * dismissal — and only falls back to the web sheet below when that is
 * unavailable (Android, iOS below 17.4, desktop, tests). */
function VaultPicker() {
  // Anchor rect of the trigger, set only when falling back to the web dropdown.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const { data: vaults } = useVaults();
  const activeVaultId = useVaultStore((s) => s.activeVaultId);
  const setActiveVault = useVaultStore((s) => s.setActiveVault);

  const active = (vaults ?? []).find((vault) => vault.id === activeVaultId);
  const label = active?.name ?? "All Vaults";

  const openPicker = async (event: React.MouseEvent<HTMLButtonElement>) => {
    // Measure before the first await: React clears event.currentTarget once the
    // handler returns, so reading it after suspending would throw on null.
    const rect = event.currentTarget.getBoundingClientRect();
    const items: NativeMenuItem[] = [
      {
        id: ALL_VAULTS_ID,
        title: "All Vaults",
        sfSymbol: "square.stack.3d.up",
        selected: activeVaultId === null,
      },
      ...(vaults ?? []).map((vault) => ({
        id: vault.id,
        title: vault.name,
        sfSymbol: VAULT_SYMBOL[vault.kind],
        selected: activeVaultId === vault.id,
      })),
    ];
    const presented = await presentNativeMenu(items, rect, (id) =>
      setActiveVault(id === ALL_VAULTS_ID ? null : id),
    );
    if (!presented) setAnchor(rect);
  };

  return (
    <>
      <button
        type="button"
        onClick={(event) => void openPicker(event)}
        aria-haspopup="menu"
        aria-label={`Vault scope: ${label}. Change`}
        className="flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm active:bg-raised"
      >
        <FolderLock size={16} className="shrink-0 text-muted" />
        <span className="max-w-32 truncate">{label}</span>
        <ChevronDown size={15} className="shrink-0 text-muted" />
      </button>

      {anchor && (
        // Fallback dropdown for platforms with no native menu. Anchored under
        // the trigger and right-aligned to it, so it reads the same as the
        // UIMenu it stands in for rather than as a bottom sheet.
        <div
          className="fixed inset-0 z-50"
          onClick={() => setAnchor(null)}
          role="presentation"
        >
          <ul
            role="menu"
            aria-label="Select vault"
            onClick={(event) => event.stopPropagation()}
            style={{
              top: anchor.bottom + 6,
              right: Math.max(8, window.innerWidth - anchor.right),
            }}
            className={cn(
              "fixed min-w-52 max-w-[min(20rem,calc(100vw-1rem))] overflow-hidden rounded-2xl p-1",
              "border border-white/10 bg-surface/80 shadow-xl shadow-black/40",
              "backdrop-blur-2xl backdrop-saturate-150",
            )}
          >
            <VaultOption
              label="All Vaults"
              selected={activeVaultId === null}
              onSelect={() => {
                setActiveVault(null);
                setAnchor(null);
              }}
            />
            {(vaults ?? []).map((vault) => (
              <VaultOption
                key={vault.id}
                label={vault.name}
                icon={
                  vault.kind === "personal"
                    ? CloudOff
                    : vault.kind === "managed"
                      ? Cloud
                      : Users
                }
                selected={activeVaultId === vault.id}
                onSelect={() => {
                  setActiveVault(vault.id);
                  setAnchor(null);
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function VaultOption({
  label,
  icon: Icon,
  selected,
  onSelect,
}: {
  label: string;
  icon?: typeof FolderLock;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        onClick={onSelect}
        className="flex min-h-12 w-full items-center gap-2.5 rounded-xl px-2.5 text-left active:bg-raised"
      >
        <Check
          size={18}
          className={cn("shrink-0 text-accent", !selected && "invisible")}
        />
        {Icon && <Icon size={18} className="shrink-0 text-muted" />}
        <span className="min-w-0 flex-1 truncate text-[17px]">{label}</span>
      </button>
    </li>
  );
}
