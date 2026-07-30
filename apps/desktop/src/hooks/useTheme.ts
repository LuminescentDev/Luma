import { useEffect } from "react";
import { terminalManager } from "../features/terminal/terminalManager";
import { setResolvedMode } from "../lib/appTheme";

function apply() {
  const resolved = window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
  // Record the resolved mode as the app's dark/light base. When a concrete color
  // scheme is active its kind wins for data-theme (handled in lib/appTheme), so
  // this must not set data-theme directly or it would stomp the scheme override.
  setResolvedMode(resolved);
  terminalManager.configure({ theme: resolved });
}

export function useTheme() {
  useEffect(() => {
    apply();
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => apply();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
}
