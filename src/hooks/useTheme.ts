import { useEffect } from "react";
import { SETTING_KEYS, type ThemeMode } from "../types";
import { terminalManager } from "../features/terminal/terminalManager";
import { setResolvedMode } from "../lib/appTheme";
import { useSettings, useSetSetting } from "./useSettings";

function resolve(mode: ThemeMode): "dark" | "light" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return mode;
}

function apply(mode: ThemeMode) {
  const resolved = resolve(mode);
  // Record the resolved mode as the app's dark/light base. When a concrete color
  // scheme is active its kind wins for data-theme (handled in lib/appTheme), so
  // this must not set data-theme directly or it would stomp the scheme override.
  setResolvedMode(resolved);
  terminalManager.configure({ theme: resolved });
}

export function useTheme() {
  const { data: settings } = useSettings();
  const setSetting = useSetSetting();

  const mode = (settings?.[SETTING_KEYS.theme] as ThemeMode | undefined) ?? "dark";

  useEffect(() => {
    apply(mode);
    if (mode !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);

  return {
    mode,
    setMode: (next: ThemeMode) =>
      setSetting.mutate({ key: SETTING_KEYS.theme, value: next }),
  };
}
