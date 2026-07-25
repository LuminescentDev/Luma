import { invoke } from "@tauri-apps/api/core";

export type SettingsMap = Record<string, unknown>;

export function getAllSettings(): Promise<SettingsMap> {
  return invoke<SettingsMap>("settings_get_all");
}

export function setSetting(key: string, value: unknown): Promise<void> {
  return invoke<void>("settings_set", { key, value });
}

export function deleteSetting(key: string): Promise<void> {
  return invoke<void>("settings_delete", { key });
}
