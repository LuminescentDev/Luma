import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://viteplus.dev/ — Vite+ runs Vite 8 + Rolldown under `vp dev`/`vp build`.
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  build: {
    rollupOptions: {
      output: {
        // Stable vendor chunks so the large third-party groups are cached
        // separately from app code and kept out of the main entry chunk.
        // Rolldown replaces Rollup's `manualChunks` with `codeSplitting.groups`;
        // each group's `test` receives a module id and returns whether it belongs.
        codeSplitting: {
          groups: [
            {
              // The WebGL addon is dynamically imported by terminalManager; it is
              // deliberately excluded here so it stays its own lazily-loaded chunk
              // instead of being folded into the xterm vendor group.
              name: "vendor-xterm",
              test: (id: string) =>
                id.includes("node_modules") &&
                id.includes("@xterm") &&
                !id.includes("@xterm/addon-webgl"),
            },
            {
              name: "vendor-react",
              test: (id: string) =>
                id.includes("node_modules") &&
                (id.includes("@radix-ui") ||
                  id.includes("react-dom") ||
                  id.includes("react-remove-scroll") ||
                  id.includes("react-style-singleton") ||
                  id.includes("use-callback-ref") ||
                  id.includes("use-sidecar") ||
                  id.includes("aria-hidden") ||
                  id.includes("@floating-ui") ||
                  id.includes("node_modules/react/") ||
                  id.includes("node_modules/scheduler/")),
            },
          ],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
