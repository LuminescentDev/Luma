import { beforeEach, describe, expect, it } from "vitest";

import { applyAnalyticsConsent, getAnalyticsConfig } from "./analytics";
import { setInvoke } from "../test/tauriMock";
import { SETTING_KEYS } from "../types";

let calls: { command: string; args: Record<string, unknown> }[] = [];

/** Records the order of the two writes; `fail` makes one command throw. */
function trackInvokes(fail?: string) {
  calls = [];
  setInvoke((command, args) => {
    calls.push({ command, args });
    if (command === fail) throw new Error("boom");
    if (command === "analytics_config") {
      return { configured: true, enabled: false, installId: null };
    }
    return undefined;
  });
}

const order = () => calls.map((call) => call.command);

beforeEach(() => trackInvokes());

describe("applyAnalyticsConsent", () => {
  it("persists before starting, so a failed start leaves the app quiet", async () => {
    await applyAnalyticsConsent(true);
    expect(order()).toEqual(["settings_set", "analytics_set_enabled"]);
    expect(calls[0].args).toMatchObject({ key: SETTING_KEYS.analytics, value: true });
    expect(calls[1].args).toMatchObject({ enabled: true });
  });

  it("stops before persisting, so a failed persist has already taken effect", async () => {
    await applyAnalyticsConsent(false);
    expect(order()).toEqual(["analytics_set_enabled", "settings_set"]);
    expect(calls[0].args).toMatchObject({ enabled: false });
    expect(calls[1].args).toMatchObject({ key: SETTING_KEYS.analytics, value: false });
  });

  it("leaves analytics off when the runtime call fails while opting in", async () => {
    trackInvokes("analytics_set_enabled");
    await expect(applyAnalyticsConsent(true)).rejects.toThrow();
    // The choice is recorded, so the next launch honours it; nothing was sent
    // in the meantime.
    expect(order()).toEqual(["settings_set", "analytics_set_enabled"]);
  });

  it("has already stopped sending when the persist fails while opting out", async () => {
    trackInvokes("settings_set");
    await expect(applyAnalyticsConsent(false)).rejects.toThrow();
    expect(order()).toEqual(["analytics_set_enabled", "settings_set"]);
  });
});

describe("getAnalyticsConfig", () => {
  it("reports availability and the user's own id, but never the endpoint", async () => {
    const info = await getAnalyticsConfig();
    expect(info).toEqual({ configured: true, enabled: false, installId: null });
    expect(JSON.stringify(info)).not.toContain("aptabase");
  });
});
