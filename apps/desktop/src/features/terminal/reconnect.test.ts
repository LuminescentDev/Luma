import { describe, it, expect } from "vitest";
import {
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_CAP_MS,
  backoffBaseDelay,
  backoffDelay,
  isReconnectableCategory,
  latencyTone,
  planReconnect,
} from "./reconnect";

describe("isReconnectableCategory", () => {
  it("retries transient connectivity failures", () => {
    for (const c of ["connection-lost", "host-unreachable", "dns-failed", "timeout"]) {
      expect(isReconnectableCategory(c)).toBe(true);
    }
  });

  it("never retries auth / host-key / key failures", () => {
    for (const c of [
      "auth-failed",
      "host-key-changed",
      "host-key-rejected",
      "key-unavailable",
      "ssh-error",
    ]) {
      expect(isReconnectableCategory(c)).toBe(false);
    }
  });

  it("treats null/undefined as non-reconnectable (clean exit)", () => {
    expect(isReconnectableCategory(null)).toBe(false);
    expect(isReconnectableCategory(undefined)).toBe(false);
  });
});

describe("backoff schedule", () => {
  it("doubles from 1s and caps at 30s", () => {
    expect(backoffBaseDelay(1)).toBe(1_000);
    expect(backoffBaseDelay(2)).toBe(2_000);
    expect(backoffBaseDelay(3)).toBe(4_000);
    expect(backoffBaseDelay(4)).toBe(8_000);
    expect(backoffBaseDelay(5)).toBe(16_000);
    // Beyond attempt 5 the exponential would exceed the cap.
    expect(backoffBaseDelay(6)).toBe(RECONNECT_CAP_MS);
    expect(backoffBaseDelay(50)).toBe(RECONNECT_CAP_MS);
  });

  it("applies symmetric jitter within +/-25% of base", () => {
    // rng at extremes and midpoint (deterministic).
    expect(backoffDelay(3, () => 0)).toBe(3_000); // base 4000 - 25%
    expect(backoffDelay(3, () => 1)).toBe(5_000); // base 4000 + 25%
    expect(backoffDelay(3, () => 0.5)).toBe(4_000); // no jitter
  });

  it("never returns a negative delay", () => {
    expect(backoffDelay(1, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe("planReconnect", () => {
  const rng = () => 0.5; // no jitter, deterministic

  it("returns null when auto-reconnect is disabled", () => {
    expect(planReconnect("timeout", false, 0, rng)).toBeNull();
  });

  it("returns null for a non-reconnectable category", () => {
    expect(planReconnect("auth-failed", true, 0, rng)).toBeNull();
  });

  it("schedules the first attempt on a transient failure", () => {
    expect(planReconnect("timeout", true, 0, rng)).toEqual({
      attempt: 1,
      delayMs: 1_000,
    });
  });

  it("increments the attempt and grows the delay", () => {
    expect(planReconnect("host-unreachable", true, 1, rng)).toEqual({
      attempt: 2,
      delayMs: 2_000,
    });
    expect(planReconnect("host-unreachable", true, 2, rng)).toEqual({
      attempt: 3,
      delayMs: 4_000,
    });
  });

  it("gives up after the maximum number of attempts", () => {
    // previousAttempt at the cap means the next would exceed the max.
    expect(
      planReconnect("timeout", true, MAX_RECONNECT_ATTEMPTS, rng),
    ).toBeNull();
  });

  it("allows the final attempt exactly at the boundary", () => {
    const plan = planReconnect("timeout", true, MAX_RECONNECT_ATTEMPTS - 1, rng);
    expect(plan?.attempt).toBe(MAX_RECONNECT_ATTEMPTS);
  });
});

describe("latencyTone thresholds", () => {
  it("maps latency to color buckets", () => {
    expect(latencyTone(0)).toBe("good");
    expect(latencyTone(79)).toBe("good");
    expect(latencyTone(80)).toBe("fair");
    expect(latencyTone(299)).toBe("fair");
    expect(latencyTone(300)).toBe("poor");
    expect(latencyTone(5_000)).toBe("poor");
  });
});
