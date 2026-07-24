import { vi } from "vitest";

/*
 * Controllable module-level mock for the Tauri bridge. `@tauri-apps/api/core`
 * and `@tauri-apps/api/window` are replaced (see src/test/setup.ts) with the
 * exports below so store/manager tests can drive `invoke` responses, fire
 * Channel messages (PTY data / exit / transfer progress), and emit window
 * events (`ssh-remote-os`) deterministically.
 */

type InvokeArgs = Record<string, unknown>;
export type InvokeHandler = (
  cmd: string,
  args: InvokeArgs,
) => unknown | Promise<unknown>;

let handler: InvokeHandler | null = null;

/** Install the handler that answers every `invoke(cmd, args)` for a test. */
export function setInvoke(handlerFn: InvokeHandler): void {
  handler = handlerFn;
}

export const invoke = vi.fn(
  async (cmd: string, args: InvokeArgs = {}): Promise<unknown> => {
    if (!handler) throw new Error(`unmocked invoke: ${cmd}`);
    return handler(cmd, args);
  },
);

/** Minimal stand-in for a Tauri `Channel`: the code under test assigns
 * `onmessage`, and the invoke handler (the "backend") calls it. */
export class Channel<T = unknown> {
  onmessage: (message: T) => void = () => {};
}

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();

/** Emit a window event to every registered listener (e.g. `ssh-remote-os`). */
export function emitWindowEvent(name: string, payload: unknown): void {
  for (const listener of listeners.get(name) ?? []) listener({ payload });
}

/** A close-requested handler, mirroring Tauri v2's `onCloseRequested`. */
type CloseHandler = (event: { preventDefault: () => void }) => unknown;
let closeHandler: CloseHandler | null = null;
/** Whether a close-requested listener was still registered at the moment the
 * final `close()` was issued. The window-close flow must detach its listener
 * before re-issuing the close, or Windows silently drops it — asserting this
 * flag is false guards against that regression. */
let closeListenerActiveAtClose = false;

const fakeWindow = {
  listen: vi.fn(async (name: string, cb: Listener) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  }),
  onCloseRequested: vi.fn(async (cb: CloseHandler) => {
    closeHandler = cb;
    return () => {
      if (closeHandler === cb) closeHandler = null;
    };
  }),
  close: vi.fn(async () => {
    // Tauri v2 `close()` re-emits a close-requested event; the onCloseRequested
    // wrapper then destroys the window unless the handler prevented it. With no
    // handler registered, the close proceeds straight to destroy.
    closeListenerActiveAtClose = closeHandler !== null;
    await fireCloseRequested();
  }),
  destroy: vi.fn(async () => {}),
};

/**
 * Drive a window close-requested event through the registered handler using the
 * same semantics as Tauri v2's `onCloseRequested` wrapper: run the handler,
 * and if it didn't call `preventDefault`, destroy the window.
 */
export async function fireCloseRequested(): Promise<void> {
  const current = closeHandler;
  if (!current) {
    await fakeWindow.destroy();
    return;
  }
  let prevented = false;
  await current({
    preventDefault: () => {
      prevented = true;
    },
  });
  if (!prevented) await fakeWindow.destroy();
}

/** Whether a close-requested listener remained registered when the terminal
 * `close()` was issued (should be false — the flow detaches first). */
export function wasCloseListenerActiveAtClose(): boolean {
  return closeListenerActiveAtClose;
}

export function getCurrentWindow(): typeof fakeWindow {
  return fakeWindow;
}

/** Reset all mock state between tests. */
export function resetTauriMock(): void {
  handler = null;
  listeners.clear();
  closeHandler = null;
  closeListenerActiveAtClose = false;
  invoke.mockClear();
  fakeWindow.listen.mockClear();
  fakeWindow.onCloseRequested.mockClear();
  fakeWindow.close.mockClear();
  fakeWindow.destroy.mockClear();
}
