import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useMobileNavStore } from "../../stores/mobileNavStore";
import {
  attachNativeTabBar,
  listenNativeTabBar,
  setNativeTabBarVisible,
  syncNativeTabBar,
} from "./tabBar";

/*
 * Owns the lifecycle of the native iOS tab bar and tells the shell whether to
 * render the web capsule instead. Exactly one of the two is ever on screen:
 * `native` is false until the plugin confirms it attached, and stays false
 * everywhere the plugin does not exist (Android, older iOS, test harness).
 */
export function useNativeTabBar({
  sessionCount,
  hidden,
}: {
  sessionCount: number;
  /** True while a full-screen terminal owns the viewport. */
  hidden: boolean;
}): { native: boolean } {
  const [native, setNative] = useState(false);
  const tab = useMobileNavStore((s) => s.tab);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      const attached = await attachNativeTabBar(sessionCount);
      if (disposed) {
        // Unmounted mid-attach: hide the bar we just created rather than
        // leaving an orphaned native view over the webview.
        if (attached) void setNativeTabBarVisible(false);
        return;
      }
      setNative(attached);
      if (attached) unlisten = await listenNativeTabBar();
    })();

    return () => {
      disposed = true;
      unlisten?.();
      void setNativeTabBarVisible(false);
    };
    // Attach once for the shell's lifetime; badge/selection changes flow through
    // the sync effect below rather than re-creating the native view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!native) return;
    void syncNativeTabBar(tab, sessionCount);
  }, [native, tab, sessionCount]);

  useEffect(() => {
    if (!native) return;
    const observer = new MutationObserver(() => {
      void syncNativeTabBar(
        useMobileNavStore.getState().tab,
        sessionCount,
      );
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [native, sessionCount]);

  useEffect(() => {
    if (!native) return;
    void setNativeTabBarVisible(!hidden);
  }, [native, hidden]);

  return { native };
}
