import { useQuery, useQueryClient } from "@tanstack/react-query";
import { knownHostsList } from "../lib/knownHosts";

export const KNOWN_HOSTS_KEY = ["known-hosts"];

/** Parsed known-hosts entries. Kept fresh on demand; the file changes rarely, so
 * a modest stale time is fine. */
export function useKnownHosts() {
  return useQuery({
    queryKey: KNOWN_HOSTS_KEY,
    queryFn: knownHostsList,
    staleTime: 30_000,
  });
}

/** Invalidate the known-hosts list. Line numbers shift after a removal, so the
 * list must be refetched — never patched in place. */
export function useInvalidateKnownHosts() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: KNOWN_HOSTS_KEY });
}
