import { HttpError } from "./auth";
import type { Env, Vault, VaultMembership, VaultRole } from "./types";

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_ENVELOPE_BYTES = 8 * 1024;
const MAX_PUBLIC_KEY_BYTES = 2 * 1024;
const MAX_KEYS_PER_REQUEST = 64;

const VAULT_COLUMNS =
  "id, owner_subject, storage_id, key_epoch, used_bytes, deleted_at";

export async function createVault(env: Env, subject: string): Promise<Vault> {
  const id = crypto.randomUUID();
  const storageId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO vaults (id, owner_subject, storage_id) VALUES (?1, ?2, ?3)`,
  )
    .bind(id, subject, storageId)
    .run();
  await env.DB.prepare(
    `INSERT INTO vault_members (vault_id, subject, role) VALUES (?1, ?2, 'owner')`,
  )
    .bind(id, subject)
    .run();

  const vault = await loadVault(env, id);
  if (!vault) throw new HttpError(500, "vault creation failed");
  return vault;
}

export async function listMemberships(
  env: Env,
  subject: string,
): Promise<{ id: string; role: VaultRole; keyEpoch: number; ownerSubject: string }[]> {
  const result = await env.DB.prepare(
    `SELECT v.id AS id, m.role AS role, v.key_epoch AS key_epoch,
            v.owner_subject AS owner_subject
     FROM vault_members m
     JOIN vaults v ON v.id = m.vault_id
     WHERE m.subject = ?1 AND m.revoked_at IS NULL AND v.deleted_at IS NULL
     ORDER BY v.created_at`,
  )
    .bind(subject)
    .all<{
      id: string;
      role: VaultRole;
      key_epoch: number;
      owner_subject: string;
    }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    role: row.role,
    keyEpoch: row.key_epoch,
    ownerSubject: row.owner_subject,
  }));
}

async function loadVault(env: Env, id: string): Promise<Vault | null> {
  return await env.DB.prepare(
    `SELECT ${VAULT_COLUMNS} FROM vaults WHERE id = ?1 AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<Vault>();
}

/**
 * Resolve the caller's live role in a vault. A non-member gets 404 rather than
 * 403 so vault ids cannot be probed for existence.
 */
export async function requireMembership(
  env: Env,
  vaultId: string,
  subject: string,
): Promise<VaultMembership> {
  const vault = await loadVault(env, vaultId);
  if (!vault) throw new HttpError(404, "vault not found");

  const member = await env.DB.prepare(
    `SELECT role FROM vault_members
     WHERE vault_id = ?1 AND subject = ?2 AND revoked_at IS NULL`,
  )
    .bind(vaultId, subject)
    .first<{ role: VaultRole }>();
  if (!member) throw new HttpError(404, "vault not found");

  return { vault, role: member.role };
}

export function requireRole(
  membership: VaultMembership,
  ...allowed: VaultRole[]
): void {
  if (!allowed.includes(membership.role)) {
    throw new HttpError(403, `this vault is shared with you as a ${membership.role}`);
  }
}

export async function createInvite(
  env: Env,
  vault: Vault,
  subject: string,
  role: VaultRole,
): Promise<{ id: string; secret: string; expiresAt: number; role: VaultRole }> {
  if (role !== "writer" && role !== "reader") {
    throw new HttpError(400, "role must be 'writer' or 'reader'");
  }
  const secret = randomSecret();
  const id = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS;
  await env.DB.prepare(
    `INSERT INTO vault_invites
       (id, vault_id, secret_hash, role, key_epoch, created_by_subject, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, vault.id, await hashSecret(secret), role, vault.key_epoch, subject, expiresAt)
    .run();
  return { id, secret, expiresAt, role };
}

/**
 * Redeem an invite. The new member can read and write the blob immediately, but
 * cannot decrypt it until an existing member seals the content key to one of
 * their devices — the server never holds the key to do that itself.
 */
export async function joinVault(
  env: Env,
  subject: string,
  secret: string,
): Promise<{ vaultId: string; role: VaultRole; keyEpoch: number }> {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new HttpError(400, "invite secret is required");
  }
  const invite = await env.DB.prepare(
    `SELECT id, vault_id, role, key_epoch, expires_at, revoked_at
     FROM vault_invites WHERE secret_hash = ?1`,
  )
    .bind(await hashSecret(secret))
    .first<{
      id: string;
      vault_id: string;
      role: VaultRole;
      key_epoch: number;
      expires_at: number;
      revoked_at: number | null;
    }>();
  const now = Math.floor(Date.now() / 1000);
  if (!invite || invite.revoked_at !== null || invite.expires_at <= now) {
    throw new HttpError(404, "invite is invalid or has expired");
  }

  const vault = await loadVault(env, invite.vault_id);
  if (!vault) throw new HttpError(404, "invite is invalid or has expired");
  if (vault.owner_subject === subject) {
    throw new HttpError(409, "you already own this vault");
  }

  // Re-joining after removal restores access at the current epoch, which is what
  // the owner issuing a fresh invite means to do.
  await env.DB.prepare(
    `INSERT INTO vault_members (vault_id, subject, role) VALUES (?1, ?2, ?3)
     ON CONFLICT(vault_id, subject)
     DO UPDATE SET role = excluded.role, revoked_at = NULL, joined_at = unixepoch()`,
  )
    .bind(vault.id, subject, invite.role)
    .run();

  return { vaultId: vault.id, role: invite.role, keyEpoch: vault.key_epoch };
}

export async function registerDevice(
  env: Env,
  subject: string,
  deviceId: unknown,
  publicKey: unknown,
): Promise<void> {
  const id = requireIdentifier(deviceId, "deviceId");
  const serialized = JSON.stringify(publicKey ?? null);
  if (publicKey === undefined || publicKey === null) {
    throw new HttpError(400, "publicKey is required");
  }
  if (serialized.length > MAX_PUBLIC_KEY_BYTES) {
    throw new HttpError(413, "publicKey is too large");
  }
  await env.DB.prepare(
    `INSERT INTO vault_devices (subject, device_id, public_key) VALUES (?1, ?2, ?3)
     ON CONFLICT(subject, device_id)
     DO UPDATE SET public_key = excluded.public_key, revoked_at = NULL`,
  )
    .bind(subject, id, serialized)
    .run();
}

/**
 * Devices belonging to live members that have no sealed key at the vault's
 * current epoch. The owner polls this to know who still needs sealing.
 */
export async function listDevicesAwaitingKeys(
  env: Env,
  vault: Vault,
): Promise<{ subject: string; deviceId: string; publicKey: unknown }[]> {
  const result = await env.DB.prepare(
    `SELECT d.subject AS subject, d.device_id AS device_id, d.public_key AS public_key
     FROM vault_devices d
     JOIN vault_members m ON m.subject = d.subject
     WHERE m.vault_id = ?1 AND m.revoked_at IS NULL AND d.revoked_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM vault_member_keys k
         WHERE k.vault_id = ?1 AND k.device_id = d.device_id AND k.key_epoch = ?2
       )`,
  )
    .bind(vault.id, vault.key_epoch)
    .all<{ subject: string; device_id: string; public_key: string }>();
  return (result.results ?? []).map((row) => ({
    subject: row.subject,
    deviceId: row.device_id,
    publicKey: parseJson(row.public_key),
  }));
}

export async function putMemberKeys(
  env: Env,
  vault: Vault,
  caller: string,
  entries: unknown,
): Promise<number> {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new HttpError(400, "keys must be a non-empty array");
  }
  if (entries.length > MAX_KEYS_PER_REQUEST) {
    throw new HttpError(413, `at most ${MAX_KEYS_PER_REQUEST} keys per request`);
  }

  for (const entry of entries) {
    const record = entry as Record<string, unknown>;
    const deviceId = requireIdentifier(record?.deviceId, "deviceId");
    // Sealing to one's own device is the common case (vault creation, key
    // rotation) and a client has no way to learn its own subject, so an absent
    // subject means the caller.
    const subject =
      record?.subject === undefined
        ? caller
        : requireIdentifier(record.subject, "subject");
    if (record?.envelope === undefined || record.envelope === null) {
      throw new HttpError(400, "envelope is required");
    }
    const envelope = JSON.stringify(record.envelope);
    if (envelope.length > MAX_ENVELOPE_BYTES) {
      throw new HttpError(413, "key envelope is too large");
    }
    // Sealing to a non-member would hand the content key to an outsider.
    const member = await env.DB.prepare(
      `SELECT 1 AS present FROM vault_members
       WHERE vault_id = ?1 AND subject = ?2 AND revoked_at IS NULL`,
    )
      .bind(vault.id, subject)
      .first<{ present: number }>();
    if (!member) throw new HttpError(409, "recipient is not a member of this vault");

    await env.DB.prepare(
      `INSERT INTO vault_member_keys
         (vault_id, subject, device_id, key_epoch, key_envelope)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(vault_id, device_id, key_epoch) DO NOTHING`,
    )
      .bind(vault.id, subject, deviceId, vault.key_epoch, envelope)
      .run();
  }
  return entries.length;
}

export async function getMemberKey(
  env: Env,
  vault: Vault,
  subject: string,
  deviceId: string,
): Promise<{ keyEpoch: number; envelope: unknown } | null> {
  const row = await env.DB.prepare(
    `SELECT key_epoch, key_envelope FROM vault_member_keys
     WHERE vault_id = ?1 AND subject = ?2 AND device_id = ?3 AND key_epoch = ?4`,
  )
    .bind(vault.id, subject, deviceId, vault.key_epoch)
    .first<{ key_epoch: number; key_envelope: string }>();
  if (!row) return null;
  return { keyEpoch: row.key_epoch, envelope: parseJson(row.key_envelope) };
}

/**
 * Start a new key epoch. Envelopes from earlier epochs stay in place so a member
 * who has not yet re-synced can still open the blob written under the old key;
 * they become unreachable once every device holds the new one.
 */
export async function bumpKeyEpoch(env: Env, vault: Vault): Promise<number> {
  const next = vault.key_epoch + 1;
  await env.DB.prepare(
    `UPDATE vaults SET key_epoch = ?2, updated_at = unixepoch() WHERE id = ?1`,
  )
    .bind(vault.id, next)
    .run();
  return next;
}

export async function removeMember(
  env: Env,
  vault: Vault,
  subject: string,
): Promise<void> {
  if (subject === vault.owner_subject) {
    throw new HttpError(409, "the owner cannot be removed from their own vault");
  }
  await env.DB.prepare(
    `UPDATE vault_members SET revoked_at = unixepoch()
     WHERE vault_id = ?1 AND subject = ?2 AND revoked_at IS NULL`,
  )
    .bind(vault.id, subject)
    .run();
  // Drop their sealed keys so a stale envelope cannot be replayed after the
  // epoch bump the caller is expected to follow with.
  await env.DB.prepare(
    `DELETE FROM vault_member_keys WHERE vault_id = ?1 AND subject = ?2`,
  )
    .bind(vault.id, subject)
    .run();
}

export async function setVaultUsage(
  env: Env,
  vaultId: string,
  bytes: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE vaults SET used_bytes = ?2, updated_at = unixepoch() WHERE id = ?1`,
  )
    .bind(vaultId, bytes)
    .run();
}

/**
 * Bytes the vault owner is already accounted for, ignoring `excludeVaultId`
 * because that vault's blob is about to be replaced rather than added to.
 */
export async function ownerUsageExcluding(
  env: Env,
  ownerSubject: string,
  excludeVaultId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(
              (SELECT used_bytes FROM accounts WHERE subject = ?1), 0)
            + COALESCE(
              (SELECT SUM(used_bytes) FROM vaults
               WHERE owner_subject = ?1 AND deleted_at IS NULL AND id <> ?2), 0)
            AS used`,
  )
    .bind(ownerSubject, excludeVaultId)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

export async function ownerQuota(env: Env, ownerSubject: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT quota_bytes FROM accounts WHERE subject = ?1 AND deleted_at IS NULL`,
  )
    .bind(ownerSubject)
    .first<{ quota_bytes: number }>();
  if (!row) throw new HttpError(403, "vault owner account is unavailable");
  return row.quota_bytes;
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return value;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
