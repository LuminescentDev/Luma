import { describe, it, expect } from "vitest";
import { diffKey } from "./repoStore";

describe("diffKey", () => {
  it("is stable for identical inputs", () => {
    expect(diffKey("host", "/repo", "src/x.ts", false)).toBe(
      diffKey("host", "/repo", "src/x.ts", false),
    );
    expect(diffKey("host", "/repo", "src/x.ts", true)).toBe(
      diffKey("host", "/repo", "src/x.ts", true),
    );
  });

  it("distinguishes every input", () => {
    const base = diffKey("host", "/repo", "src/x.ts", false);
    // A different value in each position must produce a different key.
    expect(diffKey("other", "/repo", "src/x.ts", false)).not.toBe(base);
    expect(diffKey("host", "/other", "src/x.ts", false)).not.toBe(base);
    expect(diffKey("host", "/repo", "src/y.ts", false)).not.toBe(base);
    // The staged flag alone must change the key so staged and unstaged patches
    // of one file never collide in the cache.
    expect(diffKey("host", "/repo", "src/x.ts", true)).not.toBe(base);
  });

  it("keeps all four keys of one file distinct across the staged flag", () => {
    const keys = new Set([
      diffKey("a", "/r", "p", false),
      diffKey("a", "/r", "p", true),
      diffKey("b", "/r", "p", false),
      diffKey("a", "/r2", "p", false),
    ]);
    expect(keys.size).toBe(4);
  });
});
