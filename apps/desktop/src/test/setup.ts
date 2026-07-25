import { beforeEach, vi } from "vitest";
import { resetTauriMock } from "./tauriMock";

/*
 * Global test setup: replace the platform-facing modules with the deterministic
 * mocks in this folder so store/manager tests never touch a real Tauri bridge or
 * xterm renderer. Registered here so every test file shares one wiring.
 */

vi.mock("@tauri-apps/api/core", async () => {
  const mock = await import("./tauriMock");
  return { invoke: mock.invoke, Channel: mock.Channel };
});

vi.mock("@tauri-apps/api/window", async () => {
  const mock = await import("./tauriMock");
  return { getCurrentWindow: mock.getCurrentWindow };
});

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

vi.mock("@xterm/xterm", () => import("./xtermMock"));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext(): void {}
    findPrevious(): void {}
    clearDecorations(): void {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(_handler?: unknown) {}
  },
}));

// crypto.randomUUID is used across the pane tree / stores; guarantee it exists.
if (typeof globalThis.crypto?.randomUUID !== "function") {
  let counter = 0;
  Object.defineProperty(globalThis, "crypto", {
    value: {
      ...globalThis.crypto,
      randomUUID: () => `test-uuid-${++counter}`,
    },
    configurable: true,
  });
}

beforeEach(() => {
  resetTauriMock();
});
