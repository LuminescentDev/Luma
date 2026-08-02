import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  onTabSelected,
  setActiveTab,
  setBadge,
  setHidden,
  setItems,
} from "tauri-plugin-ios-glass-tabbar-api";
import { useMobileNavStore, type MobileTab } from "../../stores/mobileNavStore";
import { useCapabilityStore } from "../../stores/capabilityStore";
import { TAB_ITEMS } from "./MobileTabBar";

/*
 * Bridge to tauri-plugin-ios-glass-tabbar. The plugin installs a stock UITabBar
 * over the webview, which automatically adopts Liquid Glass when the app is
 * built with the iOS 26 SDK.
 */

/** Height used for the web capsule; the native bar overwrites this on attach. */
const WEB_TAB_BAR_HEIGHT = 68;

type NativeTabItem = {
  key: MobileTab;
  title: string;
  sfSymbol: string;
};

function setTabBarHeight(height: number): void {
  document.documentElement.style.setProperty(
    "--mobile-tabbar-height",
    `${height}px`,
  );
}

/** Whether the native bar successfully attached for this session. */
let nativeActive = false;

export function isNativeTabBarActive(): boolean {
  return nativeActive;
}

/**
 * Try to hand the tab bar over to the native plugin. Returns true when the
 * native bar is live (the React capsule must then not render). Safe to call on
 * any platform: a missing command or a non-iOS host resolves false.
 */
export async function attachNativeTabBar(
  sessionCount: number,
): Promise<boolean> {
  // Plugin calls deliberately no-op on Android, so a resolved setItems call is
  // not enough to prove a native bar exists there.
  if (useCapabilityStore.getState().capabilities.os !== "ios") {
    nativeActive = false;
    setTabBarHeight(WEB_TAB_BAR_HEIGHT);
    return false;
  }

  try {
    const selectedIndex = tabIndex(useMobileNavStore.getState().tab);
    await setItems(nativeTabs(), selectedIndex);
    await Promise.all([syncBadges(sessionCount), syncTintColor()]);
    nativeActive = true;
    setTabBarHeight(WEB_TAB_BAR_HEIGHT);
    return true;
  } catch {
    // Android, iOS below the plugin's minimum, a denied command permission, or
    // a harness with no backend: fall back to the web capsule.
    nativeActive = false;
    setTabBarHeight(WEB_TAB_BAR_HEIGHT);
    return false;
  }
}

function nativeTabs(): NativeTabItem[] {
  return TAB_ITEMS.map((item) => ({
    key: item.tab,
    title: item.label,
    sfSymbol: item.sfSymbol,
  }));
}

function tabIndex(tab: MobileTab): number {
  return TAB_ITEMS.findIndex((item) => item.tab === tab);
}

function resolvedAccentColor(): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--accent")
    .trim();
}

async function syncTintColor(): Promise<void> {
  await invoke("plugin:ios-glass-tabbar|set_tint_color", {
    payload: { color: resolvedAccentColor() },
  });
}

async function syncBadges(sessionCount: number): Promise<void> {
  await setBadge(
    tabIndex("connections"),
    sessionCount > 0 ? String(sessionCount) : null,
  );
}

/** Mirror the store's selected tab into the native bar. No-op when inactive. */
export async function syncNativeTabBar(
  tab: MobileTab,
  sessionCount: number,
): Promise<void> {
  if (!nativeActive) return;
  try {
    await Promise.all([
      setActiveTab(tabIndex(tab)),
      syncBadges(sessionCount),
      syncTintColor(),
    ]);
  } catch {
    // A failed mirror leaves the bar showing a stale selection for one frame;
    // not worth tearing the bar down over.
  }
}

/**
 * Show or hide the native bar. Hidden while a terminal session is full-screen
 * (the session owns the whole viewport) and while the keyboard is up.
 */
export async function setNativeTabBarVisible(visible: boolean): Promise<void> {
  if (!nativeActive) return;
  try {
    await setHidden(!visible);
  } catch {
    // Ignore: visibility is cosmetic, and the next state change retries.
  }
}

/** Subscribe to native tab selections, routing them into the nav store. */
export async function listenNativeTabBar(): Promise<UnlistenFn> {
  const listener = await onTabSelected(({ key }) => {
    if (key === "vaults" || key === "connections" || key === "profile") {
      useMobileNavStore.getState().selectTab(key);
    }
  });
  return () => listener.unregister();
}
