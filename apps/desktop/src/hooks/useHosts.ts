import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listHostGroups,
  listHosts,
  listIdentities,
  listKeyReferences,
  listRecentHosts,
} from "../lib/hosts";

export const HOSTS_KEY = ["hosts"];
export const RECENT_HOSTS_KEY = ["recent-hosts"];
export const HOST_GROUPS_KEY = ["host-groups"];
export const KEY_REFERENCES_KEY = ["key-references"];
export const IDENTITIES_KEY = ["identities"];

/* Omitting vaultId lists across every vault; passing one *appends* it to the
 * query key, so the bare-prefix invalidations below still match both. The query
 * functions take an optional vaultId, so they are wrapped rather than passed
 * directly: react-query would otherwise hand the query context to that
 * parameter. */

const scoped = (key: string[], vaultId?: string) => (vaultId ? [...key, vaultId] : key);

export function useHosts(vaultId?: string) {
  return useQuery({
    queryKey: scoped(HOSTS_KEY, vaultId),
    queryFn: () => listHosts(vaultId),
    staleTime: 30_000,
  });
}

/** Recents are per-device connection history, not vault-scoped. */
export function useRecentHosts() {
  return useQuery({
    queryKey: RECENT_HOSTS_KEY,
    queryFn: listRecentHosts,
    staleTime: 10_000,
  });
}

export function useHostGroups(vaultId?: string) {
  return useQuery({
    queryKey: scoped(HOST_GROUPS_KEY, vaultId),
    queryFn: () => listHostGroups(vaultId),
    staleTime: 30_000,
  });
}

export function useKeyReferences(vaultId?: string) {
  return useQuery({
    queryKey: scoped(KEY_REFERENCES_KEY, vaultId),
    queryFn: () => listKeyReferences(vaultId),
    staleTime: 30_000,
  });
}
export function useIdentities(vaultId?: string) { return useQuery({ queryKey: scoped(IDENTITIES_KEY, vaultId), queryFn: () => listIdentities(vaultId), staleTime: 30_000 }); }

/** Invalidate every host-related query. Host mutations can touch groups
 * (unparenting), key references (clearing keyId), and recents. */
export function useInvalidateHosts() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: HOSTS_KEY });
    void queryClient.invalidateQueries({ queryKey: RECENT_HOSTS_KEY });
    void queryClient.invalidateQueries({ queryKey: HOST_GROUPS_KEY });
    void queryClient.invalidateQueries({ queryKey: KEY_REFERENCES_KEY });
    void queryClient.invalidateQueries({ queryKey: IDENTITIES_KEY });
  };
}
