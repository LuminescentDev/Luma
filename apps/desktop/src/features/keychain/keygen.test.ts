import { describe, it, expect } from "vitest";
import {
  emptyGenerateKeyDraft,
  validateGenerateKey,
  type GenerateKeyDraft,
} from "./keygen";

function draft(overrides: Partial<GenerateKeyDraft> = {}): GenerateKeyDraft {
  return { ...emptyGenerateKeyDraft(), name: "personal", ...overrides };
}

describe("validateGenerateKey", () => {
  it("defaults to an ed25519 key with empty fields", () => {
    expect(emptyGenerateKeyDraft().keyType).toBe("ed25519");
  });

  it("requires a name", () => {
    expect(validateGenerateKey(draft({ name: "" }))).toEqual({
      ok: false,
      error: "A name is required.",
    });
    expect(validateGenerateKey(draft({ name: "   " })).ok).toBe(false);
  });

  it("accepts a valid name with no passphrase", () => {
    expect(validateGenerateKey(draft())).toEqual({ ok: true });
  });

  it("requires matching passphrase confirmation", () => {
    expect(
      validateGenerateKey(draft({ passphrase: "a", confirmPassphrase: "b" })),
    ).toEqual({ ok: false, error: "Passphrases do not match." });
  });

  it("accepts a matching passphrase pair", () => {
    expect(
      validateGenerateKey(
        draft({ passphrase: "secret", confirmPassphrase: "secret" }),
      ),
    ).toEqual({ ok: true });
  });
});
