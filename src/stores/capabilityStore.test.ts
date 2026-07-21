import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke } from "../test/tauriMock";
import {
  DESKTOP_CAPABILITIES,
  normalizeCapabilities,
  platformCapabilities,
  isMobilePlatform,
  useCapabilityStore,
  type PlatformCapabilities,
} from "./capabilityStore";

const MOBILE_PAYLOAD: PlatformCapabilities = {
  os: "android",
  isMobile: true,
  features: {
    localTerminal: false,
    serial: false,
    systemSsh: false,
    sftp: true,
    portForwarding: false,
    updater: false,
    biometrics: false,
    windowControls: false,
    folderSync: false,
    dragAndDrop: false,
  },
};

beforeEach(() => {
  // Reset the singleton store to its unloaded desktop-shaped default so each
  // test drives hydrate() from a clean state.
  useCapabilityStore.setState({
    capabilities: DESKTOP_CAPABILITIES,
    loaded: false,
  });
});

describe("capabilityStore defaults", () => {
  it("starts with a desktop-shaped default and loaded=false", () => {
    const state = useCapabilityStore.getState();
    expect(state.loaded).toBe(false);
    expect(state.capabilities.isMobile).toBe(false);
    expect(state.capabilities.features.localTerminal).toBe(true);
    expect(state.capabilities.features.sftp).toBe(true);
    // Biometrics is the one desktop feature that is off.
    expect(state.capabilities.features.biometrics).toBe(false);
  });

  it("exposes non-React accessors reflecting the default", () => {
    expect(isMobilePlatform()).toBe(false);
    expect(platformCapabilities().features.updater).toBe(true);
  });
});

describe("capabilityStore hydrate", () => {
  it("applies a mobile payload and flips isMobile / features", async () => {
    setInvoke((cmd) => {
      if (cmd === "platform_capabilities") return MOBILE_PAYLOAD;
      throw new Error(`unexpected ${cmd}`);
    });

    await useCapabilityStore.getState().hydrate();

    const state = useCapabilityStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.capabilities.os).toBe("android");
    expect(state.capabilities.isMobile).toBe(true);
    expect(state.capabilities.features.localTerminal).toBe(false);
    expect(state.capabilities.features.serial).toBe(false);
    expect(state.capabilities.features.updater).toBe(false);
    expect(state.capabilities.features.sftp).toBe(true);
    expect(isMobilePlatform()).toBe(true);
  });

  it("keeps the desktop default and still loads when the invoke fails", async () => {
    setInvoke(() => {
      throw new Error("platform_capabilities not registered");
    });

    await useCapabilityStore.getState().hydrate();

    const state = useCapabilityStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.capabilities.isMobile).toBe(false);
    expect(state.capabilities.features.localTerminal).toBe(true);
  });

  it("is idempotent once loaded (no second backend call)", async () => {
    let calls = 0;
    setInvoke((cmd) => {
      if (cmd === "platform_capabilities") {
        calls += 1;
        return MOBILE_PAYLOAD;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useCapabilityStore.getState().hydrate();
    await useCapabilityStore.getState().hydrate();

    expect(calls).toBe(1);
  });
});

describe("normalizeCapabilities", () => {
  it("fills missing features with desktop defaults", () => {
    const result = normalizeCapabilities({ os: "linux", isMobile: false, features: {} });
    expect(result.features.localTerminal).toBe(true);
    expect(result.features.biometrics).toBe(false);
  });

  it("infers isMobile from the OS when the flag is absent", () => {
    expect(normalizeCapabilities({ os: "ios" }).isMobile).toBe(true);
    expect(normalizeCapabilities({ os: "macos" }).isMobile).toBe(false);
  });

  it("tolerates a null / empty payload", () => {
    const result = normalizeCapabilities(null);
    expect(result.os).toBe(DESKTOP_CAPABILITIES.os);
    expect(result.isMobile).toBe(false);
    expect(result.features.sftp).toBe(true);
  });
});
