import { invoke } from "@tauri-apps/api/core";
import type { SyncProvider } from "./sync";

/*
 * Typed invoke wrappers for vaults: named scopes that own hosts, groups, key
 * references, identities and snippets. Vault ids are device-local — two devices
 * syncing the same remote each keep their own id for it.
 */

/** The vault every pre-existing entity was migrated into, and the only one that
 * syncs settings and terminal profiles. Seeded by the schema on every device. */
export const PERSONAL_VAULT_ID = "personal";

export type VaultKind = "personal" | "shared" | "managed";

export type Vault = {
  id: string;
  name: string;
  /**
   * `shared` vaults are unlocked with a passphrase the members pass around
   * themselves; `managed` vaults get their key from Luma Cloud, sealed to each
   * member device. The difference is only how the key is obtained — the bundle
   * format and merge behaviour are identical.
   */
  kind: VaultKind;
  /** When true, this vault's bundle carries private keys and identity
   * passwords, handing them to every member permanently. Surface this in the
   * UI: sharing secrets is only for people the user trusts. */
  shareSecrets: boolean;
  sortOrder: number;
  /** Server-side identity, set only for `managed` vaults. */
  remoteVaultId: string | null;
  /** Which generation of the content key this device holds. */
  keyEpoch: number;
};

export type VaultInvite = {
  id: string;
  /** Bearer token. Anyone holding it can join at the invite's role. */
  secret: string;
  expiresAt: number;
  role: VaultRole;
};

export type VaultRole = "writer" | "reader";

export type VaultInput = {
  name: string;
  shareSecrets: boolean;
  sortOrder: number;
};

/** Personal vault first, then by sortOrder and name. */
export function listVaults(): Promise<Vault[]> {
  return invoke<Vault[]>("vaults_list");
}

export function getVault(id: string): Promise<Vault | null> {
  return invoke<Vault | null>("vault_get", { id });
}

/** Created vaults are always `kind: "shared"`; the personal vault is seeded by
 * the schema and cannot be created or deleted. */
export function createVault(input: VaultInput): Promise<Vault> {
  return invoke<Vault>("vault_create", { input });
}

export function updateVault(id: string, input: VaultInput): Promise<Vault> {
  return invoke<Vault>("vault_update", { id, input });
}

/** Removes the vault and everything scoped to it, including the secrets its
 * keys and identities own. Rejects with invalid-input for the personal vault. */
export function deleteVault(id: string): Promise<void> {
  return invoke<void>("vault_delete", { id });
}

// Managed vaults ------------------------------------------------------------

/**
 * Create a vault whose key Luma Cloud distributes to member devices. The
 * content key is generated and sealed in Rust — it is never exposed here.
 */
export function createManagedVault(input: {
  name: string;
  cloudUrl: string;
  shareSecrets: boolean;
}): Promise<Vault> {
  return invoke<Vault>("vault_create_managed", input);
}

/** Redeem an invite. The vault appears immediately, but stays unreadable until
 * an existing member's app seals the key to this device. */
export function joinManagedVault(input: {
  name: string;
  cloudUrl: string;
  inviteSecret: string;
}): Promise<Vault> {
  return invoke<Vault>("vault_join_managed", input);
}

export function createVaultInvite(input: {
  id: string;
  cloudUrl: string;
  role: VaultRole;
}): Promise<VaultInvite> {
  return invoke<VaultInvite>("vault_create_invite", input);
}

/** Revoke a member and rotate the key. Rotation stops them reading anything
 * written afterwards; it cannot retract what they already hold. */
export function removeVaultMember(input: {
  id: string;
  cloudUrl: string;
  subject: string;
}): Promise<void> {
  return invoke<void>("vault_remove_member", input);
}

// Join links ----------------------------------------------------------------

/**
 * Where a vault lives, as carried by a `luma://vault?…` link.
 *
 * For a passphrase-shared vault a link is *not* an access grant: it names a
 * location, nothing more. Reading it also needs the passphrase, and
 * WebDAV/Gist need their own account credentials. Those are secrets, so they
 * are never in the link — the person joining types them.
 *
 * A managed vault is the exception, and the one case where a link *is* a
 * grant: `inviteSecret` is a bearer token the server accepts, so such a link
 * must be sent over a private channel and expires with the invite. Anything
 * displaying a link has to distinguish the two — see `linkIsSensitive`.
 */
export type VaultJoinLink = {
  name: string;
  provider: SyncProvider;
  /** managed only: a bearer token. Treat a link carrying this as a secret. */
  inviteSecret: string | null;
  /** local-folder */
  folderPath: string | null;
  /** webdav */
  url: string | null;
  username: string | null;
  /** github-gist */
  gistId: string | null;
  /** luma-cloud */
  cloudUrl: string | null;
};

/** Whether this link grants access by itself, and so must not be posted
 * anywhere the vault's members would not be welcome. */
export function linkIsSensitive(link: VaultJoinLink): boolean {
  return link.inviteSecret !== null;
}

const JOIN_PROVIDERS: SyncProvider[] = [
  "local-folder",
  "webdav",
  "github-gist",
  "luma-cloud",
];

/** Build a shareable `luma://vault?…` link. Throws when the vault's provider
 * has no location configured yet. */
export function buildVaultJoinLink(link: VaultJoinLink): string {
  const params = new URLSearchParams({ name: link.name, provider: link.provider });
  const location =
    link.provider === "local-folder"
      ? (["path", link.folderPath] as const)
      : link.provider === "webdav"
        ? (["url", link.url] as const)
        : link.provider === "github-gist"
          ? (["gistId", link.gistId] as const)
          : (["cloudUrl", link.cloudUrl] as const);
  if (!location[1]) {
    throw new Error("This vault's sync provider has no location configured yet.");
  }
  params.set(location[0], location[1]);
  if (link.provider === "webdav" && link.username) params.set("username", link.username);
  if (link.inviteSecret) params.set("invite", link.inviteSecret);
  return `luma://vault?${params.toString()}`;
}

/** Parse a `luma://vault?…` link. Returns null when the input is not a vault
 * link at all; throws with a user-facing message when it is one but malformed. */
export function parseVaultJoinLink(raw: string): VaultJoinLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "luma:" || url.host !== "vault") return null;

  const provider = url.searchParams.get("provider") as SyncProvider | null;
  if (!provider || !JOIN_PROVIDERS.includes(provider)) {
    throw new Error("This vault link names a sync provider Luma does not support.");
  }

  const link: VaultJoinLink = {
    name: url.searchParams.get("name")?.trim() || "Shared vault",
    provider,
    inviteSecret: url.searchParams.get("invite"),
    folderPath: url.searchParams.get("path"),
    url: url.searchParams.get("url"),
    username: url.searchParams.get("username"),
    gistId: url.searchParams.get("gistId"),
    cloudUrl: url.searchParams.get("cloudUrl"),
  };

  const located =
    provider === "local-folder"
      ? link.folderPath
      : provider === "webdav"
        ? link.url
        : provider === "github-gist"
          ? link.gistId
          : link.cloudUrl;
  if (!located) throw new Error("This vault link is missing the vault's location.");

  return link;
}
