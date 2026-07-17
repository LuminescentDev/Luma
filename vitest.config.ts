import { defineConfig } from "vitest/config";

// Dedicated Vitest config so tests run without the app's Tauri/Tailwind/React
// build plugins. Most targets are pure TypeScript modules and Zustand stores;
// jsdom supplies the `window`/`navigator`/`document` globals that
// terminalManager and the snapshot controller touch. Heavy platform surfaces
// (@tauri-apps/*, @xterm/*) are mocked at the module level in src/test/setup.ts.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
