import type { Account, Env } from "./types";
import { HttpError } from "./auth";

export async function getOrCreateAccount(env: Env, subject: string): Promise<Account> {
  const quota = positiveInteger(env.DEFAULT_QUOTA_BYTES, "DEFAULT_QUOTA_BYTES");
  const storageId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO accounts (subject, storage_id, quota_bytes)
     VALUES (?1, ?2, ?3)`,
  )
    .bind(subject, storageId, quota)
    .run();

  const account = await env.DB.prepare(
    `SELECT subject, storage_id, quota_bytes, used_bytes, deleted_at
     FROM accounts WHERE subject = ?1`,
  )
    .bind(subject)
    .first<Account>();
  if (!account || account.deleted_at !== null) {
    throw new HttpError(403, "account is unavailable");
  }
  return account;
}

export async function updateUsage(env: Env, subject: string, bytes: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE accounts
     SET used_bytes = ?2, updated_at = unixepoch()
     WHERE subject = ?1 AND deleted_at IS NULL`,
  )
    .bind(subject, bytes)
    .run();
}

export async function markDeleted(env: Env, subject: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE accounts
     SET used_bytes = 0, deleted_at = unixepoch(), updated_at = unixepoch()
     WHERE subject = ?1 AND deleted_at IS NULL`,
  )
    .bind(subject)
    .run();
}

export function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
