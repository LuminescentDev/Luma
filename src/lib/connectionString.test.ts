import { describe, it, expect } from "vitest";
import { looksLikeConnectionString } from "./connectionString";

describe("looksLikeConnectionString", () => {
  it("accepts common connection-string shapes", () => {
    for (const value of [
      "example.com",
      "user@example.com",
      "user@example.com:2222",
      "ssh://user@example.com",
      "ssh://example.com:22",
      "192.168.1.10",
      "root@10.0.0.1:22",
      "[2001:db8::1]",
      "[2001:db8::1]:2222",
      "host.internal.lan",
    ]) {
      expect(looksLikeConnectionString(value), value).toBe(true);
    }
  });

  it("rejects plain search words and command-ish text", () => {
    for (const value of [
      "",
      "   ",
      "split",
      "hosts",
      "new terminal",
      "open settings",
      "server", // single bare word, no dot/colon/@/scheme
      "reconnect",
    ]) {
      expect(looksLikeConnectionString(value), value).toBe(false);
    }
  });

  it("rejects inputs containing whitespace", () => {
    expect(looksLikeConnectionString("user@ex ample.com")).toBe(false);
    expect(looksLikeConnectionString("ssh:// example.com")).toBe(false);
  });

  it("trims surrounding whitespace before evaluating", () => {
    expect(looksLikeConnectionString("  example.com  ")).toBe(true);
  });
});
