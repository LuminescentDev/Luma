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

function readParams(): { view: ShowcaseView; theme: "dark" | "light"; platform: "desktop" | "ios" } {
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get("view") ?? "terminal";
  const rawTheme = params.get("theme") ?? "dark";
  const view = isShowcaseView(rawView) ? rawView : "terminal";
  const theme = rawTheme === "light" ? "light" : "dark";
  const platform = params.get("platform") === "ios" ? "ios" : "desktop";
  return { view, theme, platform };
}

const IOS_CAPABILITIES: PlatformCapabilities = {
  os: "ios",
  isMobile: true,
  features: {
    localTerminal: false,
    serial: false,
    systemSsh: false,
    sftp: true,
    portForwarding: false,
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

async function boot(): Promise<void> {
  const { view, theme, platform } = readParams();

  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.platform = platform;
  terminalManager.configure({ theme });
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
}

void boot();
