import type { GeneratedKeyType } from "../../lib/hosts";

/*
 * Pure form logic for the "Generate key" dialog, split out so the validation
 * rules can be unit-tested without rendering. The backend (ssh_key_generate)
 * remains the source of truth; this only gates the submit button and messages.
 */

export type GenerateKeyDraft = {
  name: string;
  keyType: GeneratedKeyType;
  passphrase: string;
  confirmPassphrase: string;
  comment: string;
};

export function emptyGenerateKeyDraft(): GenerateKeyDraft {
  return {
    name: "",
    keyType: "ed25519",
    passphrase: "",
    confirmPassphrase: "",
    comment: "",
  };
}

export type GenerateKeyValidation =
  | { ok: true }
  | { ok: false; error: string };

/** Validate a generate-key draft: a name is required, and when a passphrase is
 * given it must be confirmed. Returns the first blocking problem, if any. */
export function validateGenerateKey(
  draft: GenerateKeyDraft,
): GenerateKeyValidation {
  if (!draft.name.trim()) return { ok: false, error: "A name is required." };
  if (draft.passphrase !== draft.confirmPassphrase) {
    return { ok: false, error: "Passphrases do not match." };
  }
  return { ok: true };
}
