import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createSnippet,
  deleteSnippet,
  listSnippets,
  updateSnippet,
  type SnippetInput,
} from "../lib/snippets";

export const SNIPPETS_KEY = ["snippets"];

/** Omitting vaultId lists across every vault; passing one appends it to the
 * query key so the bare-prefix invalidation below still matches. */
export function useSnippets(vaultId?: string) {
  return useQuery({
    queryKey: vaultId ? [...SNIPPETS_KEY, vaultId] : SNIPPETS_KEY,
    queryFn: () => listSnippets(vaultId),
    staleTime: 30_000,
  });
}

export function useSnippetMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: SNIPPETS_KEY });

  const create = useMutation({
    mutationFn: (input: SnippetInput) => createSnippet(input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: SnippetInput }) =>
      updateSnippet(id, input),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteSnippet(id),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}
