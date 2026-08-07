import ReactDOM from "react-dom/client";
import { App } from "../app/App";
import { terminalManager } from "../features/terminal/terminalManager";
import { useCapabilityStore, DESKTOP_CAPABILITIES, type PlatformCapabilities } from "../stores/capabilityStore";
import { setInvokeHandler } from "./mocks/core";
import { createInvokeHandler } from "./invokeHandlers";
import { applyScenario, isShowcaseView, settleMs, type ShowcaseView } from "./scenarios";
import type { ThemeMode } from "../types";
import "../styles/globals.css";
import "./showcase.css";

/* Injected by showcase.vite.config.ts from SHOWCASE_* env vars. The simulator
 * capture cannot use URL params — Tauri appends its request paths to `devUrl`
 * as a string, so a query there becomes part of the path for every module the
 * page asks for — so the dev server bakes the boot values into the HTML. */
type ShowcaseDefaults = {
  platform?: string | null;
  theme?: string | null;
  view?: string | null;
};

function readParams(): { view: ShowcaseView; theme: "dark" | "light"; platform: "desktop" | "ios" } {
  const params = new URLSearchParams(window.location.search);
  const defaults =
    (window as unknown as { __SHOWCASE_DEFAULTS__?: ShowcaseDefaults })
      .__SHOWCASE_DEFAULTS__ ?? {};
  const rawView = params.get("view") ?? defaults.view ?? "terminal";
  const rawTheme = params.get("theme") ?? defaults.theme ?? "dark";
  const rawPlatform = params.get("platform") ?? defaults.platform ?? "desktop";
  const view = isShowcaseView(rawView) ? rawView : "terminal";
  const theme = rawTheme === "light" ? "light" : "dark";
  const platform = rawPlatform === "ios" ? "ios" : "desktop";
  return { view, theme, platform };
}

const IOS_CAPABILITIES: PlatformCapabilities = {
  os: "ios",
  isMobile: true,
  features: {
    localTerminal: false,
    serial: false,
    sshConfigImport: false,
    sftp: true,
    portForwarding: true,
    updater: false,
    biometrics: true,
    windowControls: false,
    folderSync: false,
    dragAndDrop: false,
  },
};

function markReady(): void {
  document.documentElement.setAttribute("data-showcase-ready", "true");
  (window as unknown as { __showcaseReady?: boolean }).__showcaseReady = true;
}

/*
 * Scenario channel (see showcase.vite.config.ts).
 *
 * The browser capture navigates to a fresh URL per shot. The simulator capture
 * cannot renavigate the app's webview from outside, so instead the page watches
 * the dev server for the scene to render and reports back when it has settled.
 * Only used when the dev server is actually serving us — a built bundle has no
 * channel to poll and simply keeps the scene it booted with.
 */
const SCENARIO_ROUTE = "/__showcase/scenario";
const READY_ROUTE = "/__showcase/ready";
const LOG_ROUTE = "/__showcase/log";
const POLL_MS = 250;

type RemoteScenario = { view?: string; theme?: string; seq?: number };

function applyTheme(theme: "dark" | "light"): void {
  document.documentElement.dataset.theme = theme;
  terminalManager.configure({ theme });
}

async function watchScenarioChannel(
  platform: "desktop" | "ios",
  initialSeq: number,
): Promise<void> {
  let lastSeq = initialSeq;
  for (;;) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, POLL_MS));
    let next: RemoteScenario;
    try {
      const response = await fetch(SCENARIO_ROUTE, { cache: "no-store" });
      if (!response.ok) continue;
      next = (await response.json()) as RemoteScenario;
    } catch {
      // Dev server went away (or this is a static build): nothing to follow.
      return;
    }
    const seq = typeof next.seq === "number" ? next.seq : -1;
    if (seq === lastSeq || seq < 0) continue;
    lastSeq = seq;

    const view = isShowcaseView(next.view ?? "") ? (next.view as ShowcaseView) : "terminal";
    const theme = next.theme === "light" ? "light" : "dark";
    applyTheme(theme);
    try {
      await applyScenario(view, platform);
    } catch (error) {
      // One unrenderable scene must not end the watch: the capture script would
      // then hang on every remaining shot rather than failing the one.
      void fetch(LOG_ROUTE, {
        method: "POST",
        body: `scenario ${view} failed: ${String(error)}`,
      }).catch(() => {});
    }
    await new Promise<void>((resolve) =>
      window.setTimeout(resolve, settleMs(view)),
    );
    markReady();
    // Tells the capture script this scene is on screen, so it can shoot without
    // guessing at a sleep.
    void fetch(READY_ROUTE, {
      method: "POST",
      body: JSON.stringify({ seq }),
    }).catch(() => {});
  }
}

async function boot(): Promise<void> {
  const { view, theme, platform } = readParams();

  document.documentElement.dataset.platform = platform;
  applyTheme(theme);
  useCapabilityStore.getState().setCapabilities(
    platform === "ios" ? IOS_CAPABILITIES : DESKTOP_CAPABILITIES,
  );

  setInvokeHandler(createInvokeHandler(theme as ThemeMode, platform));

  const root = document.getElementById("root");
  if (!root) throw new Error("[showcase] missing #root");
  ReactDOM.createRoot(root).render(<App />);

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await applyScenario(view, platform);

  window.setTimeout(markReady, settleMs(view));
  void watchScenarioChannel(platform, -1);
}

void boot();
