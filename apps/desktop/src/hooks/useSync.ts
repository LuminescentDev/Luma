import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  syncConfigure,
  syncDisable,
  syncGetConfig,
  syncListConfigs,
  syncSetPassphrase,
  type SyncConfigureInput,
} from "../lib/sync";

/**
 * The all-vaults list lives at the bare key and each single vault hangs off it,
 * so invalidating `SYNC_CONFIG_KEY` prefix-matches both.
 */
export const SYNC_CONFIG_KEY = ["sync-config"];

export function syncConfigKey(vaultId: string) {
  return [...SYNC_CONFIG_KEY, vaultId];
}

/** One vault's sync configuration (never contains secrets). */
export function useSyncConfig(vaultId: string) {
  return useQuery({
    queryKey: syncConfigKey(vaultId),
    queryFn: () => syncGetConfig(vaultId),
    staleTime: 15_000,
  });
}

/** Every vault's sync configuration, for the title-bar aggregate. */
export function useSyncConfigs() {
  return useQuery({
    queryKey: SYNC_CONFIG_KEY,
    queryFn: syncListConfigs,
    staleTime: 15_000,
  });
}

/** Invalidate the sync config queries after any state-changing sync command. */
export function useInvalidateSyncConfig() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: SYNC_CONFIG_KEY }),
    [queryClient],
  );
}

export function useConfigureSync(vaultId: string) {
  const invalidate = useInvalidateSyncConfig();
  return useMutation({
    mutationFn: (input: SyncConfigureInput) => syncConfigure(vaultId, input),
    onSuccess: () => invalidate(),
  });
}

export function useSetSyncPassphrase(vaultId: string) {
  const invalidate = useInvalidateSyncConfig();
  return useMutation({
    mutationFn: ({ passphrase, remember }: { passphrase: string; remember: boolean }) =>
      syncSetPassphrase(vaultId, passphrase, remember),
    onSuccess: () => invalidate(),
  });
}

export function useDisableSync(vaultId: string) {
  const invalidate = useInvalidateSyncConfig();
  return useMutation({
    mutationFn: () => syncDisable(vaultId),
    onSuccess: () => invalidate(),
  });
}
