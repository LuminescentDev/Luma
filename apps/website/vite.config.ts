import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// https://viteplus.dev/ — Vite+ runs Vite 8 + Rolldown under `vp dev`/`vp build`,
// mirroring the toolchain used by the main Luma application. The async factory
// form matches the root app and sidesteps a deep type comparison between the
// Tailwind plugin and Vite+'s object config overload.
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        support: resolve(import.meta.dirname, "support/index.html"),
        privacy: resolve(import.meta.dirname, "privacy/index.html"),
      },
    },
  },
}));
