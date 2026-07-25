import { invoke } from "@tauri-apps/api/core";

/*
 * Typed invoke wrappers for the Phase 3 host / SSH backend, mirroring the style
 * of src/lib/terminal.ts. All types are camelCase; optional fields arrive as
 * `null` from the backend.
 */

export type AuthenticationType = "agent" | "key" | "password" | "interactive";

export type Host = {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string | null;
  groupId: string | null;
  authenticationType: AuthenticationType;
  keyId: string | null;
  identityId: string | null;
  proxyJumpHostId: string | null;
  startupCommand: string | null;
  workingDirectory: string | null;
  environment: Record<string, string> | null;
  tags: string[];
  favorite: boolean;
  /** Best-effort device-local metadata learned after a successful connection. */
  osId: string | null;
  osPrettyName: string | null;
  /** Per-host tab accent color as "#RRGGBB", or null for no accent. The backend
   * only accepts null or a "#RRGGBB" string. */
  tabColor: string | null;
  /** True for a throwaway host created by quick-connect that has not been saved
   * to the host list. Ephemeral hosts are excluded from hosts_list / recents by
   * the backend; quick_connect_save clears this flag. */
  isEphemeral: boolean;
};

export type HostInput = {
  name: string;
  hostname: string;
  port: number;
  username: string | null;
  groupId: string | null;
  authenticationType: AuthenticationType;
  keyId: string | null;
  identityId: string | null;
  proxyJumpHostId: string | null;
  startupCommand: string | null;
  workingDirectory: string | null;
  environment: Record<string, string> | null;
  tags: string[];
  favorite: boolean;
  /** Per-host tab accent color as "#RRGGBB", or null for no accent. */
  tabColor: string | null;
};

export type HostGroup = {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
};

export type HostGroupInput = {
  name: string;
  parentId: string | null;
  sortOrder: number;
};

export type KeyStorageMode = "local-path" | "encrypted-vault" | "ssh-agent";

export type KeyReference = {
  id: string;
  name: string;
  publicKey: string | null;
  storageMode: KeyStorageMode;
  localPath: string | null;
  fingerprint: string | null;
  certificate: string | null;
  hasPrivateKey: boolean;
};

export type KeyReferenceInput = {
  name: string;
  publicKey: string | null;
  storageMode: KeyStorageMode;
  localPath: string | null;
  fingerprint: string | null;
  certificate: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
};

export type Identity = { id: string; name: string; username: string; keyId: string | null; hasPassword: boolean };
export type IdentityInput = { name: string; username: string; keyId: string | null; password: string | null };

export type SshDetect = {
  available: boolean;
  path: string | null;
  version: string | null;
};

export type SshConfigCandidate = {
  name: string;
  hostname: string;
  port: number;
  username: string | null;
  identityFile: string | null;
  proxyJump: string | null;
  alreadyExists: boolean;
};

export type SshImportResult = {
  importedHosts: Host[];
  skippedExisting: string[];
};

/** Build a HostInput from an existing Host (drops the id). Handy for edit /
 * duplicate / favorite-toggle updates where the whole record is resubmitted. */
export function hostToInput(host: Host): HostInput {
  return {
    name: host.name,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    groupId: host.groupId,
    authenticationType: host.authenticationType,
    keyId: host.keyId,
    identityId: host.identityId,
    proxyJumpHostId: host.proxyJumpHostId,
    startupCommand: host.startupCommand,
    workingDirectory: host.workingDirectory,
    environment: host.environment,
    tags: host.tags,
    favorite: host.favorite,
    tabColor: host.tabColor,
  };
}

// Hosts ---------------------------------------------------------------------

export function listHosts(): Promise<Host[]> {
  return invoke<Host[]>("hosts_list", {});
}

export function getHost(id: string): Promise<Host | null> {
  return invoke<Host | null>("host_get", { id });
}

export function createHost(input: HostInput): Promise<Host> {
  return invoke<Host>("host_create", { input });
}

export function updateHost(id: string, input: HostInput): Promise<Host> {
  return invoke<Host>("host_update", { id, input });
}

export function deleteHost(id: string): Promise<void> {
  return invoke<void>("host_delete", { id });
}

export function duplicateHost(id: string): Promise<Host> {
  return invoke<Host>("host_duplicate", { id });
}

export function listRecentHosts(): Promise<Host[]> {
  return invoke<Host[]>("recent_hosts_list", {});
}

// Quick connect --------------------------------------------------------------

/** Parse a connection string ([ssh://][user@]host[:port], bracketed IPv6, port
 * default 22) into a throwaway ephemeral Host. The returned hostId flows through
 * the normal connect pipeline (host-key preflight + ssh_spawn) unchanged.
 * Rejects with invalid-input / database. */
export function quickConnectPrepare(input: string): Promise<Host> {
  return invoke<Host>("quick_connect_prepare", { input });
}

/** Promote an ephemeral quick-connect host into a saved host (clears
 * isEphemeral). `name` defaults to the backend-derived label when null.
 * Rejects with invalid-input / database. */
export function quickConnectSave(
  hostId: string,
  name?: string | null,
): Promise<Host> {
  return invoke<Host>("quick_connect_save", { hostId, name: name ?? null });
}

// Host groups ---------------------------------------------------------------

export function listHostGroups(): Promise<HostGroup[]> {
  return invoke<HostGroup[]>("host_groups_list", {});
}

export function createHostGroup(input: HostGroupInput): Promise<HostGroup> {
  return invoke<HostGroup>("host_group_create", { input });
}

export function updateHostGroup(id: string, input: HostGroupInput): Promise<HostGroup> {
  return invoke<HostGroup>("host_group_update", { id, input });
}

export function deleteHostGroup(id: string): Promise<void> {
  return invoke<void>("host_group_delete", { id });
}

// Key references ------------------------------------------------------------

export function listKeyReferences(): Promise<KeyReference[]> {
    return invoke<KeyReference[]>("key_references_list", {});
}

export type KeyReferenceSecrets = { privateKey: string | null; passphrase: string | null };
export function getKeyReferenceSecrets(id: string): Promise<KeyReferenceSecrets> {
  return invoke<KeyReferenceSecrets>("key_reference_secrets", { id });
}

/** Authoritative public key + fingerprint derived from a private key by the
 * backend. The frontend must display these instead of any free-text public
 * key so it can never show/export a public key that mismatches the private
 * key Luma actually signs with. */
export type DerivedPublicKey = { publicKey: string; fingerprint: string };

/** Derive the authoritative public key (single-line authorized_keys form) and
 * SHA256 fingerprint from a private key. Rejects with an `invalid-input`
 * LumaError (parse via `parseLumaError`) when the key is unparseable, or when
 * an encrypted PKCS#8 key needs / was given the wrong passphrase. Encrypted
 * OpenSSH keys derive their public half without a passphrase, so callers need
 * not supply one just to derive. */
export function derivePublicKey(privateKey: string, passphrase?: string): Promise<DerivedPublicKey> {
  return invoke<DerivedPublicKey>("derive_public_key", { privateKey, passphrase: passphrase ?? null });
}

export function createKeyReference(input: KeyReferenceInput): Promise<KeyReference> {
  return invoke<KeyReference>("key_reference_create", { input });
}

export function updateKeyReference(
  id: string,
  input: KeyReferenceInput,
): Promise<KeyReference> {
  return invoke<KeyReference>("key_reference_update", { id, input });
}

export function deleteKeyReference(id: string): Promise<void> {
  return invoke<void>("key_reference_delete", { id });
}
export function generateSshKey(name: string, localPath: string, passphrase: string, certificate: string | null): Promise<KeyReference> { return invoke<KeyReference>("ssh_key_generate", { input: { name, localPath, passphrase, certificate } }); }

/** SSH key algorithms Luma can generate into the encrypted vault. */
export type GeneratedKeyType = "ed25519" | "rsa4096";

/** Generate a new SSH key pair stored in the encrypted vault. The vault must be
 * configured and unlocked first. Returns a KeyReference with the derived
 * publicKey + fingerprint (storageMode "encrypted-vault", localPath null).
 * Rejects with invalid-input / vault-locked / database. */
export function generateVaultSshKey(input: {
  keyType: GeneratedKeyType;
  name: string;
  passphrase?: string | null;
  comment?: string | null;
}): Promise<KeyReference> {
  return invoke<KeyReference>("ssh_key_generate", {
    keyType: input.keyType,
    name: input.name,
    passphrase: input.passphrase ?? null,
    comment: input.comment ?? null,
  });
}

export const listIdentities = () => invoke<Identity[]>("identities_list", {});
export const createIdentity = (input: IdentityInput) => invoke<Identity>("identity_create", { input });
export const updateIdentity = (id: string, input: IdentityInput) => invoke<Identity>("identity_update", { id, input });
export const deleteIdentity = (id: string) => invoke<void>("identity_delete", { id });

// SSH availability + config import ------------------------------------------

export function detectSsh(): Promise<SshDetect> {
  return invoke<SshDetect>("ssh_detect", {});
}

export function previewSshConfig(): Promise<SshConfigCandidate[]> {
  return invoke<SshConfigCandidate[]>("ssh_config_preview", {});
}

export function importSshConfig(selectedNames: string[]): Promise<SshImportResult> {
  return invoke<SshImportResult>("ssh_config_import", {
    request: { selectedNames },
  });
}

// Third-party host import (Tabby / Electerm) --------------------------------

/** External clients whose SSH host lists Luma can import. */
export type ImportSource = "tabby" | "electerm";

/** Best-effort authentication method detected for an imported candidate. */
export type ImportedHostAuthHint =
  | "password"
  | "public-key"
  | "agent"
  | "keyboard-interactive"
  | "unknown";

export type ImportedHostCandidate = {
  name: string;
  hostname: string;
  port: number;
  username: string | null;
  group: string | null;
  authHint: ImportedHostAuthHint;
  alreadyExists: boolean;
};

export type ImportedHostsResult = {
  importedHosts: Host[];
  createdGroups: string[];
  skippedExisting: string[];
};

/** Preview the SSH hosts contained in a Tabby (.yaml) or Electerm (.json)
 * export at `path`. The frontend passes only the absolute path; the backend
 * reads the file — file contents never enter frontend state. */
export function previewImportHosts(
  source: ImportSource,
  path: string,
): Promise<ImportedHostCandidate[]> {
  return invoke<ImportedHostCandidate[]>("import_hosts_preview", { source, path });
}

/** Import the selected hosts from a Tabby/Electerm export. `selectedNames`
 * must reference candidates still present in the file (max 500, no dupes);
 * an empty selection imports nothing. */
export function applyImportHosts(
  source: ImportSource,
  path: string,
  selectedNames: string[],
): Promise<ImportedHostsResult> {
  return invoke<ImportedHostsResult>("import_hosts_apply", {
    source,
    path,
    request: { selectedNames },
  });
}

/** Normalize a rejected command error ({ category, message }) into a usable
 * shape. Backend command errors reject with this structure; unexpected errors
 * are surfaced with a generic category. */
export function parseLumaError(error: unknown): { category: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const record = error as { category?: unknown; message?: unknown };
    if (typeof record.category === "string" && typeof record.message === "string") {
      return { category: record.category, message: record.message };
    }
    if (typeof record.message === "string") {
      return { category: "unknown", message: record.message };
    }
  }
  return { category: "unknown", message: String(error) };
}

export type VaultStatus = { configured: boolean; unlocked: boolean; rememberOnDevice: boolean };
export const getVaultStatus = () => invoke<VaultStatus>("vault_status");
export const setupVault = (password: string, rememberDevice: boolean) => invoke<void>("vault_setup", { input: { password, rememberDevice } });
export const unlockVault = (password: string) => invoke<void>("vault_unlock", { password });
export const lockVault = () => invoke<void>("vault_lock");
export const setVaultPolicy = (rememberDevice: boolean) => invoke<void>("vault_set_policy", { rememberDevice });
