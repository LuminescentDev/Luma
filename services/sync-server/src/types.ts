export interface Env {
  SYNC_BUCKET: R2Bucket;
  DB: D1Database;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  JWT_JWKS_URL: string;
  OIDC_CLIENT_ID: string;
  OIDC_DEVICE_AUTHORIZATION_ENDPOINT: string;
  OIDC_TOKEN_ENDPOINT: string;
  DEFAULT_QUOTA_BYTES: string;
  MAX_BLOB_BYTES: string;
  REVISION_LIMIT: string;
  RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

export interface Account {
  subject: string;
  storage_id: string;
  quota_bytes: number;
  used_bytes: number;
  deleted_at: number | null;
}

export interface AuthenticatedUser {
  subject: string;
}

export type VaultRole = "owner" | "writer" | "reader";

export interface Vault {
  id: string;
  owner_subject: string;
  storage_id: string;
  key_epoch: number;
  used_bytes: number;
  deleted_at: number | null;
}

/** A vault plus the requesting subject's live role in it. */
export interface VaultMembership {
  vault: Vault;
  role: VaultRole;
}
