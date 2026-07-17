import { useQuery, useQueryClient } from "@tanstack/react-query";
import { localList, sftpList, type DirectoryListing } from "../lib/sftp";

/*
 * Directory-listing queries for the SFTP browser. Listings are the only SFTP
 * data that goes through TanStack Query — session metadata and the transfer
 * queue live in the sftp store. Mutations (mkdir/rename/delete) and completed
 * transfers invalidate these keys so the panes refresh.
 */

export const sftpListKey = (sessionId: string, path: string) =>
  ["sftp-list", sessionId, path] as const;
export const localListKey = (path: string | null) =>
  ["local-list", path] as const;

/** Remote directory listing for a connected session. */
export function useSftpList(sessionId: string | null, path: string | null) {
  return useQuery<DirectoryListing>({
    queryKey: sftpListKey(sessionId ?? "", path ?? ""),
    queryFn: () => sftpList(sessionId as string, path as string),
    enabled: Boolean(sessionId && path),
    staleTime: 5_000,
    retry: false,
  });
}

/** Local directory listing (path null resolves to the home directory). */
export function useLocalList(path: string | null) {
  return useQuery<DirectoryListing>({
    queryKey: localListKey(path),
    queryFn: () => localList(path),
    staleTime: 5_000,
    retry: false,
  });
}

/** Invalidate a remote listing after a mutation. */
export function useInvalidateSftp() {
  const queryClient = useQueryClient();
  return (sessionId: string, path: string) =>
    queryClient.invalidateQueries({ queryKey: sftpListKey(sessionId, path) });
}

/** Invalidate a local listing after a mutation. */
export function useInvalidateLocal() {
  const queryClient = useQueryClient();
  return (path: string | null) =>
    queryClient.invalidateQueries({ queryKey: localListKey(path) });
}
