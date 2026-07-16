import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  detectSsh,
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
export const SSH_DETECT_KEY = ["ssh-detect"];

export function useHosts() {
  return useQuery({ queryKey: HOSTS_KEY, queryFn: listHosts, staleTime: 30_000 });
}

export function useRecentHosts() {
  return useQuery({
    queryKey: RECENT_HOSTS_KEY,
    queryFn: listRecentHosts,
    staleTime: 10_000,
  });
}

export function useHostGroups() {
  return useQuery({
    queryKey: HOST_GROUPS_KEY,
    queryFn: listHostGroups,
    staleTime: 30_000,
  });
}

export function useKeyReferences() {
  return useQuery({
    queryKey: KEY_REFERENCES_KEY,
    queryFn: listKeyReferences,
    staleTime: 30_000,
  });
}
export function useIdentities() { return useQuery({ queryKey: IDENTITIES_KEY, queryFn: listIdentities, staleTime: 30_000 }); }

export function useSshDetect() {
  return useQuery({
    queryKey: SSH_DETECT_KEY,
    queryFn: detectSsh,
    staleTime: Infinity,
  });
}

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
