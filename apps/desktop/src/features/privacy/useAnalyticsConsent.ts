import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { applyAnalyticsConsent, getAnalyticsConfig } from "../../lib/analytics";
import { useSettings } from "../../hooks/useSettings";
import { useCapabilityStore } from "../../stores/capabilityStore";
import { analyticsEnabled, shouldPromptForAnalytics } from "./analyticsConsent";

const ANALYTICS_CONFIG_KEY = ["analytics-config"];

/**
 * Whether this build has an ingest endpoint, and where it points. Cached
 * forever and shared by key so React.StrictMode's double-invoke coalesces into
 * one request, the same problem capabilityStore.hydrate() solves.
 */
export function useAnalyticsConfig() {
  return useQuery({
    queryKey: ANALYTICS_CONFIG_KEY,
    queryFn: getAnalyticsConfig,
    staleTime: Infinity,
  });
}

/**
 * The consent state shared by the first-run prompt and both Settings toggles.
 *
 * Writes go through `applyAnalyticsConsent`, which orders the settings write
 * and the runtime call to fail toward not sending; the settings query is then
 * invalidated so every reader sees the new value. Writing with the raw
 * `setSetting` here would leave the prompt gate believing consent is still
 * undecided.
 */
export function useAnalyticsConsent() {
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const { data: config } = useAnalyticsConfig();
  const capabilitiesLoaded = useCapabilityStore((state) => state.loaded);

  const choose = useMutation({
    mutationFn: (enabled: boolean) => applyAnalyticsConsent(enabled),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ANALYTICS_CONFIG_KEY });
    },
  });

  return {
    enabled: analyticsEnabled(settings),
    configured: config?.configured === true,
    installId: config?.installId ?? null,
    shouldPrompt: shouldPromptForAnalytics(settings, {
      configured: config?.configured === true,
      capabilitiesLoaded,
    }),
    choose,
  };
}
