import { invoke } from "@tauri-apps/api/core";

import { setSetting } from "./settings";
import { SETTING_KEYS } from "../types";

export type AnalyticsInfo = {
  /** False in local dev and in any build without an ingest endpoint. */
  configured: boolean;
  enabled: boolean;
  /** The user's own install identifier, so they can quote it when asking for
   * their records to be deleted. Null while opted out. The ingest endpoint is
   * deliberately not exposed. */
  installId: string | null;
};

export function getAnalyticsConfig(): Promise<AnalyticsInfo> {
  return invoke<AnalyticsInfo>("analytics_config");
}

/**
 * Records the consent choice in both places it has to live: the settings table
 * (which survives a restart) and the running process (which sends the events).
 *
 * The two writes are ordered so a partial failure always fails toward NOT
 * sending. Enabling persists first, so a failed runtime call leaves the app
 * quiet until the next launch. Disabling stops the runtime first, so a failed
 * persist has already taken effect. Never the reverse.
 *
 * `analytics_set_enabled` also owns the install identifier: the backend mints
 * it on opt-in and deletes it on opt-out, so it never exists for someone who
 * has not agreed.
 */
export async function applyAnalyticsConsent(enabled: boolean): Promise<void> {
  if (enabled) {
    await setSetting(SETTING_KEYS.analytics, true);
    await setAnalyticsEnabled(true);
    return;
  }
  await setAnalyticsEnabled(false);
  await setSetting(SETTING_KEYS.analytics, false);
}

function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("analytics_set_enabled", { enabled });
}
