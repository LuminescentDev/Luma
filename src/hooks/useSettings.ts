import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAllSettings, setSetting, type SettingsMap } from "../lib/settings";

const SETTINGS_QUERY_KEY = ["settings"];

export function useSettings() {
  return useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: getAllSettings,
    staleTime: Infinity,
  });
}

export function useSetSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      setSetting(key, value),
    onMutate: async ({ key, value }) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
      const previous = queryClient.getQueryData<SettingsMap>(SETTINGS_QUERY_KEY);
      queryClient.setQueryData<SettingsMap>(SETTINGS_QUERY_KEY, (old) => ({
        ...(old ?? {}),
        [key]: value,
      }));
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(SETTINGS_QUERY_KEY, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
  });
}
