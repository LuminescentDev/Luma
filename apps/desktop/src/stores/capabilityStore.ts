import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/*
 * Platform capability store. Hydrated once at app init from the backend
 * `platform_capabilities` command and used as the SINGLE source of truth for
 * every desktop/mobile branch in the app (layout shell, navigation, settings,
 * terminal wiring, SFTP). No feature decision anywhere else should read the
 * user-agent — it flows from here.
 *
 * Until the backend answers, the store exposes a safe DESKTOP-shaped default so
 * a desktop build renders its normal experience immediately with no flash. The
 * `loaded` flag lets the shell wait for the real payload before committing to a
 * mobile layout (which would otherwise briefly show desktop chrome on a phone).
 */

/** Fine-grained platform features reported by the backend. Every branch that
 * gates a feature keys off one of these, never off the OS directly. */
export type PlatformFeatures = {
  /** Local PTY shells (pty_spawn and friends). Mobile: false. */
  localTerminal: boolean;
  /** Serial-port terminals. Mobile: false. */
  serial: boolean;
  /** System OpenSSH integration (ssh_detect / config import). Mobile: false. */
  systemSsh: boolean;
  /** SFTP browsing + transfers. Available on every platform. */
  sftp: boolean;
  /** SSH port forwarding / tunnels. Mobile: false. */
  portForwarding: boolean;
  /** In-app self-updater. Mobile: false (store-managed updates). */
  updater: boolean;
  /** Biometric vault unlock. Desktop: false; mobile: (future) true. */
  biometrics: boolean;
  /** Custom window controls / title bar. Mobile: false. */
  windowControls: boolean;
  /** Folder-based sync provider. Mobile: false (no arbitrary fs access). */
  folderSync: boolean;
  /** Drag-and-drop file affordances. Mobile: false. */
  dragAndDrop: boolean;
};

export type PlatformOs =
  | "windows"
  | "macos"
  | "linux"
  | "android"
  | "ios";

export type PlatformCapabilities = {
  os: PlatformOs;
  /** True on Android / iOS. The layout shell and terminal wiring branch on this. */
  isMobile: boolean;
  features: PlatformFeatures;
};

/** Safe desktop-shaped default used until the backend payload arrives. Mirrors a
 * desktop response (everything on except biometrics) so a desktop build renders
 * unchanged with no capability flash. */
export const DESKTOP_CAPABILITIES: PlatformCapabilities = {
  os: "windows",
  isMobile: false,
  features: {
    localTerminal: true,
    serial: true,
    systemSsh: true,
    sftp: true,
    portForwarding: true,
    updater: true,
    biometrics: false,
    windowControls: true,
    folderSync: true,
    dragAndDrop: true,
  },
};

type CapabilityState = {
  capabilities: PlatformCapabilities;
  /** True once the real backend payload has been applied (or a hydrate attempt
   * failed and fell back to the desktop default). */
  loaded: boolean;
  /** Fetch `platform_capabilities` once and apply it. Idempotent: repeated calls
   * after a successful load are no-ops. A failed invoke leaves the desktop
   * default in place and still marks the store loaded so the shell can proceed. */
  hydrate: () => Promise<void>;
  /** Directly set capabilities (tests / future push updates). */
  setCapabilities: (capabilities: PlatformCapabilities) => void;
};

/** Coerce an unknown backend payload into a fully-populated capabilities object,
 * defaulting any missing field to its desktop value. Defensive against schema
 * drift so a partial payload can never leave a feature `undefined`. */
export function normalizeCapabilities(raw: unknown): PlatformCapabilities {
  const value = (raw ?? {}) as Partial<PlatformCapabilities>;
  const rawFeatures = (value.features ?? {}) as Partial<PlatformFeatures>;
  const feature = (key: keyof PlatformFeatures): boolean =>
    typeof rawFeatures[key] === "boolean"
      ? (rawFeatures[key] as boolean)
      : DESKTOP_CAPABILITIES.features[key];
  return {
    os: value.os ?? DESKTOP_CAPABILITIES.os,
    isMobile:
      typeof value.isMobile === "boolean"
        ? value.isMobile
        : value.os === "android" || value.os === "ios",
    features: {
      localTerminal: feature("localTerminal"),
      serial: feature("serial"),
      systemSsh: feature("systemSsh"),
      sftp: feature("sftp"),
      portForwarding: feature("portForwarding"),
      updater: feature("updater"),
      biometrics: feature("biometrics"),
      windowControls: feature("windowControls"),
      folderSync: feature("folderSync"),
      dragAndDrop: feature("dragAndDrop"),
    },
  };
}

let hydrating: Promise<void> | null = null;

export const useCapabilityStore = create<CapabilityState>((set, get) => ({
  capabilities: DESKTOP_CAPABILITIES,
  loaded: false,

  hydrate: async () => {
    if (get().loaded) return;
    // Coalesce concurrent first-load calls (StrictMode double-invoke, layout +
    // manager both nudging hydrate) into a single backend round-trip.
    if (hydrating) return hydrating;
    hydrating = (async () => {
      try {
        const raw = await invoke("platform_capabilities");
        set({ capabilities: normalizeCapabilities(raw), loaded: true });
      } catch {
        // Backend unavailable (e.g. a browser-only test harness): keep the safe
        // desktop default but let the shell proceed rather than hang on a splash.
        set({ loaded: true });
      } finally {
        hydrating = null;
      }
    })();
    return hydrating;
  },

  setCapabilities: (capabilities) => set({ capabilities, loaded: true }),
}));

/** Non-React accessor for the current capabilities, for modules that live
 * outside React (notably terminalManager, which owns xterm bytes). */
export function platformCapabilities(): PlatformCapabilities {
  return useCapabilityStore.getState().capabilities;
}

/** Whether the app is running on a mobile platform. Convenience wrapper around
 * the store for non-React callers. */
export function isMobilePlatform(): boolean {
  return useCapabilityStore.getState().capabilities.isMobile;
}
