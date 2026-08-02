import { describe, expect, it } from "vitest";

import { analyticsEnabled, shouldPromptForAnalytics } from "./analyticsConsent";
import { SETTING_KEYS } from "../../types";

const READY = { configured: true, capabilitiesLoaded: true };

describe("shouldPromptForAnalytics", () => {
  it("prompts an existing user, whose settings have no consent key", () => {
    // The upgrade path: nobody has ever had this key, so its absence is what
    // makes existing users see the prompt exactly once.
    expect(shouldPromptForAnalytics({}, READY)).toBe(true);
  });

  it("does not prompt once a choice has been made either way", () => {
    expect(shouldPromptForAnalytics({ [SETTING_KEYS.analytics]: true }, READY)).toBe(false);
    expect(shouldPromptForAnalytics({ [SETTING_KEYS.analytics]: false }, READY)).toBe(false);
  });

  it("waits for the settings query to resolve", () => {
    expect(shouldPromptForAnalytics(undefined, READY)).toBe(false);
  });

  it("stays silent in a build with no ingest endpoint", () => {
    expect(shouldPromptForAnalytics({}, { ...READY, configured: false })).toBe(false);
  });

  it("waits for capabilities so the desktop dialog cannot flash on a phone", () => {
    expect(shouldPromptForAnalytics({}, { ...READY, capabilitiesLoaded: false })).toBe(false);
  });
});

describe("analyticsEnabled", () => {
  it("treats an undecided user as opted out", () => {
    // Not the `!== false` default-on idiom used by the other settings; this
    // test fails if someone "corrects" it to match.
    expect(analyticsEnabled({})).toBe(false);
    expect(analyticsEnabled(undefined)).toBe(false);
  });

  it("reads an explicit choice", () => {
    expect(analyticsEnabled({ [SETTING_KEYS.analytics]: true })).toBe(true);
    expect(analyticsEnabled({ [SETTING_KEYS.analytics]: false })).toBe(false);
  });
});
