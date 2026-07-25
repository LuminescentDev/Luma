import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const requiredEnvironment = {
  DATABASE_URL: "postgresql://localhost/luma",
  REDIS_URL: "redis://localhost:6379",
  JWT_ISSUER: "https://identity.example/",
  JWT_AUDIENCE: "luma",
  JWT_JWKS_URL: "https://identity.example/.well-known/jwks.json",
  OIDC_CLIENT_ID: "native-client",
  OIDC_DEVICE_AUTHORIZATION_ENDPOINT: "https://identity.example/device",
  OIDC_TOKEN_ENDPOINT: "https://identity.example/token",
  R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  R2_BUCKET: "luma",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
};

describe("collaboration server configuration", () => {
  it("applies bounded production defaults", () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.port).toBe(8788);
    expect(config.maxEventBytes).toBe(262_144);
    expect(config.maxSnapshotBytes).toBe(67_108_864);
    expect(config.websocketMessagesPerSecond).toBe(100);
  });

  it("fails closed when infrastructure credentials are absent", () => {
    expect(() => loadConfig({ ...requiredEnvironment, REDIS_URL: "" })).toThrow(
      "REDIS_URL is required",
    );
  });
});
