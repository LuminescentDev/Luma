type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();

export function emitWindowEvent(name: string, payload: unknown): void {
  for (const listener of listeners.get(name) ?? []) listener({ payload });
}

type CloseHandler = (event: { preventDefault: () => void }) => unknown;

const fakeWindow = {
  label: "main",
  listen: async (name: string, cb: Listener) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  },
  once: async (name: string, cb: Listener) => {
    const wrapped: Listener = (event) => {
      cb(event);
      listeners.get(name)?.delete(wrapped);
    };
    return fakeWindow.listen(name, wrapped);
  },
  emit: async (name: string, payload?: unknown) => emitWindowEvent(name, payload),
  onCloseRequested: async (_cb: CloseHandler) => {
    return () => {};
  },
  close: async () => {},
  destroy: async () => {},
  minimize: async () => {},
  maximize: async () => {},
  unmaximize: async () => {},
  toggleMaximize: async () => {},
  isMaximized: async () => false,
  setTitle: async () => {},
  setFocus: async () => {},
  scaleFactor: async () => 1,
};

export function getCurrentWindow(): typeof fakeWindow {
  return fakeWindow;
}

export const appWindow = fakeWindow;
