/*
 * Consent gating for anonymous product analytics.
 *
 * Kept in a plain module (not the components) so it is covered by the test
 * suite, which only collects `src/**\/*.test.ts`.
 */
import type { SettingsMap } from "../../lib/settings";
import { SETTING_KEYS } from "../../types";

export type ConsentGateInput = {
  /** From `analytics_config`. An unconfigured build never prompts. */
  configured: boolean;
  /** capabilityStore hydration, so the desktop dialog cannot flash on a phone. */
  capabilitiesLoaded: boolean;
};

/**
 * Whether the first-run prompt should be shown.
 *
 * Key absence is the whole gate: no existing user has ever had
 * `privacy.analytics`, so they are prompted exactly once at the first launch
 * after upgrading, and never again whichever way they answer. That is why the
 * prompt is not dismissible — every exit path writes an explicit boolean, so
 * there is no third "asked but undecided" state to track.
 */
export function shouldPromptForAnalytics(
  settings: SettingsMap | undefined,
  { configured, capabilitiesLoaded }: ConsentGateInput,
): boolean {
  if (!configured || !capabilitiesLoaded) return false;
  // Undefined means the settings query has not resolved; prompting now would
  // flash the dialog and then retract it.
  if (!settings) return false;
  return settings[SETTING_KEYS.analytics] === undefined;
}

/**
 * Whether analytics is currently on. Undecided defaults OFF — deliberately not
 * the `!== false` default-on idiom the other settings use.
 */
export function analyticsEnabled(settings: SettingsMap | undefined): boolean {
  return settings?.[SETTING_KEYS.analytics] === true;
}
