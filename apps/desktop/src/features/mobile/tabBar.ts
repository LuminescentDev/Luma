import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useMobileNavStore, type MobileTab } from "../../stores/mobileNavStore";
import { TAB_ITEMS } from "./MobileTabBar";

/*
 * Bridge to the native iOS tab bar (see src-tauri/src/mobile/tab_bar.rs and the
 * Swift side in gen/apple). The bar is a real UIKit/SwiftUI view pinned over the
 * webview, so on iOS 26 it renders in genuine Liquid Glass — a material the
 * webview itself can never draw, since WebKit exposes no CSS primitive for it.
 *
 * Contract:
 *  - We push the tab list and the selected tab down; the bar pushes taps back up
 *    as a `mobile-tab-bar://selected` event.
 *  - The bar measures itself and reports its height so web content can reserve
 *    room for it (--mobile-tabbar-height, consumed by the .pb-tabbar utility).
 *  - `attach` resolves to false wherever the native bar is unavailable (Android,
 *    older iOS, desktop, tests). Callers then render the web capsule instead, so
 *    exactly one bar is ever on screen.
 */

/** Height used for the web capsule; the native bar overwrites this on attach. */
const WEB_TAB_BAR_HEIGHT = 68;

type NativeTabItem = {
  id: MobileTab;
  label: string;
  sfSymbol: string;
  /** Badge count; 0 renders no badge. */
  badge: number;
};

function setTabBarHeight(height: number): void {
  document.documentElement.style.setProperty(
    "--mobile-tabbar-height",
    `${height}px`,
  );
}

/** Whether the native bar successfully attached for this session. */
let nativeActive = false;

export type TabBarStatus =
  | { kind: "native"; height: number }
  | { kind: "web"; reason: string }
  | { kind: "pending" };

let status: TabBarStatus = { kind: "pending" };

/**
 * What is actually drawing the tab bar. Surfaced in Profile > About because the
 * fallback is otherwise silent: a denied command or an older iOS just yields
 * the web capsule, which looks like a styling problem rather than a wiring one.
 */
export function tabBarStatus(): TabBarStatus {
  return status;
}

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
  try {
    const height = await invoke<number>("tab_bar_attach", {
      tabs: nativeTabs(sessionCount),
      selected: useMobileNavStore.getState().tab,
    });
    // Treat anything but a real positive height as "no native bar". A resolved
    // call is not proof of one: a stub or mock invoke can answer null, and
    // trusting that would hide the web capsule and leave NO tab bar at all.
    if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
      nativeActive = false;
      status = { kind: "web", reason: `attach returned ${JSON.stringify(height)}` };
      setTabBarHeight(WEB_TAB_BAR_HEIGHT);
      return false;
    }
    nativeActive = true;
    status = { kind: "native", height };
    setTabBarHeight(height);
    return true;
  } catch (error) {
    // Android, iOS below the plugin's minimum, a denied command permission, or
    // a harness with no backend. Keep the reason: it is the difference between
    // "this platform has no native bar" and "the bar is misconfigured".
    nativeActive = false;
    status = {
      kind: "web",
      reason: error instanceof Error ? error.message : String(error),
    };
    setTabBarHeight(WEB_TAB_BAR_HEIGHT);
    return false;
  }
}

function nativeTabs(sessionCount: number): NativeTabItem[] {
  return TAB_ITEMS.map((item) => ({
    id: item.tab,
    label: item.label,
    sfSymbol: item.sfSymbol,
    badge: item.tab === "connections" ? sessionCount : 0,
  }));
}

/** Mirror the store's selected tab into the native bar. No-op when inactive. */
export async function syncNativeTabBar(
  tab: MobileTab,
  sessionCount: number,
): Promise<void> {
  if (!nativeActive) return;
  try {
    await invoke("tab_bar_update", {
      tabs: nativeTabs(sessionCount),
      selected: tab,
    });
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
    await invoke("tab_bar_set_visible", { visible });
  } catch {
    // Ignore: visibility is cosmetic, and the next state change retries.
  }
}

/** Subscribe to native tab selections, routing them into the nav store. */
export async function listenNativeTabBar(): Promise<UnlistenFn> {
  return listen<{ id: MobileTab }>("mobile-tab-bar://selected", (event) => {
    const { id } = event.payload;
    if (id === "vaults" || id === "connections" || id === "profile") {
      useMobileNavStore.getState().selectTab(id);
    }
  });
}
