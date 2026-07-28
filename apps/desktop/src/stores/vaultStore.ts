import { create } from "zustand";
import { PERSONAL_VAULT_ID } from "../lib/vaults";

/**
 * Which vault the user is currently browsing. `null` means "all vaults" — the
 * root of the hosts view, where every vault's entities are listed together.
 *
 * This is a *browsing and creation* scope: it decides which vault a new host,
 * group, key or snippet lands in, and which vault's entities a reference picker
 * offers. It never widens what a reference may point at — that stays pinned to
 * the vault of the entity being edited, because a host in one vault may not
 * reference a key in another.
 */
type VaultState = {
  activeVaultId: string | null;
  setActiveVault: (vaultId: string | null) => void;
};

export const useVaultStore = create<VaultState>((set) => ({
  activeVaultId: null,
  setActiveVault: (activeVaultId) => set({ activeVaultId }),
}));

/** Scope for lists the user is browsing. `undefined` means every vault, which
 * is what the list functions and query hooks take for "unscoped". */
export function useBrowsingVaultId(): string | undefined {
  return useVaultStore((state) => state.activeVaultId) ?? undefined;
}

/** Vault a newly created entity lands in, and the only vault its references may
 * point at. Never undefined: an entity belongs to exactly one vault, so "all
 * vaults" has to resolve to something, and personal is the safe default. */
export function useCreationVaultId(): string {
  return useVaultStore((state) => state.activeVaultId) ?? PERSONAL_VAULT_ID;
}
