import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  syncConfigure,
  syncDisable,
  syncGetConfig,
  syncSetPassphrase,
  type SyncConfigureInput,
} from "../lib/sync";

export const SYNC_CONFIG_KEY = ["sync-config"];

/** The sync configuration (never contains secrets). */
export function useSyncConfig() {
  return useQuery({
    queryKey: SYNC_CONFIG_KEY,
    queryFn: syncGetConfig,
    staleTime: 15_000,
  });
}

/** Invalidate the sync config query after any state-changing sync command. */
export function useInvalidateSyncConfig() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: SYNC_CONFIG_KEY });
}

export function useConfigureSync() {
  const invalidate = useInvalidateSyncConfig();
  return useMutation({
    mutationFn: (input: SyncConfigureInput) => syncConfigure(input),
    onSuccess: () => invalidate(),
  });
}

export function useSetSyncPassphrase() {
  const invalidate = useInvalidateSyncConfig();
  return useMutation({
    mutationFn: ({ passphrase, remember }: { passphrase: string; remember: boolean }) =>
      syncSetPassphrase(passphrase, remember),
    onSuccess: () => invalidate(),
  });
}

export function useDisableSync() {
  const invalidate = useInvalidateSyncConfig();
  return useMutation({
    mutationFn: () => syncDisable(),
    onSuccess: () => invalidate(),
  });
}
