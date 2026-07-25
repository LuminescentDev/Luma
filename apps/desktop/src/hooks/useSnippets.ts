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

export function useSnippets() {
  return useQuery({
    queryKey: SNIPPETS_KEY,
    queryFn: listSnippets,
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
