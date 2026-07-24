import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const mock = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: mock("./src/showcase/mocks/core.ts") },
      { find: "@tauri-apps/api/window", replacement: mock("./src/showcase/mocks/window.ts") },
      { find: "@tauri-apps/api/app", replacement: mock("./src/showcase/mocks/plugins.ts") },
      { find: "@tauri-apps/plugin-opener", replacement: mock("./src/showcase/mocks/plugins.ts") },
      { find: "@tauri-apps/plugin-dialog", replacement: mock("./src/showcase/mocks/plugins.ts") },
      { find: "@tauri-apps/plugin-updater", replacement: mock("./src/showcase/mocks/plugins.ts") },
      { find: "@tauri-apps/plugin-process", replacement: mock("./src/showcase/mocks/plugins.ts") },
      { find: "@xterm/addon-webgl", replacement: mock("./src/showcase/mocks/xtermWebgl.ts") },
    ],
  },
  build: {
    outDir: "dist-showcase",
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./showcase.html", import.meta.url)),
    },
  },
  server: {
    port: 4173,
    strictPort: false,
  },
});
