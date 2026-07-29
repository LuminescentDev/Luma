import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/*
 * Bridge to the native iOS menu (src-tauri/src/commands/menu.rs, Swift side in
 * gen/apple/Sources/luma/LumaMenu.swift). A UIMenu presented over the webview
 * renders in real Liquid Glass on iOS 26, with the system's own checkmarks and
 * dismissal behaviour — none of which the webview can draw.
 *
 * Anchoring: the caller passes the trigger element's viewport rect, which maps
 * 1:1 to UIKit points, so the menu hangs off the React button that opened it.
 *
 * Selection is one-way, like a real menu: choosing nothing reports nothing.
 * `present` resolves false wherever the native menu is unavailable (Android,
 * iOS below 17.4, desktop, tests), and callers then show their own sheet.
 */

export type NativeMenuItem = {
  id: string;
  title: string;
  /** SF Symbol shown leading the title. */
  sfSymbol?: string;
  selected?: boolean;
};

/** Handler for the menu currently on screen. A single slot, not a queue: only
 * one menu can be up at a time, and a dismissed menu's handler is simply
 * replaced by the next one rather than accumulating. */
let pendingHandler: ((id: string) => void) | null = null;
let unlisten: UnlistenFn | null = null;
let listening: Promise<void> | null = null;

async function ensureListening(): Promise<void> {
  if (unlisten) return;
  if (listening) return listening;
  listening = listen<{ id: string }>("mobile-menu://selected", (event) => {
    const handler = pendingHandler;
    pendingHandler = null;
    handler?.(event.payload.id);
  })
    .then((dispose) => {
      unlisten = dispose;
    })
    .finally(() => {
      listening = null;
    });
  return listening;
}

/**
 * Show a native menu anchored to `anchor`, calling `onSelect` if the user picks
 * something. Resolves true when the native menu was presented, false when the
 * caller should fall back to its own UI.
 */
export async function presentNativeMenu(
  items: NativeMenuItem[],
  anchor: DOMRect,
  onSelect: (id: string) => void,
): Promise<boolean> {
  try {
    await ensureListening();
    pendingHandler = onSelect;
    await invoke("menu_present", {
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        sfSymbol: item.sfSymbol ?? null,
        selected: item.selected ?? false,
      })),
      anchor: {
        x: anchor.x,
        y: anchor.y,
        width: anchor.width,
        height: anchor.height,
      },
    });
    return true;
  } catch {
    // No native menu here. Drop the handler so a later selection event from an
    // unrelated menu cannot invoke this caller's callback.
    pendingHandler = null;
    return false;
  }
}

/** Release the selection listener. For teardown in tests and hot reload. */
export function disposeNativeMenu(): void {
  unlisten?.();
  unlisten = null;
  pendingHandler = null;
}
