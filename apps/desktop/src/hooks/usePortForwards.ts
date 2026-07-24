import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createPortForward,
  deletePortForward,
  listPortForwards,
  updatePortForward,
  type PortForwardInput,
} from "../lib/portForwards";

export const PORT_FORWARDS_KEY = ["port-forwards"];

export function usePortForwards(hostId: string | undefined) {
  return useQuery({
    queryKey: [...PORT_FORWARDS_KEY, hostId ?? "all"],
    queryFn: () => listPortForwards(hostId),
    staleTime: 30_000,
    enabled: hostId !== undefined,
  });
}

export function usePortForwardMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: PORT_FORWARDS_KEY });

  const create = useMutation({
    mutationFn: (input: PortForwardInput) => createPortForward(input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: PortForwardInput }) =>
      updatePortForward(id, input),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deletePortForward(id),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}
