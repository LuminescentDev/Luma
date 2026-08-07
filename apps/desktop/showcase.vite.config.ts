import { defineConfig, type Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";
import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const mock = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

/* mocks/core.ts needs the genuine @tauri-apps/api/core so it can forward
 * plugin commands to the real native plugins when the showcase is loaded by
 * the iOS app. Importing it by package name would hit the mock alias below, so
 * it is resolved to an absolute file path under a name of its own. */
const realTauriCore = createRequire(import.meta.url).resolve(
  "@tauri-apps/api/core",
);

/*
 * Scenario channel.
 *
 * The Playwright capture switches scenes by navigating to a new URL. The
 * simulator capture cannot: the app owns its webview and nothing outside it can
 * renavigate. So the dev server holds the current scene and the page polls for
 * it, which lets one app launch produce every screenshot.
 */
const SCENARIO_ROUTE = "/__showcase/scenario";
const READY_ROUTE = "/__showcase/ready";
/* The app's webview has no console we can read from the outside — Vite's client
 * console forwarding needs the HMR socket, which is exactly what a page that
 * died on load never opens. showcase.html relays failures here instead. */
const LOG_ROUTE = "/__showcase/log";

function scenarioChannel(): Plugin {
  let current = JSON.stringify({ view: "terminal", theme: "dark", seq: 0 });
  let seq = 0;
  /* Highest scene the page has finished rendering. The capture script waits for
   * this to reach the scene it asked for, so screenshots are gated on the UI
   * actually being there rather than on a guessed sleep. */
  let readySeq = -1;

  const readBody = (
    req: { on: (event: string, fn: (chunk?: unknown) => void) => void },
    done: (body: string) => void,
  ) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => done(body));
  };

  return {
    name: "luma-showcase-scenario-channel",

    /* With the URL params gone (see below), the boot-time platform/theme/view
     * arrive as env vars baked into the served HTML. Only defaults — the
     * scenario channel drives everything after first paint. */
    transformIndexHtml() {
      const defaults = {
        platform: process.env.SHOWCASE_PLATFORM ?? null,
        theme: process.env.SHOWCASE_THEME ?? null,
        view: process.env.SHOWCASE_VIEW ?? null,
      };
      return [
        {
          tag: "script",
          injectTo: "head-prepend" as const,
          children: `window.__SHOWCASE_DEFAULTS__=${JSON.stringify(defaults)};`,
        },
      ];
    },

    /* Serve the showcase as the ROOT document.
     *
     * Tauri builds every webview request by appending to `devUrl` as a string,
     * so a devUrl with a path or query turns into a bogus base: with
     * `.../showcase.html?platform=ios` the app asks for
     * `/showcase.html?platform=ios/src/showcase/main.tsx`. The HTML still
     * resolves, which is why the failure looks like a blank styled page rather
     * than a 404. devUrl therefore has to be a bare origin, and the origin has
     * to hand back the showcase. Params that used to ride on the URL come from
     * SHOWCASE_* env vars (below) and the scenario channel instead. */
    configureServer(server) {
      if (process.env.SHOWCASE_TRACE) {
        server.middlewares.use((req, _res, next) => {
          console.log(`[showcase:req] ${req.method} ${req.url}`);
          next();
        });
      }

      server.middlewares.use((req, _res, next) => {
        if (req.url === "/" || req.url?.startsWith("/?")) {
          req.url = `/showcase.html${req.url.slice(1)}`;
        }
        next();
      });
      server.middlewares.use(SCENARIO_ROUTE, (req, res) => {
        if (req.method === "POST") {
          readBody(req, (body) => {
            try {
              const parsed = JSON.parse(body) as Record<string, unknown>;
              seq += 1;
              current = JSON.stringify({ ...parsed, seq });
              res.statusCode = 204;
            } catch {
              res.statusCode = 400;
            }
            res.end();
          });
          return;
        }
        res.setHeader("Content-Type", "application/json");
        // The page polls this; a cached response would freeze the scene.
        res.setHeader("Cache-Control", "no-store");
        res.end(current);
      });

      server.middlewares.use(LOG_ROUTE, (req, res) => {
        readBody(req, (body) => {
          console.log(`[showcase:page] ${body}`);
          res.statusCode = 204;
          res.end();
        });
      });

      server.middlewares.use(READY_ROUTE, (req, res) => {
        if (req.method === "POST") {
          readBody(req, (body) => {
            try {
              readySeq = Number(
                (JSON.parse(body) as { seq?: unknown }).seq ?? -1,
              );
              res.statusCode = 204;
            } catch {
              res.statusCode = 400;
            }
            res.end();
          });
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ readySeq, seq }));
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss(), scenarioChannel()],
  resolve: {
    alias: [
      { find: "@luma-showcase/real-tauri-core", replacement: realTauriCore },
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
    // The simulator reaches the Mac over the LAN address Tauri injects into the
    // iOS build, not just loopback.
    host: true,
  },
});
