import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  createVault,
  deleteVault,
  listVaults,
  updateVault,
  type Vault,
  type VaultInput,
} from "../lib/vaults";

export const VAULTS_KEY = ["vaults"];

export function useVaults() {
  return useQuery({ queryKey: VAULTS_KEY, queryFn: listVaults, staleTime: 30_000 });
}

/** One vault out of the cached list — vaults are few, so no separate query. */
export function useVault(vaultId: string | null): Vault | undefined {
  const { data } = useVaults();
  if (!vaultId) return undefined;
  return data?.find((vault) => vault.id === vaultId);
}

/** A vault's name for display beside an entity, or undefined when there is only
 * one vault and naming it would be noise. */
export function useVaultLabel(vaultId: string): string | undefined {
  const { data } = useVaults();
  const list = data ?? [];
  if (list.length < 2) return undefined;
  return list.find((vault) => vault.id === vaultId)?.name;
}

export function useInvalidateVaults() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: VAULTS_KEY }),
    [queryClient],
  );
}

export function useCreateVault() {
  const invalidate = useInvalidateVaults();
  return useMutation({
    mutationFn: (input: VaultInput) => createVault(input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateVault() {
  const invalidate = useInvalidateVaults();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: VaultInput }) =>
      updateVault(id, input),
    onSuccess: () => invalidate(),
  });
}

/** Deleting a vault removes every entity and secret scoped to it. */
export function useDeleteVault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteVault(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: VAULTS_KEY });
      for (const key of [
        ["hosts"],
        ["recent-hosts"],
        ["host-groups"],
        ["key-references"],
        ["identities"],
        ["snippets"],
        ["sync-config"],
      ]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}
