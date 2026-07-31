//! Encrypted, provider-based synchronization.
//!
//! # Encrypted blob format
//!
//! All offsets are bytes. The format is intentionally fixed and
//! self-describing so a second device needs only the blob and passphrase:
//!
//! ```text
//! 0..8    magic ASCII `LUMASYNC`
//! 8       envelope version (`1`)
//! 9       KDF id (`1` = Argon2id v1.3, m=19456 KiB, t=2, p=1, 32-byte key)
//! 10      cipher id (`1` = XChaCha20-Poly1305)
//! 11      salt length (`16`)
//! 12      nonce length (`24`)
//! 13..29  random Argon2id salt
//! 29..53  random XChaCha20 nonce
//! 53..    authenticated ciphertext (includes the 16-byte Poly1305 tag)
//! ```
//!
//! Bytes `0..53` are authenticated as AEAD associated data. The plaintext is
//! UTF-8 JSON containing `SyncBundle` format version 1. A newer object than a
//! tombstone resurrects it within a bundle; a tombstone wins ties. Across two
//! devices, simultaneous object/delete changes remain conflicts.

pub mod managed;
mod providers;
pub mod vault_key;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use chrono::{SecondsFormat, Utc};
use hkdf::Hkdf;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use keyring::Entry;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use zeroize::{Zeroize, Zeroizing};

use crate::errors::{LumaError, Result};
use crate::keystore::{self, KeystoreState};
use crate::storage::host_groups::HostGroupDefaults;
use crate::storage::vaults::PERSONAL_VAULT_ID;
use crate::storage::{host_groups, hosts, identities, key_references, settings, snippets, vaults};

use providers::{
    GitHubGistProvider, LocalFolderProvider, LumaCloudProvider, SyncProvider, UploadResult,
    WebDavProvider,
};

const MAGIC: &[u8; 8] = b"LUMASYNC";
const ENVELOPE_VERSION: u8 = 1;
const KDF_ARGON2ID: u8 = 1;
/// Managed vaults are handed a random content key instead of a user secret, so
/// there is nothing to stretch: the per-blob key is HKDF'd straight from it.
const KDF_HKDF_CONTENT_KEY: u8 = 0;
const CIPHER_XCHACHA20_POLY1305: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 13 + SALT_LEN + NONCE_LEN;
const FORMAT_VERSION: u8 = 1;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const KEYCHAIN_SERVICE: &str = "luma.sync";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const KEYCHAIN_CHUNK_MANIFEST_PREFIX: &str = "luma-chunks-v1:";
// Windows stores password text as UTF-16 in a credential blob capped at 2560 bytes.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const KEYCHAIN_CHUNK_UTF16_LIMIT: usize = 1200;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const KEYCHAIN_MAX_CHUNKS: usize = 64;
const KEYCHAIN_PASSPHRASE: &str = "sync-passphrase";
const KEYCHAIN_WEBDAV_PASSWORD: &str = "webdav-password";
const KEYCHAIN_GIST_TOKEN: &str = "github-gist-token";
const KEYCHAIN_LUMA_CLOUD_SESSION: &str = "luma-cloud-session";
const MAX_OBJECTS_PER_TYPE: usize = 10_000;
const MAX_ENCRYPTED_KEY_SECRETS: usize = MAX_OBJECTS_PER_TYPE * 2;
const MAX_SYNC_SECRET_BYTES: usize = 1024 * 1024;
const KEYSTORE_KEY_OWNER_TYPE: &str = "key";
const PRIVATE_KEY_SECRET_TYPE: &str = "private-key";
const PASSPHRASE_SECRET_TYPE: &str = "passphrase";
const IDENTITY_PASSWORD_SECRET_TYPE: &str = "password";
pub(crate) const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;

/// Per-vault sync runtime. Each vault has its own unlocked secret and its own
/// pending-conflict set, so one vault stalling on a conflict never blocks
/// another. Nothing here is persisted: the secret lives in memory (and, if the
/// user asked for it, the OS keychain) and never in SQLite. For a managed vault
/// the secret is the content key unsealed from the server's envelope, so it is
/// cached exactly like a passphrase and discarded on lock.
#[derive(Default)]
pub struct SyncRuntimeState {
    passphrase: Mutex<HashMap<String, VaultSecret>>,
    pending: Mutex<HashMap<String, PendingSync>>,
}

/// Keychain account for a vault's credential. The personal vault keeps the bare
/// account names so credentials stored before vaults existed are still found.
/// `@` cannot appear in the base names or in the `:chunk:{n}` suffix that
/// `split_keychain_secret` appends, so the namespaces cannot alias.
fn vault_account(account: &str, vault_id: &str) -> String {
    if vault_id == PERSONAL_VAULT_ID {
        account.to_string()
    } else {
        format!("{account}@{vault_id}")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncBundle {
    pub format_version: u8,
    pub device_id: String,
    pub updated_at: String,
    pub hosts: Vec<SyncHost>,
    pub host_groups: Vec<SyncHostGroup>,
    pub key_references: Vec<SyncKeyReference>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub identities: Vec<SyncIdentity>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub encrypted_key_secrets: Vec<SyncEncryptedSecret>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub encrypted_identity_secrets: Vec<SyncEncryptedSecret>,
    pub terminal_profiles: Vec<SyncTerminalProfile>,
    pub snippets: Vec<SyncSnippet>,
    pub settings: BTreeMap<String, SyncSetting>,
    pub tombstones: Vec<SyncTombstone>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncHost {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: Option<String>,
    pub group_id: Option<String>,
    pub authentication_type: String,
    pub key_id: Option<String>,
    #[serde(default)]
    pub identity_id: Option<String>,
    pub proxy_jump_host_id: Option<String>,
    pub startup_command: Option<String>,
    pub working_directory: Option<String>,
    pub environment: Option<HashMap<String, String>>,
    pub tags: Vec<String>,
    pub favorite: bool,
    #[serde(default)]
    pub tab_color: Option<String>,
    // Mosh transport settings. Defaulted AND skipped when at their defaults so
    // bundles from hosts that never touched Mosh stay byte-identical for older
    // clients (SyncHost is deny_unknown_fields on the receiving side).
    #[serde(
        default = "crate::storage::hosts::default_transport",
        skip_serializing_if = "is_default_transport"
    )]
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mosh_server_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mosh_port_range: Option<String>,
    pub updated_at: i64,
}

fn is_default_transport(transport: &str) -> bool {
    transport == "ssh"
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncIdentity {
    pub id: String,
    pub name: String,
    pub username: String,
    pub key_id: Option<String>,
    pub has_password: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncHostGroup {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
    // Inheritable group defaults, nested rather than flattened because serde
    // cannot flatten under `deny_unknown_fields`.
    //
    // `None` means "this peer said nothing about defaults" — a bundle written
    // by a client that predates them. It must NOT be read as "the user cleared
    // every default": last-writer-wins would then let an old peer that merely
    // renamed a group wipe the inherited identity and jump host for every host
    // in it. Absent therefore preserves whatever the local row holds, while an
    // explicit (possibly empty) object is applied as authoritative.
    //
    // A vault that uses no group defaults emits no `defaults` key at all, so
    // its bundles stay byte-identical for older clients (SyncHostGroup is
    // deny_unknown_fields on the receiving side). Once any group in the vault
    // sets a default, every group in that bundle carries an explicit object so
    // that clearing one propagates — old-client compatibility for that vault is
    // already gone at that point.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<HostGroupDefaults>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncKeyReference {
    pub id: String,
    pub name: String,
    pub public_key: Option<String>,
    pub storage_mode: String,
    pub local_path: Option<String>,
    pub fingerprint: Option<String>,
    pub certificate: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncEncryptedSecret {
    pub key_reference_id: String,
    pub secret_type: String,
    pub kdf_id: u8,
    pub cipher_id: u8,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncTerminalProfile {
    pub id: String,
    pub name: String,
    pub shell_path: String,
    pub args: Vec<String>,
    pub working_directory: Option<String>,
    pub environment: Option<HashMap<String, String>>,
    pub platform: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncSnippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub variables: Vec<String>,
    pub host_id: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncSetting {
    pub value: Value,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncTombstone {
    pub object_type: String,
    pub object_id: String,
    pub deleted_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectCounts {
    pub hosts: usize,
    pub host_groups: usize,
    pub key_references: usize,
    pub identities: usize,
    pub terminal_profiles: usize,
    pub snippets: usize,
    pub settings: usize,
    pub tombstones: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub path: String,
    pub object_counts: ObjectCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub object_counts: ObjectCounts,
    pub conflicts: Vec<Conflict>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub applied: ObjectCounts,
    pub kept_local: ObjectCounts,
    pub conflicts: Vec<Conflict>,
    pub private_keys_applied: usize,
    pub private_keys_skipped_locked: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub object_type: String,
    pub object_id: String,
    pub label: String,
    pub local_updated_at: Option<i64>,
    pub remote_updated_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConflictResolution {
    pub object_type: String,
    pub object_id: String,
    pub resolution: ResolutionChoice,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ResolutionChoice {
    KeepLocal,
    TakeRemote,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncConfigureInput {
    pub provider: String,
    pub folder_path: Option<String>,
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub gist_id: Option<String>,
    pub token: Option<String>,
    pub cloud_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub vault_id: String,
    pub enabled: bool,
    pub provider: Option<String>,
    pub folder_path: Option<String>,
    pub url: Option<String>,
    pub username: Option<String>,
    pub gist_id: Option<String>,
    pub cloud_url: Option<String>,
    pub cloud_signed_in: bool,
    pub last_sync_at: Option<i64>,
    pub last_remote_version: Option<String>,
    pub passphrase_set: bool,
    pub passphrase_remembered: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pulled: bool,
    pub pushed: bool,
    pub conflicts: Vec<Conflict>,
    pub up_to_date: bool,
    pub private_keys_applied: usize,
    pub private_keys_skipped_locked: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSyncState {
    folder_path: Option<String>,
    url: Option<String>,
    username: Option<String>,
    gist_id: Option<String>,
    cloud_url: Option<String>,
    last_remote_version: Option<String>,
    #[serde(default)]
    baseline: BTreeMap<String, String>,
}

#[derive(Clone)]
struct PendingSync {
    provider: String,
    remote_version: String,
    remote_states: BTreeMap<String, MergeItem>,
    remote_encrypted_key_secrets: Vec<SyncEncryptedSecret>,
    remote_encrypted_identity_secrets: Vec<SyncEncryptedSecret>,
    conflicts: Vec<Conflict>,
}

#[derive(Debug, Clone)]
struct MergeItem {
    object_type: String,
    object_id: String,
    label: String,
    updated_at: i64,
    payload: Option<Value>,
}

impl MergeItem {
    fn hash(&self) -> String {
        let bytes = match &self.payload {
            Some(payload) => {
                let mut content = payload.clone();
                if let Value::Object(object) = &mut content {
                    object.remove("updatedAt");
                }
                serde_json::to_vec(&("object", content)).unwrap_or_default()
            }
            None => b"tombstone".to_vec(),
        };
        format!("{:x}", Sha256::digest(bytes))
    }
}

struct MergeOutcome {
    states: BTreeMap<String, MergeItem>,
    conflicts: Vec<Conflict>,
    applied_remote: ObjectCounts,
    kept_local: ObjectCounts,
    remote_key_references: HashSet<String>,
    remote_identities: HashSet<String>,
}

#[derive(Default)]
struct PrivateKeyApplySummary {
    applied: usize,
    skipped_locked: usize,
}

struct PreparedRemoteSecrets {
    entries: Vec<SyncEncryptedSecret>,
    skipped_locked: usize,
}

pub async fn initialize(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    keystore_state: &KeystoreState,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO device_state (id, device_id) VALUES (1, ?1)
         ON CONFLICT(id) DO NOTHING",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .execute(pool)
    .await?;

    for vault in vaults::list(pool).await? {
        let account = vault_account(KEYCHAIN_PASSPHRASE, &vault.id);
        if let Ok(passphrase) = credential_get(pool, keystore_state, &account).await {
            runtime.passphrase.lock().unwrap().insert(
                vault.id,
                VaultSecret::Passphrase(Zeroizing::new(passphrase)),
            );
        }
    }
    Ok(())
}

pub async fn export_encrypted(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    app_data_dir: &Path,
    vault_id: &str,
    path: &str,
    passphrase: &str,
) -> Result<ExportSummary> {
    vaults::require(pool, vault_id).await?;
    let path_buf = validate_file_path(path, app_data_dir, false)?;
    let secret = VaultSecret::from(passphrase);
    let bundle = assemble_bundle(pool, keystore_state, &secret, vault_id).await?;
    let counts = bundle.counts();
    let blob = encrypt_bundle(&bundle, &secret)?;
    fs::write(&path_buf, blob).map_err(|error| {
        LumaError::Io(std::io::Error::new(
            error.kind(),
            format!("could not write encrypted export: {error}"),
        ))
    })?;
    Ok(ExportSummary {
        path: path.to_string(),
        object_counts: counts,
    })
}

pub async fn import_preview(
    pool: &SqlitePool,
    app_data_dir: &Path,
    vault_id: &str,
    path: &str,
    passphrase: &str,
) -> Result<ImportPreview> {
    vaults::require(pool, vault_id).await?;
    let bundle = read_encrypted_bundle(path, app_data_dir, passphrase)?;
    validate_bundle(&bundle)?;
    let local = assemble_bundle_without_private_keys(pool, vault_id).await?;
    let outcome = merge_bundles(&local, &bundle, None, &[])?;
    Ok(ImportPreview {
        object_counts: bundle.counts(),
        conflicts: outcome.conflicts,
    })
}

pub async fn import_apply(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    app_data_dir: &Path,
    vault_id: &str,
    path: &str,
    passphrase: &str,
    resolutions: &[ConflictResolution],
) -> Result<ImportSummary> {
    vaults::require(pool, vault_id).await?;
    let secret = VaultSecret::from(passphrase);
    let bundle = read_encrypted_bundle(path, app_data_dir, passphrase)?;
    validate_bundle(&bundle)?;
    let local = assemble_bundle(pool, keystore_state, &secret, vault_id).await?;
    let outcome = merge_bundles(&local, &bundle, None, resolutions)?;
    validate_states(&outcome.states)?;
    let prepared = prepare_remote_secrets(
        keystore_state,
        &secret,
        &bundle.encrypted_key_secrets,
        &outcome.states,
        &outcome.remote_key_references,
    )?;
    let prepared_identities = prepare_remote_identity_secrets(
        keystore_state,
        &secret,
        &bundle.encrypted_identity_secrets,
        &outcome.states,
        &outcome.remote_identities,
    )?;
    apply_states(pool, &outcome.states, vault_id).await?;
    let private_keys = apply_prepared_secrets(pool, keystore_state, &secret, prepared).await?;
    apply_prepared_identity_secrets(pool, keystore_state, &secret, prepared_identities).await?;
    Ok(ImportSummary {
        applied: outcome.applied_remote,
        kept_local: outcome.kept_local,
        conflicts: outcome.conflicts,
        private_keys_applied: private_keys.applied,
        private_keys_skipped_locked: private_keys.skipped_locked,
    })
}

pub async fn get_config(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    keystore_state: &KeystoreState,
    vault_id: &str,
) -> Result<SyncConfig> {
    vaults::require(pool, vault_id).await?;
    let cloud_signed_in = crate::collaboration::account_is_signed_in(pool, keystore_state).await;
    config_for_vault(pool, runtime, keystore_state, vault_id, cloud_signed_in).await
}

/// Every vault's sync configuration, in the vault list's order. The title bar
/// aggregates these into one status, so it needs them all in one round trip.
pub async fn list_configs(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    keystore_state: &KeystoreState,
) -> Result<Vec<SyncConfig>> {
    let cloud_signed_in = crate::collaboration::account_is_signed_in(pool, keystore_state).await;
    let mut configs = Vec::new();
    for vault in vaults::list(pool).await? {
        configs.push(
            config_for_vault(pool, runtime, keystore_state, &vault.id, cloud_signed_in).await?,
        );
    }
    Ok(configs)
}

async fn config_for_vault(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    keystore_state: &KeystoreState,
    vault_id: &str,
    cloud_signed_in: bool,
) -> Result<SyncConfig> {
    let row =
        sqlx::query("SELECT provider, last_synced_at, state FROM sync_state WHERE vault_id = ?1")
            .bind(vault_id)
            .fetch_optional(pool)
            .await?;
    let provider: Option<String> = row.as_ref().and_then(|row| row.get("provider"));
    let passphrase_set =
        runtime.passphrase.lock().unwrap().contains_key(vault_id) || provider.is_some();
    let stored = parse_stored_state(row.as_ref().and_then(|row| row.get("state")))?;
    let passphrase_account = vault_account(KEYCHAIN_PASSPHRASE, vault_id);
    Ok(SyncConfig {
        vault_id: vault_id.to_string(),
        enabled: provider.is_some(),
        provider,
        folder_path: stored.folder_path,
        url: stored.url,
        username: stored.username,
        gist_id: stored.gist_id,
        cloud_url: stored.cloud_url,
        cloud_signed_in,
        last_sync_at: row.as_ref().and_then(|row| row.get("last_synced_at")),
        last_remote_version: stored.last_remote_version,
        passphrase_set,
        passphrase_remembered: credential_get(pool, keystore_state, &passphrase_account)
            .await
            .is_ok(),
    })
}

pub async fn configure(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    keystore_state: &KeystoreState,
    app_data_dir: &Path,
    vault_id: &str,
    mut input: SyncConfigureInput,
) -> Result<()> {
    vaults::require(pool, vault_id).await?;
    let provider = input.provider.trim();
    let mut stored = StoredSyncState::default();
    // Only this vault's credentials for the providers it is no longer using are
    // cleared; other vaults keep theirs.
    match provider {
        "local-folder" => {
            let folder = required_trimmed(input.folder_path.take(), "folderPath")?;
            let folder_path = PathBuf::from(&folder);
            providers::validate_local_folder(&folder_path)?;
            reject_app_data_path(&folder_path, app_data_dir)?;
            stored.folder_path = Some(folder);
            clear_provider_credentials(pool, keystore_state, vault_id, &[]).await?;
        }
        "webdav" => {
            let url = required_trimmed(input.url.take(), "url")?;
            providers::validate_https_url(&url)?;
            let username = required_trimmed(input.username.take(), "username")?;
            let password = required_secret(input.password.take(), "password")?;
            let account = vault_account(KEYCHAIN_WEBDAV_PASSWORD, vault_id);
            credential_set(pool, keystore_state, &account, &password).await?;
            clear_provider_credentials(pool, keystore_state, vault_id, &[KEYCHAIN_WEBDAV_PASSWORD])
                .await?;
            stored.url = Some(url);
            stored.username = Some(username);
        }
        "github-gist" => {
            let token = required_secret(input.token.take(), "token")?;
            let account = vault_account(KEYCHAIN_GIST_TOKEN, vault_id);
            credential_set(pool, keystore_state, &account, &token).await?;
            clear_provider_credentials(pool, keystore_state, vault_id, &[KEYCHAIN_GIST_TOKEN])
                .await?;
            stored.gist_id = optional_identifier(input.gist_id.take(), "gistId")?;
        }
        "luma-cloud" => {
            // On Luma Cloud a vault is either the account's own blob (personal)
            // or a server-side vault with its own membership (managed). A
            // passphrase-shared vault has neither, and would collide with the
            // personal blob, so it belongs on one of the other providers.
            let kind = vaults::get(pool, vault_id)
                .await?
                .map(|vault| vault.kind)
                .unwrap_or_default();
            if vault_id != PERSONAL_VAULT_ID && kind != vaults::MANAGED_KIND {
                return Err(LumaError::InvalidInput(
                    "Luma Cloud sync is available for the personal vault and for vaults \
                     shared through Luma Cloud; use a local folder, WebDAV or GitHub Gist \
                     for a passphrase-shared vault"
                        .into(),
                ));
            }
            let cloud_url = required_trimmed(input.cloud_url.take(), "cloudUrl")?;
            providers::validate_cloud_api_url(&cloud_url)?;
            if !crate::collaboration::account_is_signed_in(pool, keystore_state).await {
                return Err(LumaError::SyncAuthFailed(
                    "sign in to your Luma account before enabling Luma Cloud sync".into(),
                ));
            }
            clear_provider_credentials(pool, keystore_state, vault_id, &[]).await?;
            stored.cloud_url = Some(cloud_url.trim_end_matches('/').to_string());
        }
        _ => {
            return Err(LumaError::InvalidInput(
                "provider must be 'local-folder', 'webdav', 'github-gist', or 'luma-cloud'".into(),
            ));
        }
    }

    let state_json = serde_json::to_string(&stored)
        .map_err(|_| LumaError::InvalidInput("sync configuration is invalid".into()))?;
    sqlx::query(
        "INSERT INTO sync_state (vault_id, provider, last_synced_at, state)
         VALUES (?1, ?2, NULL, ?3)
         ON CONFLICT(vault_id) DO UPDATE SET provider = excluded.provider,
             last_synced_at = NULL, state = excluded.state",
    )
    .bind(vault_id)
    .bind(provider)
    .bind(state_json)
    .execute(pool)
    .await?;
    runtime.pending.lock().unwrap().remove(vault_id);
    Ok(())
}

/// Drop this vault's stored credentials for every provider except those in
/// `keep`, which the caller has just written.
async fn clear_provider_credentials(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    vault_id: &str,
    keep: &[&str],
) -> Result<()> {
    for account in [
        KEYCHAIN_WEBDAV_PASSWORD,
        KEYCHAIN_GIST_TOKEN,
        KEYCHAIN_LUMA_CLOUD_SESSION,
    ] {
        if keep.contains(&account) {
            continue;
        }
        clear_credential(pool, keystore_state, &vault_account(account, vault_id)).await?;
    }
    Ok(())
}

pub async fn set_passphrase(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    keystore_state: &KeystoreState,
    vault_id: &str,
    passphrase: String,
    remember: bool,
) -> Result<()> {
    vaults::require(pool, vault_id).await?;
    validate_passphrase(&passphrase)?;
    let account = vault_account(KEYCHAIN_PASSPHRASE, vault_id);
    if remember {
        credential_set(pool, keystore_state, &account, &passphrase).await?;
    } else {
        clear_credential(pool, keystore_state, &account).await?;
    }
    runtime.passphrase.lock().unwrap().insert(
        vault_id.to_string(),
        VaultSecret::Passphrase(Zeroizing::new(passphrase)),
    );
    Ok(())
}

pub async fn disable(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    keystore_state: &KeystoreState,
    vault_id: &str,
) -> Result<()> {
    vaults::require(pool, vault_id).await?;
    sqlx::query("DELETE FROM sync_state WHERE vault_id = ?1")
        .bind(vault_id)
        .execute(pool)
        .await?;
    clear_provider_credentials(pool, keystore_state, vault_id, &[]).await?;
    clear_credential(
        pool,
        keystore_state,
        &vault_account(KEYCHAIN_PASSPHRASE, vault_id),
    )
    .await?;
    runtime.passphrase.lock().unwrap().remove(vault_id);
    runtime.pending.lock().unwrap().remove(vault_id);
    Ok(())
}

pub async fn sync_now(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    keystore_state: &KeystoreState,
    collab_runtime: &crate::collaboration::CollaborationRuntimeState,
    app_data_dir: &Path,
    vault_id: &str,
) -> Result<SyncReport> {
    vaults::require(pool, vault_id).await?;
    let (provider_name, mut stored) = load_enabled_config(pool, vault_id).await?;
    let secret = current_secret(
        pool,
        runtime,
        collab_runtime,
        keystore_state,
        &stored,
        vault_id,
    )
    .await?;
    // Hand the key to any member device that joined since the last sync. Doing
    // it before the transfer means a new joiner can decrypt as soon as one
    // existing member syncs, rather than waiting for a change to push.
    share_managed_key(
        pool,
        collab_runtime,
        keystore_state,
        &stored,
        vault_id,
        &secret,
    )
    .await?;

    let provider = create_provider(
        pool,
        keystore_state,
        collab_runtime,
        &provider_name,
        &stored,
        app_data_dir,
        vault_id,
    )
    .await?;
    let remote = provider.download().await?;
    let local = assemble_bundle(pool, keystore_state, &secret, vault_id).await?;

    let Some(remote) = remote else {
        let blob = encrypt_bundle(&local, &secret)?;
        let uploaded = provider.upload(&blob, None).await?;
        update_after_upload(
            pool,
            &provider_name,
            &mut stored,
            &local,
            uploaded,
            vault_id,
        )
        .await?;
        runtime.pending.lock().unwrap().remove(vault_id);
        return Ok(SyncReport {
            pulled: false,
            pushed: true,
            conflicts: Vec::new(),
            up_to_date: false,
            private_keys_applied: 0,
            private_keys_skipped_locked: 0,
        });
    };

    let remote_bundle = decrypt_bundle(&remote.bytes, &secret)?;
    validate_bundle(&remote_bundle)?;
    let outcome = merge_bundles(&local, &remote_bundle, Some(&stored.baseline), &[])?;
    validate_states(&outcome.states)?;
    let prepared = prepare_remote_secrets(
        keystore_state,
        &secret,
        &remote_bundle.encrypted_key_secrets,
        &outcome.states,
        &outcome.remote_key_references,
    )?;
    let prepared_identities = prepare_remote_identity_secrets(
        keystore_state,
        &secret,
        &remote_bundle.encrypted_identity_secrets,
        &outcome.states,
        &outcome.remote_identities,
    )?;
    apply_states(pool, &outcome.states, vault_id).await?;
    let private_keys = apply_prepared_secrets(pool, keystore_state, &secret, prepared).await?;
    let identity_passwords =
        apply_prepared_identity_secrets(pool, keystore_state, &secret, prepared_identities).await?;
    let pulled =
        !outcome.applied_remote.is_empty() || private_keys.applied > 0 || identity_passwords > 0;

    if !outcome.conflicts.is_empty() {
        runtime.pending.lock().unwrap().insert(
            vault_id.to_string(),
            PendingSync {
                provider: provider_name,
                remote_version: remote.version,
                remote_states: remote_bundle.states()?,
                remote_encrypted_key_secrets: remote_bundle.encrypted_key_secrets.clone(),
                remote_encrypted_identity_secrets: remote_bundle.encrypted_identity_secrets.clone(),
                conflicts: outcome.conflicts.clone(),
            },
        );
        return Ok(SyncReport {
            pulled,
            pushed: false,
            conflicts: outcome.conflicts,
            up_to_date: false,
            private_keys_applied: private_keys.applied,
            private_keys_skipped_locked: private_keys.skipped_locked,
        });
    }

    let merged = assemble_bundle(pool, keystore_state, &secret, vault_id).await?;
    let compare_private_keys = private_key_sync_active(pool, keystore_state, vault_id).await?;
    let needs_push =
        !bundles_have_same_content(&merged, &remote_bundle, &secret, compare_private_keys)?;
    let pushed = if needs_push {
        let blob = encrypt_bundle(&merged, &secret)?;
        let uploaded = provider.upload(&blob, Some(&remote.version)).await?;
        update_after_upload(
            pool,
            &provider_name,
            &mut stored,
            &merged,
            uploaded,
            vault_id,
        )
        .await?;
        true
    } else {
        stored.last_remote_version = Some(remote.version);
        stored.baseline = baseline_for_bundle(&merged)?;
        save_stored_state(pool, &stored, true, vault_id).await?;
        false
    };
    runtime.pending.lock().unwrap().remove(vault_id);
    Ok(SyncReport {
        pulled,
        pushed,
        conflicts: Vec::new(),
        up_to_date: !pulled && !pushed,
        private_keys_applied: private_keys.applied,
        private_keys_skipped_locked: private_keys.skipped_locked,
    })
}

/// Seal a managed vault's key to member devices that do not hold it yet. A no-op
/// for every other vault kind.
async fn share_managed_key(
    pool: &SqlitePool,
    collab_runtime: &crate::collaboration::CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    stored: &StoredSyncState,
    vault_id: &str,
    secret: &VaultSecret,
) -> Result<()> {
    let Some(vault) = vaults::get(pool, vault_id).await? else {
        return Ok(());
    };
    if vault.kind != vaults::MANAGED_KIND {
        return Ok(());
    }
    let Some(api_url) = stored.cloud_url.as_deref() else {
        return Ok(());
    };
    managed::share_key_with_pending_devices(
        pool,
        collab_runtime,
        keystore_state,
        api_url,
        &vault,
        secret,
    )
    .await?;
    Ok(())
}

pub async fn sync_resolve(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    keystore_state: &KeystoreState,
    collab_runtime: &crate::collaboration::CollaborationRuntimeState,
    app_data_dir: &Path,
    vault_id: &str,
    resolutions: &[ConflictResolution],
) -> Result<SyncReport> {
    vaults::require(pool, vault_id).await?;
    let pending = runtime
        .pending
        .lock()
        .unwrap()
        .get(vault_id)
        .cloned()
        .ok_or_else(|| LumaError::InvalidInput("there are no pending sync conflicts".into()))?;
    let (provider_name, mut stored) = load_enabled_config(pool, vault_id).await?;
    if provider_name != pending.provider {
        return Err(LumaError::SyncConflict(
            "sync provider changed while conflicts were pending".into(),
        ));
    }
    let resolution_map = validate_resolutions(resolutions, &pending.conflicts)?;
    let unresolved: Vec<Conflict> = pending
        .conflicts
        .iter()
        .filter(|conflict| {
            !resolution_map.contains_key(&object_key(&conflict.object_type, &conflict.object_id))
        })
        .cloned()
        .collect();
    if !unresolved.is_empty() {
        return Ok(SyncReport {
            pulled: false,
            pushed: false,
            conflicts: unresolved,
            up_to_date: false,
            private_keys_applied: 0,
            private_keys_skipped_locked: 0,
        });
    }

    let secret = current_secret(
        pool,
        runtime,
        collab_runtime,
        keystore_state,
        &stored,
        vault_id,
    )
    .await?;
    let local = assemble_bundle(pool, keystore_state, &secret, vault_id).await?;
    let mut states = local.states()?;
    let mut pulled = false;
    let mut remote_key_references = HashSet::new();
    let mut remote_identities = HashSet::new();
    for conflict in &pending.conflicts {
        let key = object_key(&conflict.object_type, &conflict.object_id);
        if resolution_map[&key] == ResolutionChoice::TakeRemote {
            match pending.remote_states.get(&key) {
                Some(remote) => {
                    states.insert(key, remote.clone());
                    if remote.object_type == "key_reference" && remote.payload.is_some() {
                        remote_key_references.insert(remote.object_id.clone());
                    }
                    if remote.object_type == "identity" && remote.payload.is_some() {
                        remote_identities.insert(remote.object_id.clone());
                    }
                }
                None => {
                    states.remove(&key);
                }
            }
            pulled = true;
        }
    }
    validate_states(&states)?;
    let prepared = prepare_remote_secrets(
        keystore_state,
        &secret,
        &pending.remote_encrypted_key_secrets,
        &states,
        &remote_key_references,
    )?;
    let prepared_identities = prepare_remote_identity_secrets(
        keystore_state,
        &secret,
        &pending.remote_encrypted_identity_secrets,
        &states,
        &remote_identities,
    )?;
    apply_states(pool, &states, vault_id).await?;
    let private_keys = apply_prepared_secrets(pool, keystore_state, &secret, prepared).await?;
    let identity_passwords =
        apply_prepared_identity_secrets(pool, keystore_state, &secret, prepared_identities).await?;
    pulled |= private_keys.applied > 0 || identity_passwords > 0;

    let provider = create_provider(
        pool,
        keystore_state,
        collab_runtime,
        &provider_name,
        &stored,
        app_data_dir,
        vault_id,
    )
    .await?;
    let merged = assemble_bundle(pool, keystore_state, &secret, vault_id).await?;
    let blob = encrypt_bundle(&merged, &secret)?;
    let uploaded = provider
        .upload(&blob, Some(&pending.remote_version))
        .await?;
    update_after_upload(
        pool,
        &provider_name,
        &mut stored,
        &merged,
        uploaded,
        vault_id,
    )
    .await?;
    runtime.pending.lock().unwrap().remove(vault_id);
    Ok(SyncReport {
        pulled,
        pushed: true,
        conflicts: Vec::new(),
        up_to_date: false,
        private_keys_applied: private_keys.applied,
        private_keys_skipped_locked: private_keys.skipped_locked,
    })
}

fn encrypt_bundle(bundle: &SyncBundle, secret: &VaultSecret) -> Result<Vec<u8>> {
    secret.validate()?;
    validate_bundle(bundle)?;
    let plaintext = serde_json::to_vec(bundle)
        .map_err(|_| LumaError::InvalidInput("could not serialize sync data".into()))?;
    if plaintext.len() > MAX_BLOB_BYTES - HEADER_LEN - 16 {
        return Err(LumaError::InvalidInput(
            "sync bundle exceeds the size limit".into(),
        ));
    }
    let mut salt = [0_u8; SALT_LEN];
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let key = secret.derive(&salt)?;

    let mut blob = Vec::with_capacity(HEADER_LEN + plaintext.len() + 16);
    blob.extend_from_slice(MAGIC);
    blob.extend_from_slice(&[
        ENVELOPE_VERSION,
        secret.kdf_id(),
        CIPHER_XCHACHA20_POLY1305,
        SALT_LEN as u8,
        NONCE_LEN as u8,
    ]);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce);
    let ciphertext = XChaCha20Poly1305::new((&*key).into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &blob,
            },
        )
        .map_err(|_| LumaError::SyncUnavailable("could not encrypt sync data".into()))?;
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

fn decrypt_bundle(blob: &[u8], secret: &VaultSecret) -> Result<SyncBundle> {
    secret.validate()?;
    if blob.len() < HEADER_LEN + 16 || blob.len() > MAX_BLOB_BYTES {
        return Err(LumaError::InvalidInput(
            "encrypted sync file has an invalid size".into(),
        ));
    }
    if &blob[..8] != MAGIC {
        return Err(LumaError::InvalidInput(
            "file is not a Luma encrypted sync bundle".into(),
        ));
    }
    if blob[8] != ENVELOPE_VERSION
        || (blob[9] != KDF_ARGON2ID && blob[9] != KDF_HKDF_CONTENT_KEY)
        || blob[10] != CIPHER_XCHACHA20_POLY1305
        || blob[11] as usize != SALT_LEN
        || blob[12] as usize != NONCE_LEN
    {
        return Err(LumaError::InvalidInput(
            "encrypted sync format is unsupported".into(),
        ));
    }
    secret.reject_foreign_kdf(blob[9])?;
    let salt = &blob[13..13 + SALT_LEN];
    let nonce = &blob[13 + SALT_LEN..HEADER_LEN];
    let key = secret.derive(salt)?;
    let plaintext = Zeroizing::new(
        XChaCha20Poly1305::new((&*key).into())
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: &blob[HEADER_LEN..],
                    aad: &blob[..HEADER_LEN],
                },
            )
            .map_err(|_| {
                LumaError::SyncAuthFailed(
                    "incorrect sync passphrase or corrupted encrypted sync file".into(),
                )
            })?,
    );
    let mut bundle: SyncBundle = serde_json::from_slice(&plaintext)
        .map_err(|_| LumaError::InvalidInput("sync bundle contains invalid JSON".into()))?;
    normalize_legacy_agent_auth(&mut bundle);
    validate_bundle(&bundle)?;
    Ok(bundle)
}

/// SSH-agent references are device-bound handles and must not cross sync
/// boundaries. This also accepts bundles emitted by older versions that used
/// the legacy `agent` authentication type.
fn normalize_legacy_agent_auth(bundle: &mut SyncBundle) {
    let agent_key_ids: HashSet<String> = bundle
        .key_references
        .iter()
        .filter(|key| key.storage_mode == "ssh-agent")
        .map(|key| key.id.clone())
        .collect();
    bundle
        .key_references
        .retain(|key| key.storage_mode != "ssh-agent");
    bundle
        .encrypted_key_secrets
        .retain(|secret| !agent_key_ids.contains(&secret.key_reference_id));
    for host in &mut bundle.hosts {
        if host
            .key_id
            .as_ref()
            .is_some_and(|id| agent_key_ids.contains(id))
        {
            host.key_id = None;
            if host.authentication_type == "key" {
                host.authentication_type = "interactive".into();
            }
        }
        if host.authentication_type == "agent" {
            host.authentication_type = "interactive".into();
        }
    }
    for identity in &mut bundle.identities {
        if identity
            .key_id
            .as_ref()
            .is_some_and(|id| agent_key_ids.contains(id))
        {
            identity.key_id = None;
        }
    }
}

fn derive_sync_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let params = Params::new(19_456, 2, 1, Some(32))
        .map_err(|_| LumaError::SyncUnavailable("sync KDF parameters are invalid".into()))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0_u8; 32];
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|_| LumaError::SyncUnavailable("sync key derivation failed".into()))?;
    Ok(key)
}

/// What a vault's blob and secrets are encrypted under.
///
/// A passphrase vault stretches a user secret with Argon2id, exactly as before.
/// A managed vault is handed a random 32-byte content key that the server
/// distributes sealed to each member device, so there is no secret to stretch —
/// the per-blob key comes from HKDF over the same header salt. Everything below
/// this point (envelope, bundle, three-way merge, conflict handling) is shared.
#[derive(Clone)]
pub(crate) enum VaultSecret {
    Passphrase(Zeroizing<String>),
    ContentKey(Zeroizing<[u8; vault_key::CONTENT_KEY_LEN]>),
}

impl VaultSecret {
    fn kdf_id(&self) -> u8 {
        match self {
            Self::Passphrase(_) => KDF_ARGON2ID,
            Self::ContentKey(_) => KDF_HKDF_CONTENT_KEY,
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::Passphrase(passphrase) => validate_passphrase(passphrase),
            Self::ContentKey(_) => Ok(()),
        }
    }

    fn derive(&self, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
        match self {
            Self::Passphrase(passphrase) => Ok(Zeroizing::new(derive_sync_key(passphrase, salt)?)),
            Self::ContentKey(content_key) => {
                let hkdf = Hkdf::<Sha256>::new(Some(salt), &**content_key);
                let mut key = Zeroizing::new([0_u8; 32]);
                hkdf.expand(b"luma.sync.blob", &mut *key)
                    .map_err(|_| LumaError::SyncUnavailable("sync key derivation failed".into()))?;
                Ok(key)
            }
        }
    }

    /// A blob written under a content key cannot be opened with a passphrase or
    /// the other way round, so a KDF mismatch is a definite error rather than a
    /// wrong-secret retry.
    fn reject_foreign_kdf(&self, kdf_id: u8) -> Result<()> {
        if kdf_id == self.kdf_id() {
            return Ok(());
        }
        Err(LumaError::InvalidInput(
            match self {
                Self::Passphrase(_) => {
                    "this remote holds a managed vault, which a passphrase cannot open"
                }
                Self::ContentKey(_) => {
                    "this remote holds a passphrase-protected vault, not a managed one"
                }
            }
            .into(),
        ))
    }
}

impl From<&str> for VaultSecret {
    fn from(passphrase: &str) -> Self {
        Self::Passphrase(Zeroizing::new(passphrase.to_string()))
    }
}

fn secret_aad(
    key_reference_id: &str,
    secret_type: &str,
    kdf_id: u8,
    cipher_id: u8,
    salt: &[u8],
    nonce: &[u8],
    updated_at: i64,
) -> Vec<u8> {
    let mut aad = Vec::with_capacity(
        8 + 4 + key_reference_id.len() + 4 + secret_type.len() + 2 + salt.len() + nonce.len() + 8,
    );
    aad.extend_from_slice(b"LUMAKEY1");
    aad.extend_from_slice(&(key_reference_id.len() as u32).to_be_bytes());
    aad.extend_from_slice(key_reference_id.as_bytes());
    aad.extend_from_slice(&(secret_type.len() as u32).to_be_bytes());
    aad.extend_from_slice(secret_type.as_bytes());
    aad.extend_from_slice(&[kdf_id, cipher_id]);
    aad.extend_from_slice(salt);
    aad.extend_from_slice(nonce);
    aad.extend_from_slice(&updated_at.to_be_bytes());
    aad
}

fn encrypt_sync_secret(
    key_reference_id: &str,
    secret_type: &str,
    plaintext: &str,
    updated_at: i64,
    secret: &VaultSecret,
) -> Result<SyncEncryptedSecret> {
    secret.validate()?;
    if plaintext.len() > MAX_SYNC_SECRET_BYTES {
        return Err(LumaError::InvalidInput(
            "private key sync secret exceeds the size limit".into(),
        ));
    }
    let mut salt = [0_u8; SALT_LEN];
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let key = secret.derive(&salt)?;
    let aad = secret_aad(
        key_reference_id,
        secret_type,
        secret.kdf_id(),
        CIPHER_XCHACHA20_POLY1305,
        &salt,
        &nonce,
        updated_at,
    );
    let ciphertext = XChaCha20Poly1305::new((&*key).into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: &aad,
            },
        )
        .map_err(|_| {
            LumaError::SyncUnavailable("could not encrypt private key sync data".into())
        })?;
    let base64 = base64::engine::general_purpose::STANDARD;
    Ok(SyncEncryptedSecret {
        key_reference_id: key_reference_id.to_string(),
        secret_type: secret_type.to_string(),
        kdf_id: secret.kdf_id(),
        cipher_id: CIPHER_XCHACHA20_POLY1305,
        salt: base64.encode(salt),
        nonce: base64.encode(nonce),
        ciphertext: base64.encode(ciphertext),
        updated_at,
    })
}

fn decode_sync_secret_parts(secret: &SyncEncryptedSecret) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    if secret.key_reference_id.is_empty()
        || secret.key_reference_id.len() > 512
        || secret.key_reference_id.contains('\0')
        || (secret.kdf_id != KDF_ARGON2ID && secret.kdf_id != KDF_HKDF_CONTENT_KEY)
        || secret.cipher_id != CIPHER_XCHACHA20_POLY1305
        || secret.updated_at < 0
    {
        return Err(LumaError::InvalidInput(
            "encrypted secret metadata is invalid or unsupported".into(),
        ));
    }
    let base64 = base64::engine::general_purpose::STANDARD;
    let salt = base64
        .decode(&secret.salt)
        .map_err(|_| LumaError::InvalidInput("encrypted key secret salt is invalid".into()))?;
    let nonce = base64
        .decode(&secret.nonce)
        .map_err(|_| LumaError::InvalidInput("encrypted key secret nonce is invalid".into()))?;
    let ciphertext = base64.decode(&secret.ciphertext).map_err(|_| {
        LumaError::InvalidInput("encrypted key secret ciphertext is invalid".into())
    })?;
    if salt.len() != SALT_LEN
        || nonce.len() != NONCE_LEN
        || ciphertext.len() < 16
        || ciphertext.len() > MAX_SYNC_SECRET_BYTES + 16
    {
        return Err(LumaError::InvalidInput(
            "encrypted key secret has an invalid size".into(),
        ));
    }
    Ok((salt, nonce, ciphertext))
}

fn decrypt_sync_secret(
    secret: &SyncEncryptedSecret,
    vault_secret: &VaultSecret,
) -> Result<Zeroizing<String>> {
    vault_secret.validate()?;
    let (salt, nonce, ciphertext) = decode_sync_secret_parts(secret)?;
    vault_secret.reject_foreign_kdf(secret.kdf_id)?;
    let key = vault_secret.derive(&salt)?;
    let aad = secret_aad(
        &secret.key_reference_id,
        &secret.secret_type,
        secret.kdf_id,
        secret.cipher_id,
        &salt,
        &nonce,
        secret.updated_at,
    );
    let plaintext = XChaCha20Poly1305::new((&*key).into())
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| {
            LumaError::SyncAuthFailed(
                "encrypted private key sync data could not be authenticated".into(),
            )
        })?;
    match String::from_utf8(plaintext) {
        Ok(plaintext) => Ok(Zeroizing::new(plaintext)),
        Err(error) => {
            let mut plaintext = error.into_bytes();
            plaintext.zeroize();
            Err(LumaError::InvalidInput(
                "encrypted key secret plaintext is not valid UTF-8".into(),
            ))
        }
    }
}

async fn private_key_sync_active(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    vault_id: &str,
) -> Result<bool> {
    let share_secrets = vaults::get(pool, vault_id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown vault".into()))?
        .share_secrets;
    Ok(share_secrets && keystore::is_unlocked(keystore_state))
}

async fn assemble_bundle(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    secret: &VaultSecret,
    vault_id: &str,
) -> Result<SyncBundle> {
    assemble_bundle_inner(pool, Some((keystore_state, secret)), vault_id).await
}

async fn assemble_bundle_without_private_keys(
    pool: &SqlitePool,
    vault_id: &str,
) -> Result<SyncBundle> {
    assemble_bundle_inner(pool, None, vault_id).await
}

async fn assemble_bundle_inner(
    pool: &SqlitePool,
    private_key_sync: Option<(&KeystoreState, &VaultSecret)>,
    vault_id: &str,
) -> Result<SyncBundle> {
    // Device-scoped preferences belong to the person, not the team: a teammate's
    // font size must never land on someone else's machine.
    let device_scoped = vault_id == PERSONAL_VAULT_ID;
    let device_id: String = sqlx::query_scalar("SELECT device_id FROM device_state WHERE id = 1")
        .fetch_one(pool)
        .await?;

    let hosts = sqlx::query(
        "SELECT id,name,hostname,port,username,group_id,auth_type,key_id,identity_id,proxy_jump_host_id,
                startup_command,working_directory,environment,tags,favorite,tab_color,transport,
                mosh_server_path,mosh_port_range,updated_at FROM hosts
         WHERE is_ephemeral = 0 AND vault_id = ?1",
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| {
        let environment: Option<String> = row.get("environment");
        let tags: String = row.get("tags");
        Ok(SyncHost {
            id: row.get("id"),
            name: row.get("name"),
            hostname: row.get("hostname"),
            port: u16::try_from(row.get::<i64, _>("port"))
                .map_err(|_| LumaError::InvalidInput("stored host has an invalid port".into()))?,
            username: row.get("username"),
            group_id: row.get("group_id"),
            authentication_type: row.get("auth_type"),
            key_id: row.get("key_id"),
            identity_id: row.get("identity_id"),
            proxy_jump_host_id: row.get("proxy_jump_host_id"),
            startup_command: row.get("startup_command"),
            working_directory: row.get("working_directory"),
            environment: environment
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|_| {
                    LumaError::InvalidInput("stored host environment is invalid".into())
                })?,
            tags: serde_json::from_str(&tags)
                .map_err(|_| LumaError::InvalidInput("stored host tags are invalid".into()))?,
            favorite: row.get::<i64, _>("favorite") != 0,
            tab_color: row.get("tab_color"),
            transport: row.get("transport"),
            mosh_server_path: row.get("mosh_server_path"),
            mosh_port_range: row.get("mosh_port_range"),
            updated_at: row.get("updated_at"),
        })
    })
    .collect::<Result<Vec<_>>>()?;

    let host_groups = sqlx::query(
        "SELECT id,name,parent_id,sort_order,username,identity_id,proxy_jump_host_id,
                startup_command,working_directory,environment,tab_color,transport,
                mosh_server_path,mosh_port_range,updated_at FROM host_groups WHERE vault_id = ?1",
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| {
        let environment: Option<String> = row.get("environment");
        Ok(SyncHostGroup {
            id: row.get("id"),
            name: row.get("name"),
            parent_id: row.get("parent_id"),
            sort_order: row.get("sort_order"),
            defaults: Some(HostGroupDefaults {
                username: row.get("username"),
                identity_id: row.get("identity_id"),
                proxy_jump_host_id: row.get("proxy_jump_host_id"),
                startup_command: row.get("startup_command"),
                working_directory: row.get("working_directory"),
                environment: environment
                    .map(|value| serde_json::from_str(&value))
                    .transpose()
                    .map_err(|_| {
                        LumaError::InvalidInput("stored group environment is invalid".into())
                    })?,
                tab_color: row.get("tab_color"),
                transport: row.get("transport"),
                mosh_server_path: row.get("mosh_server_path"),
                mosh_port_range: row.get("mosh_port_range"),
            }),
            updated_at: row.get("updated_at"),
        })
    })
    .collect::<Result<Vec<_>>>()?;
    // Keep bundles from vaults that never configured a group default identical
    // to what a pre-defaults client would have written, so those users can keep
    // syncing across mixed app versions.
    //
    // Known edge: clearing the LAST default in a vault drops the key again, and
    // peers that still hold a copy keep theirs (absent means "preserve"). The
    // alternative — always emitting the key — breaks every older client even
    // for users who never touch group defaults, which is the worse trade.
    let mut host_groups = host_groups;
    if host_groups.iter().all(|group| {
        group
            .defaults
            .as_ref()
            .is_none_or(HostGroupDefaults::is_empty)
    }) {
        for group in &mut host_groups {
            group.defaults = None;
        }
    }

    let mut key_references = Vec::new();
    let mut private_key_reference_timestamps = Vec::new();
    for row in sqlx::query(
        "SELECT id,name,public_key,storage_mode,local_path,fingerprint,certificate,
                has_private_key,updated_at FROM key_references WHERE vault_id = ?1",
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await?
    {
        let id: String = row.get("id");
        let updated_at: i64 = row.get("updated_at");
        if row.get::<i64, _>("has_private_key") != 0 {
            private_key_reference_timestamps.push((id.clone(), updated_at));
        }
        key_references.push(SyncKeyReference {
            id,
            name: row.get("name"),
            public_key: row.get("public_key"),
            storage_mode: row.get("storage_mode"),
            local_path: row.get("local_path"),
            fingerprint: row.get("fingerprint"),
            certificate: row.get("certificate"),
            updated_at,
        });
    }

    let mut share_secrets = false;
    if let Some((keystore_state, _)) = private_key_sync {
        share_secrets = private_key_sync_active(pool, keystore_state, vault_id).await?;
    }

    let mut encrypted_key_secrets = Vec::new();
    if let Some((keystore_state, vault_secret)) = private_key_sync {
        if share_secrets {
            for (key_reference_id, updated_at) in private_key_reference_timestamps {
                for secret_type in [PRIVATE_KEY_SECRET_TYPE, PASSPHRASE_SECRET_TYPE] {
                    match keystore::load(
                        pool,
                        keystore_state,
                        KEYSTORE_KEY_OWNER_TYPE,
                        &key_reference_id,
                        secret_type,
                    )
                    .await
                    {
                        Ok(Some(plaintext)) => {
                            let plaintext = Zeroizing::new(plaintext);
                            encrypted_key_secrets.push(encrypt_sync_secret(
                                &key_reference_id,
                                secret_type,
                                &plaintext,
                                updated_at,
                                vault_secret,
                            )?);
                        }
                        Ok(None) => {}
                        Err(_error) if !keystore::is_unlocked(keystore_state) => {
                            encrypted_key_secrets.clear();
                            break;
                        }
                        Err(error) => return Err(error),
                    }
                }
                if !keystore::is_unlocked(keystore_state) {
                    encrypted_key_secrets.clear();
                    break;
                }
            }
        }
    }

    let mut identities_sync = Vec::new();
    let mut encrypted_identity_secrets = Vec::new();
    for row in sqlx::query(
        "SELECT id,name,username,key_id,has_password,updated_at FROM identities WHERE vault_id = ?1",
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await?
    {
        let id: String = row.get("id");
        let has_password = row.get::<i64, _>("has_password") != 0;
        let updated_at: i64 = row.get("updated_at");
        identities_sync.push(SyncIdentity {
            id: id.clone(),
            name: row.get("name"),
            username: row.get("username"),
            key_id: row.get("key_id"),
            has_password,
            updated_at,
        });
        // The personal vault reaches only your own devices, so identity passwords
        // keep travelling with it as they always have. A shared vault reaches other
        // people, so nothing secret leaves it until sharing is explicitly enabled.
        if has_password && (device_scoped || share_secrets) {
            if let Some((keystore_state, vault_secret)) = private_key_sync {
                match identities::password(pool, keystore_state, &id).await {
                    Ok(Some(password)) => encrypted_identity_secrets.push(encrypt_sync_secret(
                        &id,
                        IDENTITY_PASSWORD_SECRET_TYPE,
                        &password,
                        updated_at,
                        vault_secret,
                    )?),
                    Ok(None) => {}
                    Err(_error) if !keystore::is_unlocked(keystore_state) => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }

    let terminal_profiles = if device_scoped {
        sqlx::query(
            "SELECT id,name,shell_path,args,working_directory,environment,platform,updated_at
             FROM terminal_profiles",
        )
        .fetch_all(pool)
        .await?
    } else {
        Vec::new()
    }
    .into_iter()
    .map(|row| {
        let args: String = row.get("args");
        let environment: Option<String> = row.get("environment");
        Ok(SyncTerminalProfile {
            id: row.get("id"),
            name: row.get("name"),
            shell_path: row.get("shell_path"),
            args: serde_json::from_str(&args).map_err(|_| {
                LumaError::InvalidInput("stored profile arguments are invalid".into())
            })?,
            working_directory: row.get("working_directory"),
            environment: environment
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|_| {
                    LumaError::InvalidInput("stored profile environment is invalid".into())
                })?,
            platform: row.get("platform"),
            updated_at: row.get("updated_at"),
        })
    })
    .collect::<Result<Vec<_>>>()?;

    let snippets = sqlx::query(
        "SELECT id,name,command,description,tags,variables,host_id,updated_at FROM snippets
         WHERE vault_id = ?1",
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| {
        let tags: String = row.get("tags");
        let variables: String = row.get("variables");
        Ok(SyncSnippet {
            id: row.get("id"),
            name: row.get("name"),
            command: row.get("command"),
            description: row.get("description"),
            tags: serde_json::from_str(&tags)
                .map_err(|_| LumaError::InvalidInput("stored snippet tags are invalid".into()))?,
            variables: serde_json::from_str(&variables).map_err(|_| {
                LumaError::InvalidInput("stored snippet variables are invalid".into())
            })?,
            host_id: row.get("host_id"),
            updated_at: row.get("updated_at"),
        })
    })
    .collect::<Result<Vec<_>>>()?;

    let mut settings_map = BTreeMap::new();
    let setting_rows = if device_scoped {
        sqlx::query("SELECT key,value,updated_at FROM settings")
            .fetch_all(pool)
            .await?
    } else {
        Vec::new()
    };
    for row in setting_rows {
        let key: String = row.get("key");
        if is_safe_setting_key(&key) {
            let raw: String = row.get("value");
            settings_map.insert(
                key,
                SyncSetting {
                    value: serde_json::from_str(&raw).map_err(|_| {
                        LumaError::InvalidInput("stored setting contains invalid JSON".into())
                    })?,
                    updated_at: row.get("updated_at"),
                },
            );
        }
    }

    let tombstones =
        sqlx::query("SELECT object_type,object_id,deleted_at FROM tombstones WHERE vault_id = ?1")
            .bind(vault_id)
            .fetch_all(pool)
            .await?
            .into_iter()
            .filter_map(|row| {
                let object_type: String = row.get("object_type");
                let object_id: String = row.get("object_id");
                let carried = match object_type.as_str() {
                    "setting" => device_scoped && is_safe_setting_key(&object_id),
                    "terminal_profile" => device_scoped,
                    _ => true,
                };
                carried.then_some(SyncTombstone {
                    object_type,
                    object_id,
                    deleted_at: row.get("deleted_at"),
                })
            })
            .collect();

    let mut bundle = SyncBundle {
        format_version: FORMAT_VERSION,
        device_id,
        updated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        hosts,
        host_groups,
        key_references,
        identities: identities_sync,
        encrypted_key_secrets,
        encrypted_identity_secrets,
        terminal_profiles,
        snippets,
        settings: settings_map,
        tombstones,
    };
    // Agent identities are handles into this machine's running provider, not
    // portable credentials. Strip them and their references before the bundle
    // can be encrypted or used as a sync baseline.
    normalize_legacy_agent_auth(&mut bundle);
    validate_bundle(&bundle)?;
    Ok(bundle)
}

impl SyncBundle {
    fn counts(&self) -> ObjectCounts {
        ObjectCounts {
            hosts: self.hosts.len(),
            host_groups: self.host_groups.len(),
            key_references: self.key_references.len(),
            identities: self.identities.len(),
            terminal_profiles: self.terminal_profiles.len(),
            snippets: self.snippets.len(),
            settings: self.settings.len(),
            tombstones: self.tombstones.len(),
        }
    }

    fn states(&self) -> Result<BTreeMap<String, MergeItem>> {
        let mut states = BTreeMap::new();
        for host in &self.hosts {
            insert_object(
                &mut states,
                "host",
                &host.id,
                &host.name,
                host.updated_at,
                host,
            )?;
        }
        for group in &self.host_groups {
            insert_object(
                &mut states,
                "host_group",
                &group.id,
                &group.name,
                group.updated_at,
                group,
            )?;
        }
        for key in &self.key_references {
            insert_object(
                &mut states,
                "key_reference",
                &key.id,
                &key.name,
                key.updated_at,
                key,
            )?;
        }
        for identity in &self.identities {
            insert_object(
                &mut states,
                "identity",
                &identity.id,
                &identity.name,
                identity.updated_at,
                identity,
            )?;
        }
        for profile in &self.terminal_profiles {
            insert_object(
                &mut states,
                "terminal_profile",
                &profile.id,
                &profile.name,
                profile.updated_at,
                profile,
            )?;
        }
        for snippet in &self.snippets {
            insert_object(
                &mut states,
                "snippet",
                &snippet.id,
                &snippet.name,
                snippet.updated_at,
                snippet,
            )?;
        }
        for (key, setting) in &self.settings {
            insert_object(
                &mut states,
                "setting",
                key,
                key,
                setting.updated_at,
                setting,
            )?;
        }
        let mut tombstone_keys = HashSet::new();
        for tombstone in &self.tombstones {
            let key = object_key(&tombstone.object_type, &tombstone.object_id);
            if !tombstone_keys.insert(key.clone()) {
                return Err(LumaError::InvalidInput(
                    "sync bundle contains duplicate tombstones".into(),
                ));
            }
            let replace = states
                .get(&key)
                .is_none_or(|existing| tombstone.deleted_at >= existing.updated_at);
            if replace {
                states.insert(
                    key,
                    MergeItem {
                        object_type: tombstone.object_type.clone(),
                        object_id: tombstone.object_id.clone(),
                        label: tombstone.object_id.clone(),
                        updated_at: tombstone.deleted_at,
                        payload: None,
                    },
                );
            }
        }
        Ok(states)
    }
}

fn insert_object<T: Serialize>(
    states: &mut BTreeMap<String, MergeItem>,
    object_type: &str,
    id: &str,
    label: &str,
    updated_at: i64,
    value: &T,
) -> Result<()> {
    let key = object_key(object_type, id);
    if states.contains_key(&key) {
        return Err(LumaError::InvalidInput(format!(
            "sync bundle contains duplicate {object_type} id"
        )));
    }
    states.insert(
        key,
        MergeItem {
            object_type: object_type.into(),
            object_id: id.into(),
            label: label.into(),
            updated_at,
            payload: Some(serde_json::to_value(value).map_err(|_| {
                LumaError::InvalidInput("sync object could not be represented".into())
            })?),
        },
    );
    Ok(())
}

fn merge_bundles(
    local: &SyncBundle,
    remote: &SyncBundle,
    baseline: Option<&BTreeMap<String, String>>,
    resolutions: &[ConflictResolution],
) -> Result<MergeOutcome> {
    let local_states = local.states()?;
    let remote_states = remote.states()?;
    merge_states(&local_states, &remote_states, baseline, resolutions)
}

fn merge_states(
    local: &BTreeMap<String, MergeItem>,
    remote: &BTreeMap<String, MergeItem>,
    baseline: Option<&BTreeMap<String, String>>,
    resolutions: &[ConflictResolution],
) -> Result<MergeOutcome> {
    let mut resolution_map = BTreeMap::new();
    for resolution in resolutions {
        validate_object_type(&resolution.object_type)?;
        let key = object_key(&resolution.object_type, &resolution.object_id);
        if resolution_map.insert(key, resolution.resolution).is_some() {
            return Err(LumaError::InvalidInput(
                "duplicate conflict resolution".into(),
            ));
        }
    }

    let keys: BTreeSet<String> = local.keys().chain(remote.keys()).cloned().collect();
    let mut states = BTreeMap::new();
    let mut conflicts = Vec::new();
    let mut applied_remote = ObjectCounts::default();
    let mut kept_local = ObjectCounts::default();
    let mut remote_key_references = HashSet::new();
    let mut remote_identities = HashSet::new();
    let mut used_resolutions = HashSet::new();

    for key in keys {
        let local_item = local.get(&key);
        let remote_item = remote.get(&key);
        match (local_item, remote_item) {
            (Some(local_item), Some(remote_item)) if local_item.hash() == remote_item.hash() => {
                let selected = if remote_item.updated_at > local_item.updated_at {
                    mark_remote_object(
                        remote_item,
                        &mut remote_key_references,
                        &mut remote_identities,
                    );
                    remote_item
                } else {
                    local_item
                };
                states.insert(key, selected.clone());
            }
            (Some(local_item), Some(remote_item)) => {
                if let Some(choice) = resolution_map.get(&key) {
                    used_resolutions.insert(key.clone());
                    match choice {
                        ResolutionChoice::KeepLocal => {
                            states.insert(key, local_item.clone());
                            kept_local.increment_item(local_item);
                        }
                        ResolutionChoice::TakeRemote => {
                            states.insert(key, remote_item.clone());
                            applied_remote.increment_item(remote_item);
                            mark_remote_object(
                                remote_item,
                                &mut remote_key_references,
                                &mut remote_identities,
                            );
                        }
                    }
                    continue;
                }

                let decision = baseline.and_then(|baseline| {
                    let baseline_hash = baseline.get(&key);
                    let local_changed = baseline_hash != Some(&local_item.hash());
                    let remote_changed = baseline_hash != Some(&remote_item.hash());
                    match (local_changed, remote_changed) {
                        // SQLite timestamps have one-second resolution. Baseline hashes prove which
                        // side changed, so equal timestamps are still unambiguous here.
                        (false, true) if remote_item.updated_at >= local_item.updated_at => {
                            Some(true)
                        }
                        (true, false) if local_item.updated_at >= remote_item.updated_at => {
                            Some(false)
                        }
                        _ => None,
                    }
                });
                match decision {
                    Some(true) => {
                        states.insert(key, remote_item.clone());
                        applied_remote.increment_item(remote_item);
                        mark_remote_object(
                            remote_item,
                            &mut remote_key_references,
                            &mut remote_identities,
                        );
                    }
                    Some(false) => {
                        states.insert(key, local_item.clone());
                        kept_local.increment_item(local_item);
                    }
                    None => {
                        states.insert(key, local_item.clone());
                        conflicts.push(conflict_from(local_item, remote_item));
                    }
                }
            }
            (Some(local_item), None) => {
                states.insert(key, local_item.clone());
                kept_local.increment_item(local_item);
            }
            (None, Some(remote_item)) => {
                states.insert(key, remote_item.clone());
                applied_remote.increment_item(remote_item);
                mark_remote_object(
                    remote_item,
                    &mut remote_key_references,
                    &mut remote_identities,
                );
            }
            (None, None) => unreachable!(),
        }
    }

    if resolution_map
        .keys()
        .any(|key| !used_resolutions.contains(key))
    {
        return Err(LumaError::InvalidInput(
            "a conflict resolution does not match a current conflict".into(),
        ));
    }
    Ok(MergeOutcome {
        states,
        conflicts,
        applied_remote,
        kept_local,
        remote_key_references,
        remote_identities,
    })
}

fn mark_remote_object(
    item: &MergeItem,
    key_ids: &mut HashSet<String>,
    identity_ids: &mut HashSet<String>,
) {
    if item.object_type == "key_reference" && item.payload.is_some() {
        key_ids.insert(item.object_id.clone());
    }
    if item.object_type == "identity" && item.payload.is_some() {
        identity_ids.insert(item.object_id.clone());
    }
}

fn conflict_from(local: &MergeItem, remote: &MergeItem) -> Conflict {
    Conflict {
        object_type: local.object_type.clone(),
        object_id: local.object_id.clone(),
        label: if local.label.is_empty() {
            remote.label.clone()
        } else {
            local.label.clone()
        },
        local_updated_at: Some(local.updated_at),
        remote_updated_at: Some(remote.updated_at),
    }
}

fn validate_bundle(bundle: &SyncBundle) -> Result<()> {
    let serialized = serde_json::to_string(bundle)
        .map_err(|_| LumaError::InvalidInput("sync bundle could not be validated".into()))?;
    if crate::logging::redact(&serialized) != serialized {
        return Err(LumaError::InvalidInput(
            "sync data appears to contain embedded secret material; remove it before syncing"
                .into(),
        ));
    }
    if bundle.format_version != FORMAT_VERSION {
        return Err(LumaError::InvalidInput(format!(
            "unsupported sync format version {}",
            bundle.format_version
        )));
    }
    uuid::Uuid::parse_str(&bundle.device_id)
        .map_err(|_| LumaError::InvalidInput("sync bundle deviceId is invalid".into()))?;
    chrono::DateTime::parse_from_rfc3339(&bundle.updated_at)
        .map_err(|_| LumaError::InvalidInput("sync bundle updatedAt is invalid".into()))?;
    for (name, count) in [
        ("hosts", bundle.hosts.len()),
        ("hostGroups", bundle.host_groups.len()),
        ("keyReferences", bundle.key_references.len()),
        ("identities", bundle.identities.len()),
        ("terminalProfiles", bundle.terminal_profiles.len()),
        ("snippets", bundle.snippets.len()),
        ("settings", bundle.settings.len()),
        ("tombstones", bundle.tombstones.len()),
    ] {
        if count > MAX_OBJECTS_PER_TYPE {
            return Err(LumaError::InvalidInput(format!(
                "sync bundle contains too many {name}"
            )));
        }
    }
    if bundle.encrypted_key_secrets.len() > MAX_ENCRYPTED_KEY_SECRETS {
        return Err(LumaError::InvalidInput(
            "sync bundle contains too many encryptedKeySecrets".into(),
        ));
    }
    if bundle.encrypted_identity_secrets.len() > MAX_OBJECTS_PER_TYPE {
        return Err(LumaError::InvalidInput(
            "sync bundle contains too many encryptedIdentitySecrets".into(),
        ));
    }
    let mut secret_ids = HashSet::new();
    let mut salt_nonces = HashSet::new();
    for secret in &bundle.encrypted_key_secrets {
        validate_encrypted_secret_metadata(secret)?;
        let (salt, nonce, _) = decode_sync_secret_parts(secret)?;
        if !secret_ids.insert((secret.key_reference_id.clone(), secret.secret_type.clone())) {
            return Err(LumaError::InvalidInput(
                "sync bundle contains duplicate encrypted key secrets".into(),
            ));
        }
        if !salt_nonces.insert((salt, nonce)) {
            return Err(LumaError::InvalidInput(
                "sync bundle reuses encrypted key secret salt and nonce values".into(),
            ));
        }
    }
    for secret in &bundle.encrypted_identity_secrets {
        validate_encrypted_identity_secret_metadata(secret)?;
        let (salt, nonce, _) = decode_sync_secret_parts(secret)?;
        if !secret_ids.insert((
            format!("identity:{}", secret.key_reference_id),
            secret.secret_type.clone(),
        )) {
            return Err(LumaError::InvalidInput(
                "sync bundle contains duplicate encrypted identity secrets".into(),
            ));
        }
        if !salt_nonces.insert((salt, nonce)) {
            return Err(LumaError::InvalidInput(
                "sync bundle reuses encrypted secret salt and nonce values".into(),
            ));
        }
    }
    let states = bundle.states()?;
    validate_states(&states)
}

fn validate_encrypted_secret_metadata(secret: &SyncEncryptedSecret) -> Result<()> {
    if secret.key_reference_id.is_empty()
        || secret.key_reference_id.len() > 512
        || secret.key_reference_id.contains('\0')
        || !matches!(
            secret.secret_type.as_str(),
            PRIVATE_KEY_SECRET_TYPE | PASSPHRASE_SECRET_TYPE
        )
        || (secret.kdf_id != KDF_ARGON2ID && secret.kdf_id != KDF_HKDF_CONTENT_KEY)
        || secret.cipher_id != CIPHER_XCHACHA20_POLY1305
        || secret.updated_at < 0
    {
        return Err(LumaError::InvalidInput(
            "encrypted key secret metadata is invalid or unsupported".into(),
        ));
    }
    Ok(())
}

fn validate_encrypted_identity_secret_metadata(secret: &SyncEncryptedSecret) -> Result<()> {
    if secret.key_reference_id.is_empty()
        || secret.key_reference_id.len() > 512
        || secret.key_reference_id.contains('\0')
        || secret.secret_type != IDENTITY_PASSWORD_SECRET_TYPE
        || (secret.kdf_id != KDF_ARGON2ID && secret.kdf_id != KDF_HKDF_CONTENT_KEY)
        || secret.cipher_id != CIPHER_XCHACHA20_POLY1305
        || secret.updated_at < 0
    {
        return Err(LumaError::InvalidInput(
            "encrypted identity secret metadata is invalid or unsupported".into(),
        ));
    }
    Ok(())
}

fn validate_states(states: &BTreeMap<String, MergeItem>) -> Result<()> {
    let mut group_parents = HashMap::new();
    let mut host_proxies = HashMap::new();
    let mut group_ids = HashSet::new();
    let mut key_ids = HashSet::new();
    let mut identity_ids = HashSet::new();
    let mut identity_keys = HashMap::new();
    let mut host_ids = HashSet::new();

    for item in states.values() {
        validate_object_type(&item.object_type)?;
        if item.object_id.is_empty()
            || item.object_id.len() > 512
            || item.object_id.contains('\0')
            || item.updated_at < 0
        {
            return Err(LumaError::InvalidInput(
                "sync object id or timestamp is invalid".into(),
            ));
        }
        if item.payload.is_none() {
            continue;
        }
        match item.object_type.as_str() {
            "host_group" => {
                let group: SyncHostGroup = payload_as(item)?;
                host_groups::validate_name(&group.name)?;
                if let Some(defaults) = group.defaults.as_ref() {
                    host_groups::validate_defaults(defaults)?;
                }
                group_ids.insert(group.id.clone());
                group_parents.insert(group.id, group.parent_id);
            }
            "key_reference" => {
                let key: SyncKeyReference = payload_as(item)?;
                key_references::validate(&key_references::KeyReferenceInput {
                    vault_id: crate::storage::vaults::default_id(),
                    name: key.name,
                    public_key: key.public_key,
                    storage_mode: key.storage_mode,
                    local_path: key.local_path,
                    fingerprint: key.fingerprint,
                    certificate: key.certificate,
                    private_key: None,
                    passphrase: None,
                })?;
                key_ids.insert(key.id);
            }
            "host" => {
                let host: SyncHost = payload_as(item)?;
                hosts::validate_fields(&hosts::HostInput {
                    vault_id: crate::storage::vaults::default_id(),
                    name: host.name,
                    hostname: host.hostname,
                    port: i64::from(host.port),
                    username: host.username,
                    group_id: host.group_id.clone(),
                    authentication_type: host.authentication_type,
                    key_id: host.key_id.clone(),
                    identity_id: host.identity_id.clone(),
                    proxy_jump_host_id: host.proxy_jump_host_id.clone(),
                    startup_command: host.startup_command,
                    working_directory: host.working_directory,
                    environment: host.environment,
                    tags: host.tags,
                    favorite: host.favorite,
                    tab_color: host.tab_color,
                    transport: host.transport,
                    mosh_server_path: host.mosh_server_path,
                    mosh_port_range: host.mosh_port_range,
                })?;
                host_ids.insert(host.id.clone());
                host_proxies.insert(
                    host.id,
                    (
                        host.group_id,
                        host.key_id,
                        host.identity_id,
                        host.proxy_jump_host_id,
                    ),
                );
            }
            "identity" => {
                let identity: SyncIdentity = payload_as(item)?;
                let username = identity.username.trim();
                if identity.name.trim().is_empty()
                    || identity.name.len() > 128
                    || username.is_empty()
                    || username.len() > 255
                    || username.chars().any(char::is_whitespace)
                    || username.starts_with('-')
                {
                    return Err(LumaError::InvalidInput("synced identity is invalid".into()));
                }
                identity_ids.insert(identity.id.clone());
                identity_keys.insert(identity.id, identity.key_id);
            }
            "terminal_profile" => validate_sync_profile(&payload_as::<SyncTerminalProfile>(item)?)?,
            "snippet" => {
                let snippet: SyncSnippet = payload_as(item)?;
                snippets::validate_fields(&snippets::SnippetInput {
                    vault_id: crate::storage::vaults::default_id(),
                    name: snippet.name,
                    command: snippet.command,
                    description: snippet.description,
                    tags: snippet.tags,
                    variables: snippet.variables,
                    host_id: snippet.host_id.clone(),
                })?;
                if let Some(host_id) = snippet.host_id {
                    if !host_ids.contains(&host_id) {
                        return Err(LumaError::InvalidInput(
                            "synced snippet references an unknown host".into(),
                        ));
                    }
                }
            }
            "setting" => {
                settings::validate_key(&item.object_id)?;
                if !is_safe_setting_key(&item.object_id) {
                    return Err(LumaError::InvalidInput(
                        "sync bundle contains a sensitive setting key".into(),
                    ));
                }
                let setting: SyncSetting = payload_as(item)?;
                if serde_json::to_vec(&setting.value)
                    .map_err(|_| LumaError::InvalidInput("setting value is invalid".into()))?
                    .len()
                    > 64 * 1024
                {
                    return Err(LumaError::InvalidInput("setting value too large".into()));
                }
            }
            _ => unreachable!(),
        }
    }

    for (group_id, parent_id) in &group_parents {
        if let Some(parent_id) = parent_id {
            if !group_ids.contains(parent_id) {
                return Err(LumaError::InvalidInput(
                    "synced host group references an unknown parent".into(),
                ));
            }
            detect_cycle(group_id, &group_parents, "host group parent", 64)?;
        }
    }
    for key_id in identity_keys.values().flatten() {
        if !key_ids.contains(key_id) {
            return Err(LumaError::InvalidInput(
                "synced identity references an unknown key".into(),
            ));
        }
    }
    for (host_id, (group_id, key_id, identity_id, proxy_id)) in &host_proxies {
        if group_id.as_ref().is_some_and(|id| !group_ids.contains(id)) {
            return Err(LumaError::InvalidInput(
                "synced host references an unknown group".into(),
            ));
        }
        if key_id.as_ref().is_some_and(|id| !key_ids.contains(id)) {
            return Err(LumaError::InvalidInput(
                "synced host references an unknown key".into(),
            ));
        }
        if identity_id
            .as_ref()
            .is_some_and(|id| !identity_ids.contains(id))
        {
            return Err(LumaError::InvalidInput(
                "synced host references an unknown identity".into(),
            ));
        }
        if proxy_id.as_ref().is_some_and(|id| !host_ids.contains(id)) {
            return Err(LumaError::InvalidInput(
                "synced host references an unknown proxy jump host".into(),
            ));
        }
        let proxy_map: HashMap<String, Option<String>> = host_proxies
            .iter()
            .map(|(id, (_, _, _, proxy))| (id.clone(), proxy.clone()))
            .collect();
        // The existing host validator permits eight proxy hops plus the host itself.
        detect_cycle(host_id, &proxy_map, "proxy jump", 9)?;
    }
    Ok(())
}

fn detect_cycle(
    start: &str,
    links: &HashMap<String, Option<String>>,
    label: &str,
    max_depth: usize,
) -> Result<()> {
    let mut seen = HashSet::new();
    let mut current = Some(start.to_string());
    let mut depth = 0;
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            return Err(LumaError::InvalidInput(format!(
                "synced {label} relationship contains a cycle"
            )));
        }
        depth += 1;
        if depth > max_depth {
            return Err(LumaError::InvalidInput(format!(
                "synced {label} relationship is too deep"
            )));
        }
        current = links.get(&id).cloned().flatten();
    }
    Ok(())
}

fn validate_sync_profile(profile: &SyncTerminalProfile) -> Result<()> {
    if profile.name.trim().is_empty() || profile.name.len() > 64 || profile.name.contains('\0') {
        return Err(LumaError::InvalidInput(
            "profile name must be 1-64 characters".into(),
        ));
    }
    if profile.shell_path.trim().is_empty()
        || profile.shell_path.len() > 4096
        || profile.shell_path.contains('\0')
    {
        return Err(LumaError::InvalidInput(
            "profile shellPath is invalid".into(),
        ));
    }
    if profile.args.len() > 32
        || profile
            .args
            .iter()
            .any(|argument| argument.len() > 16 * 1024 || argument.contains('\0'))
    {
        return Err(LumaError::InvalidInput(
            "profile arguments are invalid".into(),
        ));
    }
    if profile
        .working_directory
        .as_ref()
        .is_some_and(|path| path.len() > 4096 || path.contains('\0'))
    {
        return Err(LumaError::InvalidInput(
            "profile workingDirectory is invalid".into(),
        ));
    }
    if profile.environment.as_ref().is_some_and(|environment| {
        environment.len() > 64
            || environment.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > 128
                    || key.contains('=')
                    || key.contains('\0')
                    || value.len() > 16 * 1024
                    || value.contains('\0')
            })
    }) {
        return Err(LumaError::InvalidInput(
            "profile environment is invalid".into(),
        ));
    }
    if profile
        .platform
        .as_deref()
        .is_some_and(|platform| !matches!(platform, "windows" | "macos" | "linux"))
    {
        return Err(LumaError::InvalidInput(
            "profile platform is invalid".into(),
        ));
    }
    Ok(())
}

fn prepare_remote_secrets(
    keystore_state: &KeystoreState,
    vault_secret: &VaultSecret,
    incoming: &[SyncEncryptedSecret],
    merged_states: &BTreeMap<String, MergeItem>,
    remote_key_references: &HashSet<String>,
) -> Result<PreparedRemoteSecrets> {
    let entries: Vec<SyncEncryptedSecret> = incoming
        .iter()
        .filter(|secret| {
            remote_key_references.contains(&secret.key_reference_id)
                && merged_states
                    .get(&object_key("key_reference", &secret.key_reference_id))
                    .is_some_and(|item| item.payload.is_some())
        })
        .cloned()
        .collect();
    if !keystore::is_unlocked(keystore_state) {
        return Ok(PreparedRemoteSecrets {
            skipped_locked: entries
                .iter()
                .filter(|secret| secret.secret_type == PRIVATE_KEY_SECRET_TYPE)
                .map(|secret| secret.key_reference_id.as_str())
                .collect::<HashSet<_>>()
                .len(),
            entries: Vec::new(),
        });
    }

    // Authenticate every selected secret before metadata writes begin. This prevents a
    // corrupted nested ciphertext from producing a partial import or sync apply.
    for secret in &entries {
        drop(decrypt_sync_secret(secret, vault_secret)?);
    }
    Ok(PreparedRemoteSecrets {
        entries,
        skipped_locked: 0,
    })
}

fn prepare_remote_identity_secrets(
    keystore_state: &KeystoreState,
    vault_secret: &VaultSecret,
    incoming: &[SyncEncryptedSecret],
    merged_states: &BTreeMap<String, MergeItem>,
    remote_identities: &HashSet<String>,
) -> Result<Vec<SyncEncryptedSecret>> {
    if !identity_secret_store_available(keystore_state) {
        return Ok(Vec::new());
    }
    let entries: Vec<_> = incoming
        .iter()
        .filter(|secret| {
            remote_identities.contains(&secret.key_reference_id)
                && merged_states
                    .get(&object_key("identity", &secret.key_reference_id))
                    .is_some_and(|item| item.payload.is_some())
        })
        .cloned()
        .collect();
    for secret in &entries {
        drop(decrypt_sync_secret(secret, vault_secret)?);
    }
    Ok(entries)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn identity_secret_store_available(_keystore_state: &KeystoreState) -> bool {
    true
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn identity_secret_store_available(keystore_state: &KeystoreState) -> bool {
    keystore::is_unlocked(keystore_state)
}

async fn apply_prepared_secrets(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    vault_secret: &VaultSecret,
    prepared: PreparedRemoteSecrets,
) -> Result<PrivateKeyApplySummary> {
    let mut summary = PrivateKeyApplySummary {
        applied: 0,
        skipped_locked: prepared.skipped_locked,
    };
    let mut applied_private_key_ids = HashSet::new();
    for (index, secret) in prepared.entries.iter().enumerate() {
        if !keystore::is_unlocked(keystore_state) {
            summary.skipped_locked += prepared.entries[index..]
                .iter()
                .filter(|remaining| remaining.secret_type == PRIVATE_KEY_SECRET_TYPE)
                .map(|remaining| remaining.key_reference_id.as_str())
                .filter(|id| !applied_private_key_ids.contains(*id))
                .collect::<HashSet<_>>()
                .len();
            break;
        }
        let plaintext = decrypt_sync_secret(secret, vault_secret)?;
        match keystore::store(
            pool,
            keystore_state,
            KEYSTORE_KEY_OWNER_TYPE,
            &secret.key_reference_id,
            &secret.secret_type,
            &plaintext,
        )
        .await
        {
            Ok(()) => {}
            Err(_error) if !keystore::is_unlocked(keystore_state) => {
                summary.skipped_locked += prepared.entries[index..]
                    .iter()
                    .filter(|remaining| remaining.secret_type == PRIVATE_KEY_SECRET_TYPE)
                    .map(|remaining| remaining.key_reference_id.as_str())
                    .filter(|id| !applied_private_key_ids.contains(*id))
                    .collect::<HashSet<_>>()
                    .len();
                break;
            }
            Err(error) => return Err(error),
        }
        drop(plaintext);
        if secret.secret_type == PRIVATE_KEY_SECRET_TYPE
            && applied_private_key_ids.insert(secret.key_reference_id.clone())
        {
            sqlx::query("UPDATE key_references SET has_private_key=1 WHERE id=?1")
                .bind(&secret.key_reference_id)
                .execute(pool)
                .await?;
            summary.applied += 1;
        }
    }
    Ok(summary)
}

async fn apply_prepared_identity_secrets(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    vault_secret: &VaultSecret,
    prepared: Vec<SyncEncryptedSecret>,
) -> Result<usize> {
    let mut applied = 0;
    for secret in prepared {
        if !identity_secret_store_available(keystore_state) {
            break;
        }
        let plaintext = decrypt_sync_secret(&secret, vault_secret)?;
        identities::set_synced_password(pool, keystore_state, &secret.key_reference_id, &plaintext)
            .await?;
        applied += 1;
    }
    Ok(applied)
}

async fn apply_states(
    pool: &SqlitePool,
    states: &BTreeMap<String, MergeItem>,
    vault_id: &str,
) -> Result<()> {
    let mut deleted_key_references = Vec::new();
    let mut deleted_identities = Vec::new();
    let mut transaction = pool.begin().await?;
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *transaction)
        .await?;
    for item in states.values() {
        match &item.payload {
            None => {
                // Scoped by vault so a deletion arriving for one vault can never
                // reach a same-id row another vault owns. terminal_profiles and
                // settings have no vault column and only ever reach the personal
                // bundle, so they stay keyed on their own primary key.
                let query = match item.object_type.as_str() {
                    "host" => "DELETE FROM hosts WHERE id = ?1 AND vault_id = ?2",
                    "host_group" => "DELETE FROM host_groups WHERE id = ?1 AND vault_id = ?2",
                    "key_reference" => "DELETE FROM key_references WHERE id = ?1 AND vault_id = ?2",
                    "identity" => "DELETE FROM identities WHERE id = ?1 AND vault_id = ?2",
                    "snippet" => "DELETE FROM snippets WHERE id = ?1 AND vault_id = ?2",
                    "terminal_profile" => "DELETE FROM terminal_profiles WHERE id = ?1",
                    "setting" => "DELETE FROM settings WHERE key = ?1",
                    _ => return Err(LumaError::InvalidInput("unknown sync object type".into())),
                };
                let mut delete = sqlx::query(query).bind(&item.object_id);
                if !matches!(item.object_type.as_str(), "terminal_profile" | "setting") {
                    delete = delete.bind(vault_id);
                }
                let removed = delete.execute(&mut *transaction).await?.rows_affected() > 0;
                // Only drop the secrets once the row they belong to is gone: a
                // deletion aimed at another vault's object must not take this
                // vault's key material with it.
                if removed && item.object_type == "key_reference" {
                    deleted_key_references.push(item.object_id.clone());
                }
                if removed && item.object_type == "identity" {
                    deleted_identities.push(item.object_id.clone());
                    sqlx::query(
                        "DELETE FROM keystore_secrets WHERE owner_type='identity' AND owner_id=?1",
                    )
                    .bind(&item.object_id)
                    .execute(&mut *transaction)
                    .await?;
                }
                sqlx::query(
                    "INSERT INTO tombstones(vault_id,object_type,object_id,deleted_at) VALUES(?1,?2,?3,?4)
                     ON CONFLICT(vault_id,object_type,object_id) DO UPDATE SET deleted_at=excluded.deleted_at",
                )
                .bind(vault_id)
                .bind(&item.object_type)
                .bind(&item.object_id)
                .bind(item.updated_at)
                .execute(&mut *transaction)
                .await?;
            }
            Some(_) => {
                apply_object(&mut transaction, item, vault_id).await?;
                sqlx::query(
                    "DELETE FROM tombstones WHERE vault_id=?1 AND object_type=?2 AND object_id=?3",
                )
                .bind(vault_id)
                .bind(&item.object_type)
                .bind(&item.object_id)
                .execute(&mut *transaction)
                .await?;
            }
        }
    }
    transaction.commit().await?;
    for id in deleted_key_references {
        key_references::purge_secrets(&id);
    }
    for id in deleted_identities {
        identities::purge_synced_password(&id);
    }
    Ok(())
}

/// A shared vault's bundle is authored by other people, so an object arriving in
/// it must never be able to rewrite a row that belongs to a different vault —
/// otherwise a member of one shared vault could repoint a host in your personal
/// vault at their own server. Every upsert therefore only updates a row whose
/// vault matches, and leaves other vaults' rows untouched.
/// A host's current key reference and auth type, but only when that key is an
/// SSH-agent reference — a device-bound handle that sync deliberately never
/// carries. `None` for every other host, so ordinary key changes still sync.
async fn local_agent_binding(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    host_id: &str,
) -> Result<Option<(String, String)>> {
    let row = sqlx::query(
        "SELECT hosts.key_id, hosts.auth_type FROM hosts
         JOIN key_references ON key_references.id = hosts.key_id
         WHERE hosts.id = ?1 AND key_references.storage_mode = 'ssh-agent'",
    )
    .bind(host_id)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(row.map(|row| (row.get("key_id"), row.get("auth_type"))))
}

async fn apply_object(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    item: &MergeItem,
    vault_id: &str,
) -> Result<()> {
    match item.object_type.as_str() {
        "host_group" => {
            let value: SyncHostGroup = payload_as(item)?;
            let Some(defaults) = value.defaults else {
                // A peer that predates group defaults: it can rename or reparent
                // the group, but it knows nothing about the default columns, so
                // they stay exactly as they are.
                sqlx::query(
                    "INSERT INTO host_groups(id,name,parent_id,sort_order,vault_id,created_at,updated_at)
                     VALUES(?1,?2,?3,?4,?5,?6,?6)
                     ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,
                     sort_order=excluded.sort_order,updated_at=excluded.updated_at
                     WHERE host_groups.vault_id=excluded.vault_id",
                )
                .bind(value.id)
                .bind(value.name)
                .bind(value.parent_id)
                .bind(value.sort_order)
                .bind(vault_id)
                .bind(value.updated_at)
                .execute(&mut **transaction)
                .await?;
                return Ok(());
            };
            let environment = defaults
                .environment
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| {
                    LumaError::InvalidInput("group environment cannot be serialized".into())
                })?;
            sqlx::query(
                "INSERT INTO host_groups(id,name,parent_id,sort_order,vault_id,created_at,updated_at,
                 username,identity_id,proxy_jump_host_id,startup_command,working_directory,
                 environment,tab_color,transport,mosh_server_path,mosh_port_range)
                 VALUES(?1,?2,?3,?4,?5,?6,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,
                 sort_order=excluded.sort_order,updated_at=excluded.updated_at,
                 username=excluded.username,identity_id=excluded.identity_id,
                 proxy_jump_host_id=excluded.proxy_jump_host_id,
                 startup_command=excluded.startup_command,
                 working_directory=excluded.working_directory,environment=excluded.environment,
                 tab_color=excluded.tab_color,transport=excluded.transport,
                 mosh_server_path=excluded.mosh_server_path,
                 mosh_port_range=excluded.mosh_port_range
                 WHERE host_groups.vault_id=excluded.vault_id",
            )
            .bind(value.id)
            .bind(value.name)
            .bind(value.parent_id)
            .bind(value.sort_order)
            .bind(vault_id)
            .bind(value.updated_at)
            .bind(defaults.username)
            .bind(defaults.identity_id)
            .bind(defaults.proxy_jump_host_id)
            .bind(defaults.startup_command)
            .bind(defaults.working_directory)
            .bind(environment)
            .bind(defaults.tab_color)
            .bind(defaults.transport)
            .bind(defaults.mosh_server_path)
            .bind(defaults.mosh_port_range)
            .execute(&mut **transaction)
            .await?;
        }
        "key_reference" => {
            let value: SyncKeyReference = payload_as(item)?;
            sqlx::query(
                "INSERT INTO key_references(id,name,public_key,storage_mode,local_path,fingerprint,
                 certificate,has_private_key,vault_id,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8,?9,?9)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,public_key=excluded.public_key,
                 storage_mode=excluded.storage_mode,local_path=excluded.local_path,
                 fingerprint=excluded.fingerprint,certificate=excluded.certificate,
                 updated_at=excluded.updated_at
                 WHERE key_references.vault_id=excluded.vault_id",
            )
            .bind(value.id)
            .bind(value.name)
            .bind(value.public_key)
            .bind(value.storage_mode)
            .bind(value.local_path)
            .bind(value.fingerprint)
            .bind(value.certificate)
            .bind(vault_id)
            .bind(value.updated_at)
            .execute(&mut **transaction)
            .await?;
        }
        "identity" => {
            let value: SyncIdentity = payload_as(item)?;
            sqlx::query(
                "INSERT INTO identities(id,name,username,key_id,has_password,vault_id,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,0,?5,?6,?6)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username,
                 key_id=excluded.key_id,updated_at=excluded.updated_at
                 WHERE identities.vault_id=excluded.vault_id",
            )
            .bind(value.id)
            .bind(value.name)
            .bind(value.username)
            .bind(value.key_id)
            .bind(vault_id)
            .bind(value.updated_at)
            .execute(&mut **transaction)
            .await?;
        }
        "host" => {
            let mut value: SyncHost = payload_as(item)?;
            // Every bundle — including the one assembled from this device — has
            // its SSH-agent references stripped, because they are handles into
            // a local provider and mean nothing on another machine. Writing
            // that stripped shape back would clear the binding on the device
            // that owns it, so a host currently pointing at an agent key keeps
            // its key and auth type whatever sync says.
            if value.key_id.is_none() {
                if let Some((key_id, auth_type)) =
                    local_agent_binding(transaction, &value.id).await?
                {
                    value.key_id = Some(key_id);
                    value.authentication_type = auth_type;
                }
            }
            sqlx::query(
                "INSERT INTO hosts(id,name,hostname,port,username,group_id,auth_type,key_id,identity_id,
                 proxy_jump_host_id,startup_command,working_directory,environment,tags,favorite,tab_color,
                 transport,mosh_server_path,mosh_port_range,vault_id,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?21)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,hostname=excluded.hostname,
                 port=excluded.port,username=excluded.username,group_id=excluded.group_id,
                 auth_type=excluded.auth_type,key_id=excluded.key_id,identity_id=excluded.identity_id,
                 proxy_jump_host_id=excluded.proxy_jump_host_id,startup_command=excluded.startup_command,
                 working_directory=excluded.working_directory,environment=excluded.environment,
                 tags=excluded.tags,favorite=excluded.favorite,tab_color=excluded.tab_color,
                 transport=excluded.transport,mosh_server_path=excluded.mosh_server_path,
                 mosh_port_range=excluded.mosh_port_range,updated_at=excluded.updated_at
                 WHERE hosts.vault_id=excluded.vault_id",
            )
            .bind(value.id)
            .bind(value.name)
            .bind(value.hostname)
            .bind(i64::from(value.port))
            .bind(value.username)
            .bind(value.group_id)
            .bind(value.authentication_type)
            .bind(value.key_id)
            .bind(value.identity_id)
            .bind(value.proxy_jump_host_id)
            .bind(value.startup_command)
            .bind(value.working_directory)
            .bind(value.environment.map(|environment| serde_json::to_string(&environment)).transpose().map_err(|_| LumaError::InvalidInput("host environment is invalid".into()))?)
            .bind(serde_json::to_string(&value.tags).map_err(|_| LumaError::InvalidInput("host tags are invalid".into()))?)
            .bind(value.favorite)
            .bind(value.tab_color)
            .bind(value.transport)
            .bind(value.mosh_server_path)
            .bind(value.mosh_port_range)
            .bind(vault_id)
            .bind(value.updated_at)
            .execute(&mut **transaction)
            .await?;
        }
        "terminal_profile" => {
            let value: SyncTerminalProfile = payload_as(item)?;
            sqlx::query(
                "INSERT INTO terminal_profiles(id,name,shell_path,args,working_directory,environment,
                 platform,is_default,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8,?8)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,shell_path=excluded.shell_path,
                 args=excluded.args,working_directory=excluded.working_directory,
                 environment=excluded.environment,platform=excluded.platform,updated_at=excluded.updated_at",
            )
            .bind(value.id)
            .bind(value.name)
            .bind(value.shell_path)
            .bind(serde_json::to_string(&value.args).map_err(|_| LumaError::InvalidInput("profile arguments are invalid".into()))?)
            .bind(value.working_directory)
            .bind(value.environment.map(|environment| serde_json::to_string(&environment)).transpose().map_err(|_| LumaError::InvalidInput("profile environment is invalid".into()))?)
            .bind(value.platform)
            .bind(value.updated_at)
            .execute(&mut **transaction)
            .await?;
        }
        "snippet" => {
            let value: SyncSnippet = payload_as(item)?;
            sqlx::query(
                "INSERT INTO snippets(id,name,command,description,tags,variables,host_id,vault_id,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,command=excluded.command,
                 description=excluded.description,tags=excluded.tags,variables=excluded.variables,
                 host_id=excluded.host_id,updated_at=excluded.updated_at
                 WHERE snippets.vault_id=excluded.vault_id",
            )
            .bind(value.id)
            .bind(value.name)
            .bind(value.command)
            .bind(value.description)
            .bind(serde_json::to_string(&value.tags).map_err(|_| LumaError::InvalidInput("snippet tags are invalid".into()))?)
            .bind(serde_json::to_string(&value.variables).map_err(|_| LumaError::InvalidInput("snippet variables are invalid".into()))?)
            .bind(value.host_id)
            .bind(vault_id)
            .bind(value.updated_at)
            .execute(&mut **transaction)
            .await?;
        }
        "setting" => {
            let value: SyncSetting = payload_as(item)?;
            sqlx::query(
                "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            )
            .bind(&item.object_id)
            .bind(serde_json::to_string(&value.value).map_err(|_| LumaError::InvalidInput("setting value is invalid".into()))?)
            .bind(value.updated_at)
            .execute(&mut **transaction)
            .await?;
        }
        _ => return Err(LumaError::InvalidInput("unknown sync object type".into())),
    }
    Ok(())
}

fn payload_as<T: for<'de> Deserialize<'de>>(item: &MergeItem) -> Result<T> {
    serde_json::from_value(
        item.payload
            .clone()
            .ok_or_else(|| LumaError::InvalidInput("sync object has no payload".into()))?,
    )
    .map_err(|_| LumaError::InvalidInput("sync object payload is invalid".into()))
}

fn validate_passphrase(passphrase: &str) -> Result<()> {
    if passphrase.len() < 8 || passphrase.len() > 1024 || passphrase.contains('\0') {
        return Err(LumaError::InvalidInput(
            "sync passphrase must be 8-1024 characters and contain no null character".into(),
        ));
    }
    Ok(())
}

fn validate_file_path(path: &str, app_data_dir: &Path, require_file: bool) -> Result<PathBuf> {
    if path.trim().is_empty() || path.contains('\0') || path.len() > 32_768 {
        return Err(LumaError::InvalidInput("file path is invalid".into()));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(LumaError::InvalidInput("file path must be absolute".into()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| LumaError::InvalidInput("file path has no parent directory".into()))?;
    if !parent.is_dir() {
        return Err(LumaError::InvalidInput(
            "file parent directory does not exist".into(),
        ));
    }
    if require_file && !path.is_file() {
        return Err(LumaError::InvalidInput(
            "encrypted sync file does not exist".into(),
        ));
    }
    reject_app_data_path(&path, app_data_dir)?;
    Ok(path)
}

fn reject_app_data_path(path: &Path, app_data_dir: &Path) -> Result<()> {
    let canonical_app = app_data_dir
        .canonicalize()
        .unwrap_or_else(|_| app_data_dir.to_path_buf());
    let canonical_path = if path.exists() {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    } else if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        parent
            .canonicalize()
            .unwrap_or_else(|_| parent.to_path_buf())
            .join(name)
    } else {
        path.to_path_buf()
    };
    if canonical_path.starts_with(canonical_app) {
        return Err(LumaError::InvalidInput(
            "sync files may not be placed inside Luma's application data directory".into(),
        ));
    }
    Ok(())
}

fn read_encrypted_bundle(path: &str, app_data_dir: &Path, passphrase: &str) -> Result<SyncBundle> {
    let path = validate_file_path(path, app_data_dir, true)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() > MAX_BLOB_BYTES as u64 {
        return Err(LumaError::InvalidInput(
            "encrypted sync file exceeds the size limit".into(),
        ));
    }
    let blob = fs::read(path)?;
    decrypt_bundle(&blob, &VaultSecret::from(passphrase))
}

fn is_safe_setting_key(key: &str) -> bool {
    if key == settings::SYNC_INCLUDE_PRIVATE_KEYS_KEY {
        return false;
    }
    let normalized = key.to_ascii_lowercase().replace('_', "-");
    ![
        "password",
        "passphrase",
        "token",
        "secret",
        "private-key",
        "credential",
        "api-key",
        "authorization",
        "keystore",
        "vault",
        "sync.",
        "sync-",
    ]
    .iter()
    .any(|sensitive| normalized.contains(sensitive))
}

fn validate_object_type(object_type: &str) -> Result<()> {
    if matches!(
        object_type,
        "host"
            | "host_group"
            | "key_reference"
            | "identity"
            | "terminal_profile"
            | "snippet"
            | "setting"
    ) {
        Ok(())
    } else {
        Err(LumaError::InvalidInput(format!(
            "unknown sync object type: {object_type}"
        )))
    }
}

fn object_key(object_type: &str, object_id: &str) -> String {
    format!("{object_type}\u{1f}{object_id}")
}

impl ObjectCounts {
    fn increment_item(&mut self, item: &MergeItem) {
        match item.object_type.as_str() {
            "host" => self.hosts += 1,
            "host_group" => self.host_groups += 1,
            "key_reference" => self.key_references += 1,
            "identity" => self.identities += 1,
            "terminal_profile" => self.terminal_profiles += 1,
            "snippet" => self.snippets += 1,
            "setting" => self.settings += 1,
            _ => {}
        }
        if item.payload.is_none() {
            self.tombstones += 1;
        }
    }

    fn is_empty(&self) -> bool {
        self.hosts == 0
            && self.host_groups == 0
            && self.key_references == 0
            && self.identities == 0
            && self.terminal_profiles == 0
            && self.snippets == 0
            && self.settings == 0
            && self.tombstones == 0
    }
}

fn baseline_for_bundle(bundle: &SyncBundle) -> Result<BTreeMap<String, String>> {
    Ok(bundle
        .states()?
        .into_iter()
        .map(|(key, item)| (key, item.hash()))
        .collect())
}

fn bundles_have_same_content(
    left: &SyncBundle,
    right: &SyncBundle,
    vault_secret: &VaultSecret,
    compare_private_keys: bool,
) -> Result<bool> {
    if baseline_for_bundle(left)? != baseline_for_bundle(right)? {
        return Ok(false);
    }
    if identity_secret_content_hashes(left, vault_secret)?
        != identity_secret_content_hashes(right, vault_secret)?
    {
        return Ok(false);
    }
    if !compare_private_keys {
        return Ok(true);
    }
    Ok(secret_content_hashes(left, vault_secret)? == secret_content_hashes(right, vault_secret)?)
}

fn identity_secret_content_hashes(
    bundle: &SyncBundle,
    vault_secret: &VaultSecret,
) -> Result<BTreeMap<String, [u8; 32]>> {
    let mut hashes = BTreeMap::new();
    for secret in &bundle.encrypted_identity_secrets {
        let plaintext = decrypt_sync_secret(secret, vault_secret)?;
        let mut hasher = Sha256::new();
        hasher.update(secret.key_reference_id.as_bytes());
        hasher.update([0]);
        hasher.update(plaintext.as_bytes());
        hashes.insert(secret.key_reference_id.clone(), hasher.finalize().into());
    }
    Ok(hashes)
}

fn secret_content_hashes(
    bundle: &SyncBundle,
    vault_secret: &VaultSecret,
) -> Result<BTreeMap<(String, String), [u8; 32]>> {
    let mut hashes = BTreeMap::new();
    for secret in &bundle.encrypted_key_secrets {
        let plaintext = decrypt_sync_secret(secret, vault_secret)?;
        let mut hasher = Sha256::new();
        hasher.update(secret.key_reference_id.as_bytes());
        hasher.update([0]);
        hasher.update(secret.secret_type.as_bytes());
        hasher.update([0]);
        hasher.update(plaintext.as_bytes());
        let hash: [u8; 32] = hasher.finalize().into();
        hashes.insert(
            (secret.key_reference_id.clone(), secret.secret_type.clone()),
            hash,
        );
    }
    Ok(hashes)
}

fn required_trimmed(value: Option<String>, field: &str) -> Result<String> {
    let value = value.unwrap_or_default();
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 8192 || trimmed.contains('\0') {
        return Err(LumaError::InvalidInput(format!(
            "{field} is required or invalid"
        )));
    }
    Ok(trimmed.to_string())
}

fn required_secret(value: Option<String>, field: &str) -> Result<Zeroizing<String>> {
    let value = Zeroizing::new(value.unwrap_or_default());
    if value.is_empty() || value.len() > 8192 || value.contains('\0') {
        return Err(LumaError::InvalidInput(format!(
            "{field} is required or invalid"
        )));
    }
    Ok(value)
}

fn optional_identifier(value: Option<String>, field: &str) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 256
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(LumaError::InvalidInput(format!("{field} is invalid")));
    }
    Ok(Some(value.to_string()))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn keychain_entry(account: &str) -> Result<Entry> {
    Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|_| LumaError::SyncUnavailable("OS credential store is unavailable".into()))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn keychain_set(account: &str, secret: &str) -> Result<()> {
    let chunks = split_keychain_secret(secret);
    let previous_chunk_count = keychain_entry(account)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|value| keychain_chunk_count(&value));

    if chunks.len() == 1 {
        keychain_entry(account)?
            .set_password(secret)
            .map_err(|_| LumaError::SyncUnavailable("could not store sync credential".into()))?;
        if let Some(count) = previous_chunk_count {
            delete_keychain_chunks(account, count);
        }
        return Ok(());
    }

    if chunks.len() > KEYCHAIN_MAX_CHUNKS {
        return Err(LumaError::SyncUnavailable(
            "sync credential is too large".into(),
        ));
    }

    for (index, chunk) in chunks.iter().enumerate() {
        let chunk_account = format!("{account}:chunk:{index}");
        if keychain_entry(&chunk_account)
            .and_then(|entry| {
                entry.set_password(chunk).map_err(|_| {
                    LumaError::SyncUnavailable("could not store sync credential".into())
                })
            })
            .is_err()
        {
            delete_keychain_chunks(account, index + 1);
            return Err(LumaError::SyncUnavailable(
                "could not store sync credential".into(),
            ));
        }
    }

    let manifest = format!("{KEYCHAIN_CHUNK_MANIFEST_PREFIX}{}", chunks.len());
    if keychain_entry(account)
        .and_then(|entry| {
            entry
                .set_password(&manifest)
                .map_err(|_| LumaError::SyncUnavailable("could not store sync credential".into()))
        })
        .is_err()
    {
        delete_keychain_chunks(account, chunks.len());
        return Err(LumaError::SyncUnavailable(
            "could not store sync credential".into(),
        ));
    }
    if let Some(previous_count) = previous_chunk_count {
        for index in chunks.len()..previous_count {
            clear_keychain_entry(&format!("{account}:chunk:{index}"));
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn keychain_get(account: &str) -> Result<String> {
    let stored = keychain_entry(account)?.get_password().map_err(|_| {
        LumaError::SyncAuthFailed("required sync credential is not available".into())
    })?;
    let Some(chunk_count) = keychain_chunk_count(&stored) else {
        return Ok(stored);
    };
    let mut secret = String::new();
    for index in 0..chunk_count {
        let chunk = keychain_entry(&format!("{account}:chunk:{index}"))?
            .get_password()
            .map_err(|_| {
                LumaError::SyncAuthFailed("required sync credential is not available".into())
            })?;
        secret.push_str(&chunk);
    }
    Ok(secret)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn clear_keychain(account: &str) {
    let chunk_count = keychain_entry(account)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|value| keychain_chunk_count(&value));
    if let Some(count) = chunk_count {
        delete_keychain_chunks(account, count);
    }
    clear_keychain_entry(account);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn split_keychain_secret(secret: &str) -> Vec<Zeroizing<String>> {
    let mut chunks = Vec::new();
    let mut chunk = String::new();
    let mut utf16_units = 0;
    for character in secret.chars() {
        let character_units = character.len_utf16();
        if utf16_units + character_units > KEYCHAIN_CHUNK_UTF16_LIMIT && !chunk.is_empty() {
            chunks.push(Zeroizing::new(std::mem::take(&mut chunk)));
            utf16_units = 0;
        }
        chunk.push(character);
        utf16_units += character_units;
    }
    chunks.push(Zeroizing::new(chunk));
    chunks
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn keychain_chunk_count(value: &str) -> Option<usize> {
    value
        .strip_prefix(KEYCHAIN_CHUNK_MANIFEST_PREFIX)?
        .parse::<usize>()
        .ok()
        .filter(|count| (2..=KEYCHAIN_MAX_CHUNKS).contains(count))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn delete_keychain_chunks(account: &str, count: usize) {
    for index in 0..count.min(KEYCHAIN_MAX_CHUNKS) {
        clear_keychain_entry(&format!("{account}:chunk:{index}"));
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn clear_keychain_entry(account: &str) {
    if let Ok(entry) = Entry::new(KEYCHAIN_SERVICE, account) {
        let _ = entry.delete_credential();
    }
}

async fn credential_set(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    account: &str,
    secret: &str,
) -> Result<()> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (pool, keystore_state);
        keychain_set(account, secret)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        keystore::store(
            pool,
            keystore_state,
            "sync-credential",
            account,
            "secret",
            secret,
        )
        .await
    }
}

async fn credential_get(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    account: &str,
) -> Result<String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (pool, keystore_state);
        keychain_get(account)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        keystore::load(pool, keystore_state, "sync-credential", account, "secret")
            .await?
            .ok_or_else(|| {
                LumaError::SyncAuthFailed("required sync credential is not available".into())
            })
    }
}

async fn clear_credential(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    account: &str,
) -> Result<()> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (pool, keystore_state);
        clear_keychain(account);
        Ok(())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = keystore_state;
        sqlx::query(
            "DELETE FROM keystore_secrets WHERE owner_type='sync-credential' AND owner_id=?1",
        )
        .bind(account)
        .execute(pool)
        .await?;
        Ok(())
    }
}

fn cached_secret(runtime: &SyncRuntimeState, vault_id: &str) -> Option<VaultSecret> {
    runtime.passphrase.lock().unwrap().get(vault_id).cloned()
}

/// Hold a freshly minted or rotated managed-vault key in memory so the next
/// sync does not have to fetch back what this device just sealed.
pub fn cache_vault_secret(runtime: &SyncRuntimeState, vault_id: &str, secret: VaultSecret) {
    runtime
        .passphrase
        .lock()
        .unwrap()
        .insert(vault_id.to_string(), secret);
}

/// The secret this vault is encrypted under.
///
/// A passphrase vault can only get one from the user, so a cache miss is a
/// prompt. A managed vault fetches its content key from Luma Cloud, sealed to
/// this device, and caches it the same way — there is nothing for the user to
/// type, but there is a network call, which is why this is async.
async fn current_secret(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    collab_runtime: &crate::collaboration::CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    stored: &StoredSyncState,
    vault_id: &str,
) -> Result<VaultSecret> {
    if let Some(secret) = cached_secret(runtime, vault_id) {
        return Ok(secret);
    }

    let vault = vaults::get(pool, vault_id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown vault".into()))?;
    if vault.kind != vaults::MANAGED_KIND {
        return Err(LumaError::SyncPassphraseRequired(
            "sync passphrase is not set; enter it before synchronizing".into(),
        ));
    }

    let api_url = stored
        .cloud_url
        .as_deref()
        .ok_or_else(|| LumaError::SyncUnavailable("Luma Cloud URL is not configured".into()))?;
    let secret =
        managed::content_key(pool, collab_runtime, keystore_state, api_url, &vault).await?;
    runtime
        .passphrase
        .lock()
        .unwrap()
        .insert(vault_id.to_string(), secret.clone());
    Ok(secret)
}

async fn load_enabled_config(
    pool: &SqlitePool,
    vault_id: &str,
) -> Result<(String, StoredSyncState)> {
    let row = sqlx::query("SELECT provider,state FROM sync_state WHERE vault_id=?1")
        .bind(vault_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| {
            LumaError::SyncUnavailable("sync is disabled or has not been configured".into())
        })?;
    let provider: Option<String> = row.get("provider");
    let provider = provider.ok_or_else(|| {
        LumaError::SyncUnavailable("sync is disabled or has not been configured".into())
    })?;
    Ok((provider, parse_stored_state(row.get("state"))?))
}

fn parse_stored_state(raw: Option<String>) -> Result<StoredSyncState> {
    raw.map(|raw| {
        serde_json::from_str(&raw)
            .map_err(|_| LumaError::SyncUnavailable("stored sync configuration is invalid".into()))
    })
    .transpose()
    .map(Option::unwrap_or_default)
}

async fn create_provider(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    collab_runtime: &crate::collaboration::CollaborationRuntimeState,
    provider: &str,
    stored: &StoredSyncState,
    app_data_dir: &Path,
    vault_id: &str,
) -> Result<Box<dyn SyncProvider>> {
    // Two vaults may legitimately point at the same folder or the same cloud
    // account, so everything but the personal vault gets its own remote slot.
    // The personal vault keeps the bare name, leaving existing remotes readable.
    let slot = (vault_id != PERSONAL_VAULT_ID).then(|| vault_id.to_string());
    match provider {
        "local-folder" => {
            let folder = stored.folder_path.as_ref().ok_or_else(|| {
                LumaError::SyncUnavailable("local sync folder is not configured".into())
            })?;
            let path = PathBuf::from(folder);
            providers::validate_local_folder(&path)?;
            reject_app_data_path(&path, app_data_dir)?;
            Ok(Box::new(LocalFolderProvider::new(path, slot)))
        }
        "webdav" => Ok(Box::new(WebDavProvider::new(
            stored
                .url
                .clone()
                .ok_or_else(|| LumaError::SyncUnavailable("WebDAV URL is not configured".into()))?,
            stored.username.clone().ok_or_else(|| {
                LumaError::SyncUnavailable("WebDAV username is not configured".into())
            })?,
            credential_get(
                pool,
                keystore_state,
                &vault_account(KEYCHAIN_WEBDAV_PASSWORD, vault_id),
            )
            .await?,
            slot,
        )?)),
        "github-gist" => Ok(Box::new(GitHubGistProvider::new(
            credential_get(
                pool,
                keystore_state,
                &vault_account(KEYCHAIN_GIST_TOKEN, vault_id),
            )
            .await?,
            stored.gist_id.clone(),
            slot,
        )?)),
        "luma-cloud" => {
            let api_url = stored.cloud_url.clone().ok_or_else(|| {
                LumaError::SyncUnavailable("Luma Cloud URL is not configured".into())
            })?;
            let access_token =
                crate::collaboration::account_access_token(pool, collab_runtime, keystore_state)
                    .await
                    .map_err(|e| LumaError::SyncAuthFailed(e.message))?;
            // A managed vault has its own server-side vault with its own
            // membership, so it addresses `/v1/vaults/{id}/sync` rather than the
            // account-wide blob a personal vault uses.
            let remote_vault_id = vaults::get(pool, vault_id)
                .await?
                .and_then(|vault| vault.remote_vault_id);
            Ok(Box::new(LumaCloudProvider::new(
                api_url,
                access_token,
                slot,
                remote_vault_id,
            )?))
        }
        _ => Err(LumaError::SyncUnavailable(
            "stored sync provider is unsupported".into(),
        )),
    }
}

async fn update_after_upload(
    pool: &SqlitePool,
    provider: &str,
    stored: &mut StoredSyncState,
    bundle: &SyncBundle,
    uploaded: UploadResult,
    vault_id: &str,
) -> Result<()> {
    stored.last_remote_version = Some(uploaded.version);
    stored.baseline = baseline_for_bundle(bundle)?;
    if provider == "github-gist" {
        if let Some(gist_id) = uploaded.remote_id {
            stored.gist_id = Some(gist_id);
        }
    }
    save_stored_state(pool, stored, true, vault_id).await
}

async fn save_stored_state(
    pool: &SqlitePool,
    stored: &StoredSyncState,
    mark_synced: bool,
    vault_id: &str,
) -> Result<()> {
    let state = serde_json::to_string(stored)
        .map_err(|_| LumaError::SyncUnavailable("could not save sync state".into()))?;
    if mark_synced {
        sqlx::query("UPDATE sync_state SET state=?1,last_synced_at=unixepoch() WHERE vault_id=?2")
            .bind(state)
            .bind(vault_id)
            .execute(pool)
            .await?;
    } else {
        sqlx::query("UPDATE sync_state SET state=?1 WHERE vault_id=?2")
            .bind(state)
            .bind(vault_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

fn validate_resolutions(
    resolutions: &[ConflictResolution],
    conflicts: &[Conflict],
) -> Result<BTreeMap<String, ResolutionChoice>> {
    let valid: HashSet<String> = conflicts
        .iter()
        .map(|conflict| object_key(&conflict.object_type, &conflict.object_id))
        .collect();
    let mut result = BTreeMap::new();
    for resolution in resolutions {
        let key = object_key(&resolution.object_type, &resolution.object_id);
        if !valid.contains(&key) {
            return Err(LumaError::InvalidInput(
                "a resolution does not match a pending conflict".into(),
            ));
        }
        if result.insert(key, resolution.resolution).is_some() {
            return Err(LumaError::InvalidInput(
                "duplicate conflict resolution".into(),
            ));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn empty_bundle(device: &str) -> SyncBundle {
        SyncBundle {
            format_version: 1,
            device_id: device.into(),
            updated_at: "2026-07-16T00:00:00Z".into(),
            hosts: Vec::new(),
            host_groups: Vec::new(),
            key_references: Vec::new(),
            identities: Vec::new(),
            encrypted_key_secrets: Vec::new(),
            encrypted_identity_secrets: Vec::new(),
            terminal_profiles: Vec::new(),
            snippets: Vec::new(),
            settings: BTreeMap::new(),
            tombstones: Vec::new(),
        }
    }

    fn setting(value: &str, updated_at: i64) -> SyncSetting {
        SyncSetting {
            value: json!(value),
            updated_at,
        }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn keychain_secret_chunks_respect_windows_utf16_limit() {
        let secret = format!(
            "{}{}{}",
            "a".repeat(KEYCHAIN_CHUNK_UTF16_LIMIT - 1),
            "😀",
            "b".repeat(KEYCHAIN_CHUNK_UTF16_LIMIT),
        );
        let chunks = split_keychain_secret(&secret);

        assert_eq!(chunks.len(), 3);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.encode_utf16().count() <= KEYCHAIN_CHUNK_UTF16_LIMIT));
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| chunk.as_str())
                .collect::<String>(),
            secret,
        );
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn keychain_manifest_is_distinct_from_regular_credentials() {
        assert_eq!(keychain_chunk_count("1234"), None);
        assert_eq!(keychain_chunk_count("luma-chunks-v1:1"), None);
        assert_eq!(keychain_chunk_count("luma-chunks-v1:2"), Some(2));
        assert_eq!(keychain_chunk_count("luma-chunks-v1:invalid"), None);
    }

    #[test]
    fn encrypted_bundle_roundtrip() {
        let mut bundle = empty_bundle("11111111-1111-4111-8111-111111111111");
        bundle
            .settings
            .insert("appearance.theme".into(), setting("dark", 10));
        let encrypted = encrypt_bundle(&bundle, &"correct horse battery staple".into()).unwrap();
        let decrypted = decrypt_bundle(&encrypted, &"correct horse battery staple".into()).unwrap();
        assert_eq!(decrypted, bundle);
    }

    fn content_key_secret(byte: u8) -> VaultSecret {
        VaultSecret::ContentKey(Zeroizing::new([byte; vault_key::CONTENT_KEY_LEN]))
    }

    #[test]
    fn a_content_key_bundle_round_trips_and_marks_its_kdf() {
        let mut bundle = empty_bundle("11111111-1111-4111-8111-111111111111");
        bundle
            .settings
            .insert("appearance.theme".into(), setting("dark", 10));
        let secret = content_key_secret(7);

        let encrypted = encrypt_bundle(&bundle, &secret).unwrap();
        assert_eq!(encrypted[9], KDF_HKDF_CONTENT_KEY);
        assert_eq!(decrypt_bundle(&encrypted, &secret).unwrap(), bundle);

        // A different content key is a wrong key, not a wrong format.
        let error = decrypt_bundle(&encrypted, &content_key_secret(8)).unwrap_err();
        assert_eq!(error.category(), "sync-auth-failed");
    }

    #[test]
    fn a_passphrase_and_a_content_key_cannot_open_each_others_blobs() {
        let bundle = empty_bundle("11111111-1111-4111-8111-111111111111");
        let passphrase = VaultSecret::from("correct horse battery staple");
        let content_key = content_key_secret(7);

        let managed = encrypt_bundle(&bundle, &content_key).unwrap();
        let error = decrypt_bundle(&managed, &passphrase).unwrap_err();
        assert!(error.to_string().contains("managed vault"), "{error}");

        let shared = encrypt_bundle(&bundle, &passphrase).unwrap();
        assert_eq!(shared[9], KDF_ARGON2ID);
        let error = decrypt_bundle(&shared, &content_key).unwrap_err();
        assert!(
            error.to_string().contains("passphrase-protected"),
            "{error}"
        );
    }

    #[test]
    fn a_content_key_secret_round_trips_and_rejects_a_passphrase() {
        let secret = content_key_secret(7);
        let encrypted = encrypt_sync_secret(
            "key-1",
            PRIVATE_KEY_SECRET_TYPE,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
            42,
            &secret,
        )
        .unwrap();

        assert_eq!(encrypted.kdf_id, KDF_HKDF_CONTENT_KEY);
        validate_encrypted_secret_metadata(&encrypted).unwrap();
        assert!(decrypt_sync_secret(&encrypted, &secret).is_ok());

        let error =
            decrypt_sync_secret(&encrypted, &"correct horse battery staple".into()).unwrap_err();
        assert!(error.to_string().contains("managed vault"), "{error}");
    }

    #[test]
    fn wrong_passphrase_and_tampering_fail_readably() {
        let bundle = empty_bundle("11111111-1111-4111-8111-111111111111");
        let mut encrypted = encrypt_bundle(&bundle, &"correct passphrase".into()).unwrap();
        let error = decrypt_bundle(&encrypted, &"incorrect passphrase".into()).unwrap_err();
        assert_eq!(error.category(), "sync-auth-failed");
        assert!(error.to_string().contains("incorrect sync passphrase"));

        let last = encrypted.len() - 1;
        encrypted[last] ^= 0x80;
        let error = decrypt_bundle(&encrypted, &"correct passphrase".into()).unwrap_err();
        assert_eq!(error.category(), "sync-auth-failed");
    }

    #[test]
    fn merges_non_conflicting_changes_from_two_devices() {
        let mut baseline_bundle = empty_bundle("11111111-1111-4111-8111-111111111111");
        baseline_bundle
            .settings
            .insert("appearance.theme".into(), setting("dark", 1));
        baseline_bundle
            .settings
            .insert("terminal.scrollback".into(), setting("1000", 1));
        let baseline = baseline_for_bundle(&baseline_bundle).unwrap();

        let mut local = baseline_bundle.clone();
        local
            .settings
            .insert("appearance.theme".into(), setting("light", 3));
        let mut remote = baseline_bundle;
        remote
            .settings
            .insert("terminal.scrollback".into(), setting("5000", 4));

        let outcome = merge_bundles(&local, &remote, Some(&baseline), &[]).unwrap();
        assert!(outcome.conflicts.is_empty());
        let theme: SyncSetting = payload_as(
            outcome
                .states
                .get(&object_key("setting", "appearance.theme"))
                .unwrap(),
        )
        .unwrap();
        let scrollback: SyncSetting = payload_as(
            outcome
                .states
                .get(&object_key("setting", "terminal.scrollback"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(theme.value, json!("light"));
        assert_eq!(scrollback.value, json!("5000"));
    }

    #[test]
    fn conflicting_edit_never_overwrites_local_silently() {
        let mut common = empty_bundle("11111111-1111-4111-8111-111111111111");
        common
            .settings
            .insert("appearance.theme".into(), setting("dark", 1));
        let baseline = baseline_for_bundle(&common).unwrap();
        let mut local = common.clone();
        local
            .settings
            .insert("appearance.theme".into(), setting("light", 4));
        let mut remote = common;
        remote
            .settings
            .insert("appearance.theme".into(), setting("system", 5));

        let outcome = merge_bundles(&local, &remote, Some(&baseline), &[]).unwrap();
        assert_eq!(outcome.conflicts.len(), 1);
        let selected: SyncSetting = payload_as(
            outcome
                .states
                .get(&object_key("setting", "appearance.theme"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(selected.value, json!("light"));
    }

    #[test]
    fn tombstone_propagates_and_newer_object_resurrects_within_bundle() {
        let mut common = empty_bundle("11111111-1111-4111-8111-111111111111");
        common
            .settings
            .insert("appearance.theme".into(), setting("dark", 1));
        let baseline = baseline_for_bundle(&common).unwrap();
        let local = common.clone();
        let mut remote = common;
        remote.settings.remove("appearance.theme");
        remote.tombstones.push(SyncTombstone {
            object_type: "setting".into(),
            object_id: "appearance.theme".into(),
            deleted_at: 5,
        });
        let outcome = merge_bundles(&local, &remote, Some(&baseline), &[]).unwrap();
        assert!(outcome.conflicts.is_empty());
        assert!(outcome.states[&object_key("setting", "appearance.theme")]
            .payload
            .is_none());

        let mut resurrected = empty_bundle("22222222-2222-4222-8222-222222222222");
        resurrected
            .settings
            .insert("appearance.theme".into(), setting("light", 8));
        resurrected.tombstones.push(SyncTombstone {
            object_type: "setting".into(),
            object_id: "appearance.theme".into(),
            deleted_at: 5,
        });
        assert!(
            resurrected.states().unwrap()[&object_key("setting", "appearance.theme")]
                .payload
                .is_some()
        );
    }

    #[test]
    fn import_without_baseline_reports_different_same_id_as_conflict() {
        let mut local = empty_bundle("11111111-1111-4111-8111-111111111111");
        local
            .settings
            .insert("appearance.theme".into(), setting("dark", 1));
        let mut remote = empty_bundle("22222222-2222-4222-8222-222222222222");
        remote
            .settings
            .insert("appearance.theme".into(), setting("light", 2));
        let outcome = merge_bundles(&local, &remote, None, &[]).unwrap();
        assert_eq!(outcome.conflicts.len(), 1);
    }

    #[test]
    fn encrypted_private_key_secret_roundtrip() {
        let private_key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
        let encrypted = encrypt_sync_secret(
            "key-1",
            PRIVATE_KEY_SECRET_TYPE,
            private_key,
            42,
            &"correct horse battery staple".into(),
        )
        .unwrap();
        let decrypted =
            decrypt_sync_secret(&encrypted, &"correct horse battery staple".into()).unwrap();
        assert_eq!(&*decrypted, private_key);
    }

    #[test]
    fn encrypted_private_key_passes_redact_guard_and_raw_key_is_rejected() {
        let private_key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQAAACCZmFrZ\nS2V5TWF0ZXJpYWxGb3JUZXN0aW5nT25seQAAAJhGQUtFS0VZREFUQQ==\n-----END OPENSSH PRIVATE KEY-----\n";
        let mut bundle = empty_bundle("11111111-1111-4111-8111-111111111111");
        bundle.key_references.push(SyncKeyReference {
            id: "key-1".into(),
            name: "Synced key".into(),
            public_key: Some("ssh-ed25519 AAAATEST synced@example".into()),
            storage_mode: "encrypted-vault".into(),
            local_path: None,
            fingerprint: Some("SHA256:test".into()),
            certificate: None,
            updated_at: 42,
        });
        bundle.encrypted_key_secrets.push(
            encrypt_sync_secret(
                "key-1",
                PRIVATE_KEY_SECRET_TYPE,
                private_key,
                42,
                &"correct horse battery staple".into(),
            )
            .unwrap(),
        );

        let serialized = serde_json::to_string(&bundle).unwrap();
        assert!(!serialized.contains("BEGIN OPENSSH PRIVATE KEY"));
        validate_bundle(&bundle).unwrap();

        let mut raw_bundle = bundle;
        raw_bundle.encrypted_key_secrets[0].ciphertext = private_key.into();
        let error = validate_bundle(&raw_bundle).unwrap_err();
        assert_eq!(error.category(), "invalid-input");
        assert!(!error.to_string().contains("b3BlbnNzaC1rZXktdjE"));
    }

    /// Apply one host_group payload as if it had arrived from a peer.
    async fn apply_group_payload(pool: &SqlitePool, payload: serde_json::Value) {
        let item = MergeItem {
            object_type: "host_group".into(),
            object_id: "group-1".into(),
            label: "Prod".into(),
            updated_at: 100,
            payload: Some(payload),
        };
        let mut transaction = pool.begin().await.unwrap();
        apply_object(&mut transaction, &item, PERSONAL_VAULT_ID)
            .await
            .unwrap();
        transaction.commit().await.unwrap();
    }

    #[tokio::test]
    async fn a_peer_without_group_defaults_cannot_clear_them() {
        // A client that predates group defaults omits the field entirely. Read
        // as "everything is unset" it would wipe the inherited identity and
        // jump host for every member of the group, just by renaming it.
        let pool = crate::storage::init_in_memory().await.unwrap();
        sqlx::query(
            "INSERT INTO host_groups(id,name,vault_id,sort_order,created_at,updated_at,
             username,startup_command)
             VALUES('group-1','Prod',?1,0,1,1,'deploy','tmux -u attach')",
        )
        .bind(PERSONAL_VAULT_ID)
        .execute(&pool)
        .await
        .unwrap();

        apply_group_payload(
            &pool,
            json!({
                "id": "group-1",
                "name": "Production",
                "parentId": null,
                "sortOrder": 0,
                "updatedAt": 100,
            }),
        )
        .await;

        let row =
            sqlx::query("SELECT name,username,startup_command FROM host_groups WHERE id='group-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        // The rename lands; the defaults it knew nothing about survive.
        assert_eq!(row.get::<String, _>("name"), "Production");
        assert_eq!(
            row.get::<Option<String>, _>("username").as_deref(),
            Some("deploy")
        );
        assert_eq!(
            row.get::<Option<String>, _>("startup_command").as_deref(),
            Some("tmux -u attach")
        );
    }

    #[tokio::test]
    async fn an_explicit_empty_defaults_object_still_clears_them() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        sqlx::query(
            "INSERT INTO host_groups(id,name,vault_id,sort_order,created_at,updated_at,username)
             VALUES('group-1','Prod',?1,0,1,1,'deploy')",
        )
        .bind(PERSONAL_VAULT_ID)
        .execute(&pool)
        .await
        .unwrap();

        apply_group_payload(
            &pool,
            json!({
                "id": "group-1",
                "name": "Prod",
                "parentId": null,
                "sortOrder": 0,
                "defaults": {},
                "updatedAt": 100,
            }),
        )
        .await;

        let username: Option<String> =
            sqlx::query_scalar("SELECT username FROM host_groups WHERE id='group-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(username, None);
    }

    #[tokio::test]
    async fn sync_cannot_clear_a_device_bound_agent_key_binding() {
        // Every bundle has agent references stripped, so an incoming host has
        // no key. Writing that back would unbind the agent key on the very
        // device that owns it.
        let pool = crate::storage::init_in_memory().await.unwrap();
        sqlx::query(
            "INSERT INTO key_references(id,name,storage_mode,has_private_key,vault_id,updated_at)
             VALUES('key-agent','Security key','ssh-agent',0,?1,1)",
        )
        .bind(PERSONAL_VAULT_ID)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO hosts(id,name,hostname,port,auth_type,key_id,vault_id,created_at,updated_at)
             VALUES('host-1','Prod','prod.example.com',22,'key','key-agent',?1,1,1)",
        )
        .bind(PERSONAL_VAULT_ID)
        .execute(&pool)
        .await
        .unwrap();

        let item = MergeItem {
            object_type: "host".into(),
            object_id: "host-1".into(),
            label: "Prod".into(),
            updated_at: 100,
            payload: Some(json!({
                "id": "host-1",
                "name": "Prod",
                "hostname": "prod.example.com",
                "port": 22,
                "username": null,
                "groupId": null,
                "authenticationType": "interactive",
                "keyId": null,
                "identityId": null,
                "proxyJumpHostId": null,
                "startupCommand": null,
                "workingDirectory": null,
                "environment": null,
                "tags": [],
                "favorite": false,
                "tabColor": null,
                "transport": "ssh",
                "moshServerPath": null,
                "moshPortRange": null,
                "updatedAt": 100,
            })),
        };
        let mut transaction = pool.begin().await.unwrap();
        apply_object(&mut transaction, &item, PERSONAL_VAULT_ID)
            .await
            .unwrap();
        transaction.commit().await.unwrap();

        let row = sqlx::query("SELECT key_id,auth_type FROM hosts WHERE id='host-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.get::<Option<String>, _>("key_id").as_deref(),
            Some("key-agent")
        );
        assert_eq!(row.get::<String, _>("auth_type"), "key");
    }

    #[tokio::test]
    async fn private_key_sync_opt_in_off_assembles_no_encrypted_secrets() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let runtime = SyncRuntimeState::default();
        let keystore_state = KeystoreState::default();
        initialize(&pool, &runtime, &keystore_state).await.unwrap();
        sqlx::query(
            "INSERT INTO key_references(id,name,storage_mode,has_private_key,updated_at)\n             VALUES('key-1','Local key','encrypted-vault',1,42)",
        )
        .execute(&pool)
        .await
        .unwrap();
        keystore::setup(&pool, &keystore_state, "keystore password", false)
            .await
            .unwrap();
        keystore::store(
            &pool,
            &keystore_state,
            KEYSTORE_KEY_OWNER_TYPE,
            "key-1",
            PRIVATE_KEY_SECRET_TYPE,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
        )
        .await
        .unwrap();
        settings::set(
            &pool,
            settings::SYNC_INCLUDE_PRIVATE_KEYS_KEY,
            &json!(false),
        )
        .await
        .unwrap();

        let bundle = assemble_bundle(
            &pool,
            &keystore_state,
            &"correct horse battery staple".into(),
            PERSONAL_VAULT_ID,
        )
        .await
        .unwrap();
        assert!(bundle.encrypted_key_secrets.is_empty());
        assert!(!serde_json::to_string(&bundle)
            .unwrap()
            .contains("encryptedKeySecrets"));
    }

    #[tokio::test]
    async fn keystore_locked_apply_skips_private_keys_and_counts_them() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let keystore_state = KeystoreState::default();
        let passphrase = VaultSecret::from("correct horse battery staple");
        let mut remote = empty_bundle("22222222-2222-4222-8222-222222222222");
        remote.key_references.push(SyncKeyReference {
            id: "key-1".into(),
            name: "Remote key".into(),
            public_key: Some("ssh-ed25519 AAAATEST remote@example".into()),
            storage_mode: "encrypted-vault".into(),
            local_path: None,
            fingerprint: None,
            certificate: None,
            updated_at: 42,
        });
        remote.encrypted_key_secrets.push(
            encrypt_sync_secret(
                "key-1",
                PRIVATE_KEY_SECRET_TYPE,
                "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
                42,
                &passphrase,
            )
            .unwrap(),
        );
        let local = empty_bundle("11111111-1111-4111-8111-111111111111");
        let outcome = merge_bundles(&local, &remote, None, &[]).unwrap();
        let prepared = prepare_remote_secrets(
            &keystore_state,
            &passphrase,
            &remote.encrypted_key_secrets,
            &outcome.states,
            &outcome.remote_key_references,
        )
        .unwrap();
        apply_states(&pool, &outcome.states, PERSONAL_VAULT_ID)
            .await
            .unwrap();
        let summary = apply_prepared_secrets(&pool, &keystore_state, &passphrase, prepared)
            .await
            .unwrap();
        assert_eq!(summary.applied, 0);
        assert_eq!(summary.skipped_locked, 1);
        let has_private_key: i64 =
            sqlx::query_scalar("SELECT has_private_key FROM key_references WHERE id='key-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(has_private_key, 0);
    }

    #[tokio::test]
    async fn unlocked_apply_reencrypts_private_key_into_local_keystore() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let keystore_state = KeystoreState::default();
        keystore::setup(&pool, &keystore_state, "keystore password", false)
            .await
            .unwrap();
        let passphrase = VaultSecret::from("correct horse battery staple");
        let private_key =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nREMOTEKEY\n-----END OPENSSH PRIVATE KEY-----\n";
        let mut remote = empty_bundle("22222222-2222-4222-8222-222222222222");
        remote.key_references.push(SyncKeyReference {
            id: "key-1".into(),
            name: "Remote key".into(),
            public_key: None,
            storage_mode: "encrypted-vault".into(),
            local_path: None,
            fingerprint: None,
            certificate: None,
            updated_at: 42,
        });
        remote.encrypted_key_secrets.push(
            encrypt_sync_secret(
                "key-1",
                PRIVATE_KEY_SECRET_TYPE,
                private_key,
                42,
                &passphrase,
            )
            .unwrap(),
        );
        let local = empty_bundle("11111111-1111-4111-8111-111111111111");
        let outcome = merge_bundles(&local, &remote, None, &[]).unwrap();
        let prepared = prepare_remote_secrets(
            &keystore_state,
            &passphrase,
            &remote.encrypted_key_secrets,
            &outcome.states,
            &outcome.remote_key_references,
        )
        .unwrap();
        apply_states(&pool, &outcome.states, PERSONAL_VAULT_ID)
            .await
            .unwrap();
        let summary = apply_prepared_secrets(&pool, &keystore_state, &passphrase, prepared)
            .await
            .unwrap();

        assert_eq!(summary.applied, 1);
        assert_eq!(summary.skipped_locked, 0);
        let stored = keystore::load(
            &pool,
            &keystore_state,
            KEYSTORE_KEY_OWNER_TYPE,
            "key-1",
            PRIVATE_KEY_SECRET_TYPE,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(stored, private_key);
        let has_private_key: i64 =
            sqlx::query_scalar("SELECT has_private_key FROM key_references WHERE id='key-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(has_private_key, 1);
    }

    #[tokio::test]
    async fn kept_local_key_never_has_its_secret_overwritten() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let keystore_state = KeystoreState::default();
        keystore::setup(&pool, &keystore_state, "keystore password", false)
            .await
            .unwrap();
        let local_private_key =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nLOCALKEY\n-----END OPENSSH PRIVATE KEY-----\n";
        keystore::store(
            &pool,
            &keystore_state,
            KEYSTORE_KEY_OWNER_TYPE,
            "key-1",
            PRIVATE_KEY_SECRET_TYPE,
            local_private_key,
        )
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO key_references(id,name,storage_mode,has_private_key,updated_at)\n             VALUES('key-1','Local key','encrypted-vault',1,10)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let mut local = empty_bundle("11111111-1111-4111-8111-111111111111");
        local.key_references.push(SyncKeyReference {
            id: "key-1".into(),
            name: "Local key".into(),
            public_key: None,
            storage_mode: "encrypted-vault".into(),
            local_path: None,
            fingerprint: None,
            certificate: None,
            updated_at: 10,
        });
        let mut remote = empty_bundle("22222222-2222-4222-8222-222222222222");
        remote.key_references.push(SyncKeyReference {
            id: "key-1".into(),
            name: "Remote key".into(),
            public_key: None,
            storage_mode: "encrypted-vault".into(),
            local_path: None,
            fingerprint: None,
            certificate: None,
            updated_at: 20,
        });
        remote.encrypted_key_secrets.push(
            encrypt_sync_secret(
                "key-1",
                PRIVATE_KEY_SECRET_TYPE,
                "-----BEGIN OPENSSH PRIVATE KEY-----\nREMOTEKEY\n-----END OPENSSH PRIVATE KEY-----\n",
                20,
                &"correct horse battery staple".into(),
            )
            .unwrap(),
        );
        let outcome = merge_bundles(&local, &remote, None, &[]).unwrap();
        assert_eq!(outcome.conflicts.len(), 1);
        assert!(outcome.remote_key_references.is_empty());
        let prepared = prepare_remote_secrets(
            &keystore_state,
            &"correct horse battery staple".into(),
            &remote.encrypted_key_secrets,
            &outcome.states,
            &outcome.remote_key_references,
        )
        .unwrap();
        apply_states(&pool, &outcome.states, PERSONAL_VAULT_ID)
            .await
            .unwrap();
        let summary = apply_prepared_secrets(
            &pool,
            &keystore_state,
            &"correct horse battery staple".into(),
            prepared,
        )
        .await
        .unwrap();

        assert_eq!(summary.applied, 0);
        let stored = keystore::load(
            &pool,
            &keystore_state,
            KEYSTORE_KEY_OWNER_TYPE,
            "key-1",
            PRIVATE_KEY_SECRET_TYPE,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(stored, local_private_key);
    }

    #[test]
    fn older_bundle_without_encrypted_key_secrets_still_deserializes() {
        let value = json!({
            "formatVersion": 1,
            "deviceId": "11111111-1111-4111-8111-111111111111",
            "updatedAt": "2026-07-16T00:00:00Z",
            "hosts": [{
                "id": "host-1",
                "name": "Legacy",
                "hostname": "legacy.example.com",
                "port": 22,
                "username": null,
                "groupId": null,
                "authenticationType": "agent",
                "keyId": null,
                "proxyJumpHostId": null,
                "startupCommand": null,
                "workingDirectory": null,
                "environment": null,
                "tags": [],
                "favorite": false,
                "updatedAt": 1
            }],
            "hostGroups": [],
            "keyReferences": [],
            "terminalProfiles": [],
            "snippets": [],
            "settings": {},
            "tombstones": []
        });
        let mut bundle: SyncBundle = serde_json::from_value(value).unwrap();
        assert!(bundle.encrypted_key_secrets.is_empty());
        assert!(bundle.identities.is_empty());
        assert!(bundle.encrypted_identity_secrets.is_empty());
        assert_eq!(bundle.hosts[0].identity_id, None);
        assert_eq!(bundle.hosts[0].tab_color, None);

        normalize_legacy_agent_auth(&mut bundle);
        assert_eq!(bundle.hosts[0].authentication_type, "interactive");
        validate_bundle(&bundle).unwrap();
    }

    #[test]
    fn legacy_agent_hosts_and_ssh_agent_keys_are_coerced() {
        let mut bundle = empty_bundle("11111111-1111-4111-8111-111111111111");
        bundle.key_references.push(SyncKeyReference {
            id: "agent-key".into(),
            name: "Agent key".into(),
            public_key: None,
            storage_mode: "ssh-agent".into(),
            local_path: None,
            fingerprint: None,
            certificate: None,
            updated_at: 1,
        });
        bundle.key_references.push(SyncKeyReference {
            id: "disk-key".into(),
            name: "Disk key".into(),
            public_key: None,
            storage_mode: "local-path".into(),
            local_path: Some("~/.ssh/id_ed25519".into()),
            fingerprint: None,
            certificate: None,
            updated_at: 1,
        });
        bundle.identities.push(SyncIdentity {
            id: "identity-1".into(),
            name: "Ops".into(),
            username: "deploy".into(),
            key_id: Some("agent-key".into()),
            has_password: true,
            updated_at: 1,
        });
        bundle.hosts.push(SyncHost {
            id: "host-agent".into(),
            name: "Agent host".into(),
            hostname: "agent.example.com".into(),
            port: 22,
            username: None,
            group_id: None,
            authentication_type: "agent".into(),
            key_id: None,
            identity_id: None,
            proxy_jump_host_id: None,
            startup_command: None,
            working_directory: None,
            environment: None,
            tags: Vec::new(),
            favorite: false,
            tab_color: None,
            transport: "ssh".into(),
            mosh_server_path: None,
            mosh_port_range: None,
            updated_at: 1,
        });
        bundle.hosts.push(SyncHost {
            id: "host-agent-key".into(),
            name: "Agent-keyed host".into(),
            hostname: "keyed.example.com".into(),
            port: 22,
            username: None,
            group_id: None,
            authentication_type: "key".into(),
            key_id: Some("agent-key".into()),
            identity_id: None,
            proxy_jump_host_id: None,
            startup_command: None,
            working_directory: None,
            environment: None,
            tags: Vec::new(),
            favorite: false,
            tab_color: None,
            transport: "ssh".into(),
            mosh_server_path: None,
            mosh_port_range: None,
            updated_at: 1,
        });

        normalize_legacy_agent_auth(&mut bundle);

        assert_eq!(bundle.key_references.len(), 1);
        assert_eq!(bundle.key_references[0].id, "disk-key");
        assert_eq!(bundle.identities[0].key_id, None);
        assert_eq!(bundle.hosts[0].authentication_type, "interactive");
        assert_eq!(bundle.hosts[1].authentication_type, "interactive");
        assert_eq!(bundle.hosts[1].key_id, None);
        validate_bundle(&bundle).unwrap();
    }

    #[tokio::test]
    async fn identity_metadata_and_host_assignment_merge_and_apply() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let local = empty_bundle("11111111-1111-4111-8111-111111111111");
        let mut remote = empty_bundle("22222222-2222-4222-8222-222222222222");
        remote.identities.push(SyncIdentity {
            id: "identity-1".into(),
            name: "Production".into(),
            username: "deploy".into(),
            key_id: None,
            has_password: true,
            updated_at: 10,
        });
        remote.hosts.push(SyncHost {
            id: "host-1".into(),
            name: "Server".into(),
            hostname: "server.example.com".into(),
            port: 22,
            username: None,
            group_id: None,
            authentication_type: "password".into(),
            key_id: None,
            identity_id: Some("identity-1".into()),
            proxy_jump_host_id: None,
            startup_command: None,
            working_directory: None,
            environment: None,
            tags: Vec::new(),
            favorite: false,
            tab_color: None,
            transport: "ssh".into(),
            mosh_server_path: None,
            mosh_port_range: None,
            updated_at: 10,
        });

        let outcome = merge_bundles(&local, &remote, None, &[]).unwrap();
        assert!(outcome.remote_identities.contains("identity-1"));
        validate_states(&outcome.states).unwrap();
        apply_states(&pool, &outcome.states, PERSONAL_VAULT_ID)
            .await
            .unwrap();

        let identity: (String, String, i64) = sqlx::query_as(
            "SELECT name,username,has_password FROM identities WHERE id='identity-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(identity, ("Production".into(), "deploy".into(), 0));
        let identity_id: Option<String> =
            sqlx::query_scalar("SELECT identity_id FROM hosts WHERE id='host-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(identity_id.as_deref(), Some("identity-1"));
    }

    #[test]
    fn encrypted_identity_password_roundtrip_and_validation() {
        let passphrase = VaultSecret::from("correct horse battery staple");
        let secret = encrypt_sync_secret(
            "identity-1",
            IDENTITY_PASSWORD_SECRET_TYPE,
            "super secret password",
            42,
            &passphrase,
        )
        .unwrap();
        validate_encrypted_identity_secret_metadata(&secret).unwrap();
        assert_eq!(
            decrypt_sync_secret(&secret, &passphrase).unwrap().as_str(),
            "super secret password"
        );
        let mut bundle = empty_bundle("11111111-1111-4111-8111-111111111111");
        bundle.identities.push(SyncIdentity {
            id: "identity-1".into(),
            name: "Identity".into(),
            username: "alice".into(),
            key_id: None,
            has_password: true,
            updated_at: 42,
        });
        bundle.encrypted_identity_secrets.push(secret);
        validate_bundle(&bundle).unwrap();
    }

    #[test]
    fn private_key_sync_preference_is_device_local() {
        assert!(!is_safe_setting_key(
            settings::SYNC_INCLUDE_PRIVATE_KEYS_KEY
        ));
    }

    #[test]
    fn rejects_recognizable_embedded_secrets_before_encryption() {
        let mut bundle = empty_bundle("11111111-1111-4111-8111-111111111111");
        bundle.settings.insert(
            "terminal.example".into(),
            SyncSetting {
                value: json!("token=do-not-sync"),
                updated_at: 1,
            },
        );
        let error = encrypt_bundle(&bundle, &"correct passphrase".into()).unwrap_err();
        assert_eq!(error.category(), "invalid-input");
        assert!(!error.to_string().contains("do-not-sync"));
    }

    fn temporary_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("luma-vault-sync-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn local_folder_input(folder: &Path) -> SyncConfigureInput {
        SyncConfigureInput {
            provider: "local-folder".into(),
            folder_path: Some(folder.to_string_lossy().into_owned()),
            url: None,
            username: None,
            password: None,
            gist_id: None,
            token: None,
            cloud_url: None,
        }
    }

    async fn shared_vault(pool: &SqlitePool, name: &str, share_secrets: bool) -> String {
        vaults::create(
            pool,
            vaults::VaultInput {
                name: name.into(),
                share_secrets,
                sort_order: 0,
            },
        )
        .await
        .unwrap()
        .id
    }

    async fn seed_host(pool: &SqlitePool, vault_id: &str, name: &str) -> String {
        hosts::create(
            pool,
            hosts::HostInput {
                vault_id: vault_id.into(),
                name: name.into(),
                hostname: "server.example.com".into(),
                port: 22,
                username: None,
                group_id: None,
                authentication_type: "interactive".into(),
                key_id: None,
                identity_id: None,
                proxy_jump_host_id: None,
                startup_command: None,
                working_directory: None,
                environment: None,
                tags: vec![],
                favorite: false,
                tab_color: None,
                transport: "ssh".into(),
                mosh_server_path: None,
                mosh_port_range: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn a_shared_vault_bundle_carries_no_settings_or_terminal_profiles() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let runtime = SyncRuntimeState::default();
        let keystore_state = KeystoreState::default();
        initialize(&pool, &runtime, &keystore_state).await.unwrap();

        settings::set(&pool, "appearance.theme", &json!("dark"))
            .await
            .unwrap();
        // Inserted directly: profiles::create resolves the shell against the real
        // filesystem, which differs per platform.
        sqlx::query(
            "INSERT INTO terminal_profiles(id,name,shell_path,args) VALUES('profile-1','Shell','shell',  '[]')",
        )
        .execute(&pool)
        .await
        .unwrap();
        settings::delete(&pool, "appearance.theme").await.unwrap();
        settings::set(&pool, "appearance.theme", &json!("light"))
            .await
            .unwrap();

        let shared = shared_vault(&pool, "Infra", false).await;
        seed_host(&pool, &shared, "Bastion").await;

        let personal = assemble_bundle_without_private_keys(&pool, PERSONAL_VAULT_ID)
            .await
            .unwrap();
        assert!(!personal.settings.is_empty());
        assert_eq!(personal.terminal_profiles.len(), 1);

        let bundle = assemble_bundle_without_private_keys(&pool, &shared)
            .await
            .unwrap();
        assert_eq!(bundle.hosts.len(), 1);
        assert!(bundle.settings.is_empty());
        assert!(bundle.terminal_profiles.is_empty());
        assert!(!bundle
            .tombstones
            .iter()
            .any(|tombstone| tombstone.object_type == "setting"
                || tombstone.object_type == "terminal_profile"));
    }

    #[tokio::test]
    async fn secret_sharing_off_assembles_a_shared_bundle_with_no_key_secrets() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let runtime = SyncRuntimeState::default();
        let keystore_state = KeystoreState::default();
        initialize(&pool, &runtime, &keystore_state).await.unwrap();
        keystore::setup(&pool, &keystore_state, "keystore password", false)
            .await
            .unwrap();

        let private = shared_vault(&pool, "Client X", false).await;
        let sharing = shared_vault(&pool, "Infra", true).await;
        for vault_id in [&private, &sharing] {
            let key_id = format!("key-{vault_id}");
            sqlx::query(
                "INSERT INTO key_references(id,vault_id,name,storage_mode,has_private_key,updated_at)
                 VALUES(?1,?2,'Shared key','encrypted-vault',1,42)",
            )
            .bind(&key_id)
            .bind(vault_id)
            .execute(&pool)
            .await
            .unwrap();
            keystore::store(
                &pool,
                &keystore_state,
                KEYSTORE_KEY_OWNER_TYPE,
                &key_id,
                PRIVATE_KEY_SECRET_TYPE,
                "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
            )
            .await
            .unwrap();
        }

        let passphrase = VaultSecret::from("correct horse battery staple");
        let withheld = assemble_bundle(&pool, &keystore_state, &passphrase, &private)
            .await
            .unwrap();
        assert_eq!(withheld.key_references.len(), 1);
        assert!(withheld.encrypted_key_secrets.is_empty());

        let shared = assemble_bundle(&pool, &keystore_state, &passphrase, &sharing)
            .await
            .unwrap();
        assert_eq!(shared.key_references.len(), 1);
        assert_eq!(shared.encrypted_key_secrets.len(), 1);
    }

    #[tokio::test]
    async fn luma_cloud_is_rejected_for_a_shared_vault() {
        let root = temporary_directory();
        let app_data_dir = root.join("app-data");
        fs::create_dir_all(&app_data_dir).unwrap();
        let pool = crate::storage::init_in_memory().await.unwrap();
        let runtime = SyncRuntimeState::default();
        let keystore_state = KeystoreState::default();
        initialize(&pool, &runtime, &keystore_state).await.unwrap();

        let shared = shared_vault(&pool, "Infra", false).await;
        let input = SyncConfigureInput {
            provider: "luma-cloud".into(),
            folder_path: None,
            url: None,
            username: None,
            password: None,
            gist_id: None,
            token: None,
            cloud_url: Some("https://sync.example.com".into()),
        };

        let error = configure(
            &pool,
            &runtime,
            &keystore_state,
            &app_data_dir,
            &shared,
            input,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, LumaError::InvalidInput(_)), "{error:?}");

        // The vault is left unconfigured rather than half-enabled.
        let provider: Option<String> =
            sqlx::query_scalar("SELECT provider FROM sync_state WHERE vault_id = ?1")
                .bind(&shared)
                .fetch_optional(&pool)
                .await
                .unwrap()
                .flatten();
        assert_eq!(provider, None);

        fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn two_vaults_sync_independently_and_one_conflict_does_not_stall_the_other() {
        let root = temporary_directory();
        let app_data_dir = root.join("app-data");
        let folder = root.join("remote");
        fs::create_dir_all(&app_data_dir).unwrap();
        fs::create_dir_all(&folder).unwrap();

        let pool = crate::storage::init_in_memory().await.unwrap();
        let runtime = SyncRuntimeState::default();
        let keystore_state = KeystoreState::default();
        let collab = crate::collaboration::CollaborationRuntimeState::default();
        initialize(&pool, &runtime, &keystore_state).await.unwrap();

        let first = shared_vault(&pool, "Infra", false).await;
        let second = shared_vault(&pool, "Client X", false).await;
        // Both vaults point at the same folder on purpose: the remote slot is what
        // keeps their blobs apart.
        for vault_id in [&first, &second] {
            configure(
                &pool,
                &runtime,
                &keystore_state,
                &app_data_dir,
                vault_id,
                local_folder_input(&folder),
            )
            .await
            .unwrap();
        }
        set_passphrase(
            &pool,
            &runtime,
            &keystore_state,
            &first,
            "first vault passphrase".into(),
            false,
        )
        .await
        .unwrap();
        set_passphrase(
            &pool,
            &runtime,
            &keystore_state,
            &second,
            "second vault passphrase".into(),
            false,
        )
        .await
        .unwrap();

        let first_host = seed_host(&pool, &first, "Bastion").await;
        seed_host(&pool, &second, "Client gateway").await;
        for vault_id in [&first, &second] {
            let report = sync_now(
                &pool,
                &runtime,
                &keystore_state,
                &collab,
                &app_data_dir,
                vault_id,
            )
            .await
            .unwrap();
            assert!(report.pushed, "{vault_id} did not push");
        }

        // Two blobs, one per vault: neither overwrote the other.
        let blobs: Vec<String> = fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".bin"))
            .collect();
        assert_eq!(blobs.len(), 2, "{blobs:?}");

        // Force a conflict in the first vault only: rewrite its remote blob behind
        // its back, then change the same host locally.
        let passphrase = VaultSecret::from("first vault passphrase");
        let blob_path = folder.join(
            blobs
                .iter()
                .find(|name| {
                    let bytes = fs::read(folder.join(name)).unwrap();
                    decrypt_bundle(&bytes, &passphrase).is_ok()
                })
                .unwrap(),
        );
        let mut remote_bundle =
            decrypt_bundle(&fs::read(&blob_path).unwrap(), &passphrase).unwrap();
        remote_bundle.hosts[0].hostname = "remote-edit.example.com".into();
        remote_bundle.hosts[0].updated_at += 60;
        fs::write(
            &blob_path,
            encrypt_bundle(&remote_bundle, &passphrase).unwrap(),
        )
        .unwrap();

        sqlx::query("UPDATE hosts SET hostname='local-edit.example.com', updated_at=updated_at+60 WHERE id=?1")
            .bind(&first_host)
            .execute(&pool)
            .await
            .unwrap();

        let stalled = sync_now(
            &pool,
            &runtime,
            &keystore_state,
            &collab,
            &app_data_dir,
            &first,
        )
        .await
        .unwrap();
        assert_eq!(stalled.conflicts.len(), 1);
        assert!(!stalled.pushed);

        // The second vault syncs cleanly while the first is still holding a conflict.
        let unaffected = sync_now(
            &pool,
            &runtime,
            &keystore_state,
            &collab,
            &app_data_dir,
            &second,
        )
        .await
        .unwrap();
        assert!(unaffected.conflicts.is_empty());
        assert!(unaffected.up_to_date);
        assert!(runtime.pending.lock().unwrap().contains_key(&first));
        assert!(!runtime.pending.lock().unwrap().contains_key(&second));

        // Resolving the first vault's conflict touches only the first vault.
        let resolved = sync_resolve(
            &pool,
            &runtime,
            &keystore_state,
            &collab,
            &app_data_dir,
            &first,
            &[ConflictResolution {
                object_type: "host".into(),
                object_id: first_host.clone(),
                resolution: ResolutionChoice::TakeRemote,
            }],
        )
        .await
        .unwrap();
        assert!(resolved.pushed);
        assert!(runtime.pending.lock().unwrap().is_empty());
        let hostname: String = sqlx::query_scalar("SELECT hostname FROM hosts WHERE id=?1")
            .bind(&first_host)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(hostname, "remote-edit.example.com");

        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_shared_vault_bundle_cannot_rewrite_another_vaults_row() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let runtime = SyncRuntimeState::default();
        let keystore_state = KeystoreState::default();
        initialize(&pool, &runtime, &keystore_state).await.unwrap();

        let shared = shared_vault(&pool, "Infra", false).await;
        let victim = seed_host(&pool, PERSONAL_VAULT_ID, "My server").await;

        // A member of the shared vault authors an object with the same id.
        let mut hostile = empty_bundle("22222222-2222-4222-8222-222222222222");
        hostile.hosts.push(SyncHost {
            id: victim.clone(),
            name: "My server".into(),
            hostname: "attacker.example.com".into(),
            port: 22,
            username: None,
            group_id: None,
            authentication_type: "interactive".into(),
            key_id: None,
            identity_id: None,
            proxy_jump_host_id: None,
            startup_command: None,
            working_directory: None,
            environment: None,
            tags: vec![],
            favorite: false,
            tab_color: None,
            transport: "ssh".into(),
            mosh_server_path: None,
            mosh_port_range: None,
            updated_at: 9_999_999,
        });
        apply_states(&pool, &hostile.states().unwrap(), &shared)
            .await
            .unwrap();

        let row = sqlx::query("SELECT hostname, vault_id FROM hosts WHERE id=?1")
            .bind(&victim)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("hostname"), "server.example.com");
        assert_eq!(row.get::<String, _>("vault_id"), PERSONAL_VAULT_ID);

        // The same reasoning for deletes: the shared vault's tombstone must not
        // remove the personal vault's row.
        let mut deleting = empty_bundle("22222222-2222-4222-8222-222222222222");
        deleting.tombstones.push(SyncTombstone {
            object_type: "host".into(),
            object_id: victim.clone(),
            deleted_at: 9_999_999,
        });
        apply_states(&pool, &deleting.states().unwrap(), &shared)
            .await
            .unwrap();
        assert!(hosts::get(&pool, &victim).await.unwrap().is_some());
    }
}
