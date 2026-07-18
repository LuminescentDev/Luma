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
  onCloseRequested: vi.fn(async () => () => {}),
  close: vi.fn(async () => {}),
};

export function getCurrentWindow(): typeof fakeWindow {
  return fakeWindow;
}

/** Reset all mock state between tests. */
export function resetTauriMock(): void {
  handler = null;
  listeners.clear();
  invoke.mockClear();
  fakeWindow.listen.mockClear();
  fakeWindow.onCloseRequested.mockClear();
  fakeWindow.close.mockClear();
}
