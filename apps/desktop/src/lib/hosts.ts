import { invoke } from "@tauri-apps/api/core";

/*
 * Typed invoke wrappers for the Phase 3 host / SSH backend, mirroring the style
 * of src/lib/terminal.ts. All types are camelCase; optional fields arrive as
 * `null` from the backend.
 */

export type AuthenticationType = "key" | "password" | "interactive";

/** Per-host transport preference: plain SSH (default), Mosh with automatic
 * SSH fallback ("auto"), or Mosh only. */
export type TransportType = "ssh" | "auto" | "mosh";

export type Host = {
  id: string;
  /** Vault that owns this host. Every reference it holds (group, key, identity,
   * proxy jump) is in the same vault; the backend rejects anything else. */
  vaultId: string;
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
  /** Transport preference: "ssh" (default), "auto" (Mosh with SSH fallback),
   * or "mosh" (Mosh only). */
  transport: TransportType;
  /** Optional custom remote mosh-server path (no shell metacharacters). */
  moshServerPath: string | null;
  /** Optional UDP port range for mosh-server: "N" or "N-M" (1-65535). */
  moshPortRange: string | null;
  /** True for a throwaway host created by quick-connect that has not been saved
   * to the host list. Ephemeral hosts are excluded from hosts_list / recents by
   * the backend; quick_connect_save clears this flag. */
  isEphemeral: boolean;
};

/** `vaultId` is optional on every input: the backend defaults it to the personal
 * vault, and an entity never changes vault on update. */
export type HostInput = {
  vaultId?: string;
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
  transport: TransportType;
  moshServerPath: string | null;
  moshPortRange: string | null;
};

/** Defaults a group hands down to the hosts inside it, and through `parentId`
 * to nested groups. Every field is optional: null/absent means the group sets
 * no default, so resolution keeps walking up the chain. Hosts always win over
 * groups. `authenticationType` and `keyId` are deliberately absent — see the
 * note on `host_inheritance` in the backend. */
export type HostGroupDefaults = {
  username?: string | null;
  identityId?: string | null;
  proxyJumpHostId?: string | null;
  startupCommand?: string | null;
  workingDirectory?: string | null;
  environment?: Record<string, string> | null;
  tabColor?: string | null;
  transport?: TransportType | null;
  moshServerPath?: string | null;
  moshPortRange?: string | null;
};

export type HostGroup = {
  id: string;
  vaultId: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
} & HostGroupDefaults;

export type HostGroupInput = {
  vaultId?: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
} & HostGroupDefaults;

/** Where an effective value came from: "host", "group:<id>", or "default". */
export type FieldOrigin = string;

/** Per-field provenance for an effective host. Environment variables merge per
 * name rather than replacing wholesale, so their origins are recorded per key. */
export type HostFieldOrigins = {
  username: FieldOrigin;
  identityId: FieldOrigin;
  proxyJumpHostId: FieldOrigin;
  startupCommand: FieldOrigin;
  workingDirectory: FieldOrigin;
  tabColor: FieldOrigin;
  transport: FieldOrigin;
  moshServerPath: FieldOrigin;
  moshPortRange: FieldOrigin;
  environment: Record<string, FieldOrigin>;
};

export type EffectiveHostConfig = {
  /** The host with group defaults applied. Never write this back through
   * `updateHost`: it would bake inherited values into the host row. */
  host: Host;
  origins: HostFieldOrigins;
};

/** The group an inherited value came from, or null when the value is the
 * host's own or is not set anywhere. */
export function inheritedGroupId(origin: FieldOrigin | undefined): string | null {
  return origin?.startsWith("group:") ? origin.slice("group:".length) : null;
}

export type KeyStorageMode = "local-path" | "encrypted-vault";

export type KeyReference = {
  id: string;
  vaultId: string;
  name: string;
  publicKey: string | null;
  storageMode: KeyStorageMode;
  localPath: string | null;
  fingerprint: string | null;
  certificate: string | null;
  hasPrivateKey: boolean;
};

export type KeyReferenceInput = {
  vaultId?: string;
  name: string;
  publicKey: string | null;
  storageMode: KeyStorageMode;
  localPath: string | null;
  fingerprint: string | null;
  certificate: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
};

export type Identity = { id: string; vaultId: string; name: string; username: string; keyId: string | null; hasPassword: boolean };
export type IdentityInput = { vaultId?: string; name: string; username: string; keyId: string | null; password: string | null };

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
    vaultId: host.vaultId,
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
    transport: host.transport,
    moshServerPath: host.moshServerPath,
    moshPortRange: host.moshPortRange,
  };
}

// Hosts ---------------------------------------------------------------------

/** Omitting `vaultId` lists across every vault. */
export function listHosts(vaultId?: string): Promise<Host[]> {
  return invoke<Host[]>("hosts_list", { vaultId: vaultId ?? null });
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
/** Quick-connect hosts are created in the personal vault; saving one is the
 * only point a host changes vault, since it holds no references yet. */
export function quickConnectSave(
  hostId: string,
  name?: string | null,
  vaultId?: string,
): Promise<Host> {
  return invoke<Host>("quick_connect_save", {
    hostId,
    name: name ?? null,
    vaultId: vaultId ?? null,
  });
}

// Host groups ---------------------------------------------------------------

export function listHostGroups(vaultId?: string): Promise<HostGroup[]> {
  return invoke<HostGroup[]>("host_groups_list", { vaultId: vaultId ?? null });
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

// Group-level inheritance ----------------------------------------------------

/** Resolve a stored host through its group chain: what a connection will
 * actually use, plus where each field came from. */
export function hostEffectiveConfig(hostId: string): Promise<EffectiveHostConfig | null> {
  return invoke<EffectiveHostConfig | null>("host_effective_config", {
    id: hostId,
    groupId: null,
  });
}

/** What a host that overrides nothing would inherit from `groupId`. The editor
 * asks this for whichever group is selected in the form, so the inherited /
 * overridden hints follow the picker instead of the last saved group. */
export function groupInheritedDefaults(
  groupId: string | null,
): Promise<EffectiveHostConfig | null> {
  return invoke<EffectiveHostConfig | null>("host_effective_config", {
    id: null,
    groupId,
  });
}

// Key references ------------------------------------------------------------

export function listKeyReferences(vaultId?: string): Promise<KeyReference[]> {
    return invoke<KeyReference[]>("key_references_list", { vaultId: vaultId ?? null });
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
export function generateSshKey(name: string, localPath: string, passphrase: string, certificate: string | null, vaultId?: string): Promise<KeyReference> { return invoke<KeyReference>("ssh_key_generate", { input: { vaultId, name, localPath, passphrase, certificate } }); }

/** SSH key algorithms Luma can generate into the encrypted keystore. */
export type GeneratedKeyType = "ed25519" | "rsa4096";

/** Generate a new SSH key pair stored in the encrypted keystore. The keystore
 * must be configured and unlocked first. Returns a KeyReference with the derived
 * publicKey + fingerprint (storageMode "encrypted-vault", localPath null).
 * Rejects with invalid-input / keystore-locked / database. */
export function generateKeystoreSshKey(input: {
  vaultId?: string;
  keyType: GeneratedKeyType;
  name: string;
  passphrase?: string | null;
  comment?: string | null;
}): Promise<KeyReference> {
  return invoke<KeyReference>("ssh_key_generate", {
    vaultId: input.vaultId ?? null,
    keyType: input.keyType,
    name: input.name,
    passphrase: input.passphrase ?? null,
    comment: input.comment ?? null,
  });
}

export const listIdentities = (vaultId?: string) =>
  invoke<Identity[]>("identities_list", { vaultId: vaultId ?? null });
export const createIdentity = (input: IdentityInput) => invoke<Identity>("identity_create", { input });
export const updateIdentity = (id: string, input: IdentityInput) => invoke<Identity>("identity_update", { id, input });
export const deleteIdentity = (id: string) => invoke<void>("identity_delete", { id });

// SSH availability + config import ------------------------------------------

/** `alreadyExists` is decided within the target vault, so the preview must use
 * the same vault the import will write to. */
export function previewSshConfig(vaultId?: string): Promise<SshConfigCandidate[]> {
  return invoke<SshConfigCandidate[]>("ssh_config_preview", { vaultId: vaultId ?? null });
}

export function importSshConfig(
  selectedNames: string[],
  vaultId?: string,
): Promise<SshImportResult> {
  return invoke<SshImportResult>("ssh_config_import", {
    request: { vaultId, selectedNames },
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
  vaultId?: string,
): Promise<ImportedHostCandidate[]> {
  return invoke<ImportedHostCandidate[]>("import_hosts_preview", {
    source,
    path,
    vaultId: vaultId ?? null,
  });
}

/** Import the selected hosts from a Tabby/Electerm export. `selectedNames`
 * must reference candidates still present in the file (max 500, no dupes);
 * an empty selection imports nothing. */
export function applyImportHosts(
  source: ImportSource,
  path: string,
  selectedNames: string[],
  vaultId?: string,
): Promise<ImportedHostsResult> {
  return invoke<ImportedHostsResult>("import_hosts_apply", {
    source,
    path,
    request: { vaultId, selectedNames },
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

export type KeystoreStatus = { configured: boolean; unlocked: boolean; rememberOnDevice: boolean };
export const getKeystoreStatus = () => invoke<KeystoreStatus>("keystore_status");
export const setupKeystore = (password: string, rememberDevice: boolean) => invoke<void>("keystore_setup", { input: { password, rememberDevice } });
export const unlockKeystore = (password: string) => invoke<void>("keystore_unlock", { password });
export const lockKeystore = () => invoke<void>("keystore_lock");
export const setKeystorePolicy = (rememberDevice: boolean) => invoke<void>("keystore_set_policy", { rememberDevice });
