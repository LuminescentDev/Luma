import { QueryClient } from "@tanstack/react-query";

/**
 * The app-wide TanStack Query client. Exported from a standalone module so
 * non-React code (e.g. the sync store) can invalidate cached queries after a
 * sync pull applies remote changes to hosts, settings, snippets, etc.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
