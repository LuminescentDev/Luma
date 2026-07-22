import ReactDOM from "react-dom/client";
import { App } from "../app/App";
import { terminalManager } from "../features/terminal/terminalManager";
import { useCapabilityStore, DESKTOP_CAPABILITIES } from "../stores/capabilityStore";
import { setInvokeHandler } from "./mocks/core";
import { createInvokeHandler } from "./invokeHandlers";
import { applyScenario, isShowcaseView, settleMs, type ShowcaseView } from "./scenarios";
import type { ThemeMode } from "../types";
import "../styles/globals.css";
import "./showcase.css";

function readParams(): { view: ShowcaseView; theme: "dark" | "light" } {
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get("view") ?? "terminal";
  const rawTheme = params.get("theme") ?? "dark";
  const view = isShowcaseView(rawView) ? rawView : "terminal";
  const theme = rawTheme === "light" ? "light" : "dark";
  return { view, theme };
}

function markReady(): void {
  document.documentElement.setAttribute("data-showcase-ready", "true");
  (window as unknown as { __showcaseReady?: boolean }).__showcaseReady = true;
}

async function boot(): Promise<void> {
  const { view, theme } = readParams();

  document.documentElement.dataset.theme = theme;
  terminalManager.configure({ theme });
  useCapabilityStore.getState().setCapabilities(DESKTOP_CAPABILITIES);

  setInvokeHandler(createInvokeHandler(theme as ThemeMode));

  const root = document.getElementById("root");
  if (!root) throw new Error("[showcase] missing #root");
  ReactDOM.createRoot(root).render(<App />);

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await applyScenario(view);

  window.setTimeout(markReady, settleMs(view));
}

void boot();
