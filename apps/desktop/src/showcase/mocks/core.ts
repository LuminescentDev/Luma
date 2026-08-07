/*
 * Stand-in for @tauri-apps/api/core.
 *
 * Two hosts run this bundle. In a plain browser (the Playwright capture) there
 * is no backend at all, so every command is answered from the seed data. In the
 * real iOS app (the simulator capture) the webview IS a Tauri webview: the seed
 * data still answers app commands — no SSH, no database — but anything
 * addressed to a native plugin has to reach the actual plugin, or the native
 * surfaces the screenshots exist to show never attach. `useNativeTabBar` treats
 * a failed attach as "no plugin here" and silently renders the web capsule
 * instead, which is exactly the fallback we are trying not to photograph.
 */
import * as realCore from "@luma-showcase/real-tauri-core";

export type InvokeArgs = Record<string, unknown>;
export type InvokeHandler = (
  cmd: string,
  args: InvokeArgs,
) => unknown | Promise<unknown>;

let handler: InvokeHandler | null = null;

/** True when this bundle is running inside a real Tauri webview. */
const NATIVE_HOST =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* Tauri addresses plugin commands as `plugin:<name>|<command>`; app commands
 * never contain a colon. Routing on the prefix rather than a hand-kept list of
 * plugin names means a newly added native surface works without touching this
 * file. */
function isPluginCommand(cmd: string): boolean {
  return cmd.startsWith("plugin:");
}

export function setInvokeHandler(fn: InvokeHandler): void {
  handler = fn;
}

export async function invoke<T = unknown>(
  cmd: string,
  args: InvokeArgs = {},
): Promise<T> {
  if (NATIVE_HOST && isPluginCommand(cmd)) {
    return realCore.invoke<T>(cmd, args);
  }
  if (!handler) {
    console.warn(`[showcase] invoke before handler installed: ${cmd}`);
    return null as T;
  }
  return (await handler(cmd, args)) as T;
}

export class Channel<T = unknown> {
  onmessage: (message: T) => void = () => {};
}

export function transformCallback(
  callback?: (response: unknown) => void,
): number {
  void callback;
  return 0;
}

export function isTauri(): boolean {
  return NATIVE_HOST;
}

/* The plugin event bridge. Delegating to the real implementation hands back a
 * real Channel wired to the real callback registry, which is what lets taps on
 * the native tab bar drive navigation. In a plain browser nothing ever emits,
 * so a no-op is the honest answer. */
export async function addPluginListener(
  plugin: string,
  event: string,
  callback: (payload: unknown) => void,
): Promise<{ unregister: () => Promise<void> }> {
  if (NATIVE_HOST) {
    return realCore.addPluginListener(plugin, event, callback);
  }
  void plugin;
  void event;
  void callback;
  return { unregister: async () => {} };
}
