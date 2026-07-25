import { useUiStore } from "../stores/uiStore";
import { useSessionStore } from "../stores/sessionStore";

export type ShowcaseView =
  | "terminal"
  | "hosts"
  | "snippets"
  | "settings"
  | "palette";

export const SHOWCASE_VIEWS: ShowcaseView[] = [
  "terminal",
  "hosts",
  "snippets",
  "settings",
  "palette",
];

export function isShowcaseView(value: string): value is ShowcaseView {
  return (SHOWCASE_VIEWS as string[]).includes(value);
}

export function settleMs(view: ShowcaseView): number {
  return view === "terminal" ? 1900 : 650;
}

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function waitForMobileNavButton(label: string): Promise<HTMLButtonElement> {
  const selector = `nav[aria-label="Primary"] button[aria-label="${label}"]`;
  const deadline = performance.now() + 10_000;
  let button: HTMLButtonElement | null = null;
  while (!button && performance.now() < deadline) {
    button = document.querySelector<HTMLButtonElement>(selector);
    if (!button) await frame();
  }
  if (!button) throw new Error(`[showcase] mobile navigation did not render: ${label}`);
  return button;
}

async function setupTerminal(singleSession = false): Promise<void> {
  const store = useSessionStore.getState();
  await store.openSshSession("h-web-01", "vps-0cd97c22", "158.69.198.249", false, "#4ade80");
  if (singleSession) {
    await frame();
    return;
  }
  const primaryTabId = useSessionStore.getState().activeTabId;

  await store.splitActivePaneWith("row", {
    kind: "ssh",
    hostId: "h-db-01",
    title: "db-primary",
    connectionTarget: "10.0.4.20",
    tabColor: "#60a5fa",
  });

  await store.openSshSession("h-nas", "homelab-nas", "192.168.1.10");
  await store.openSshSession("h-edge", "edge-fedora", "203.0.113.9");

  if (primaryTabId) store.setActiveTab(primaryTabId);
  await frame();
}

export async function applyScenario(
  view: ShowcaseView,
  platform: "desktop" | "ios" = "desktop",
): Promise<void> {
  if (platform === "ios") {
    await waitForMobileNavButton("Hosts");
    if (view === "terminal") {
      await setupTerminal(true);
      return;
    }
    if (view === "snippets" || view === "settings") {
      const label = view === "snippets" ? "Snippets" : "Settings";
      const button = await waitForMobileNavButton(label);
      button.click();
      await frame();
    }
    return;
  }
  const ui = useUiStore.getState();
  switch (view) {
    case "terminal":
      await setupTerminal();
      break;
    case "hosts":
      ui.openSection("hosts");
      break;
    case "snippets":
      ui.openSection("snippets");
      break;
    case "settings":
      ui.openSettings();
      break;
    case "palette":
      ui.openSection("hosts");
      ui.openPalette();
      break;
  }
}
