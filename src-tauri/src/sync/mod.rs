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

mod providers;

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
use keyring::Entry;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use zeroize::{Zeroize, Zeroizing};

use crate::errors::{LumaError, Result};
use crate::storage::{host_groups, hosts, key_references, settings, snippets};
use crate::vault::{self, VaultState};

use providers::{
    GitHubGistProvider, LocalFolderProvider, SyncProvider, UploadResult, WebDavProvider,
};

const MAGIC: &[u8; 8] = b"LUMASYNC";
const ENVELOPE_VERSION: u8 = 1;
const KDF_ARGON2ID: u8 = 1;
const CIPHER_XCHACHA20_POLY1305: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 13 + SALT_LEN + NONCE_LEN;
const FORMAT_VERSION: u8 = 1;
const KEYCHAIN_SERVICE: &str = "luma.sync";
const KEYCHAIN_PASSPHRASE: &str = "sync-passphrase";
const KEYCHAIN_WEBDAV_PASSWORD: &str = "webdav-password";
const KEYCHAIN_GIST_TOKEN: &str = "github-gist-token";
const MAX_OBJECTS_PER_TYPE: usize = 10_000;
const MAX_ENCRYPTED_KEY_SECRETS: usize = MAX_OBJECTS_PER_TYPE * 2;
const MAX_SYNC_SECRET_BYTES: usize = 1024 * 1024;
const VAULT_KEY_OWNER_TYPE: &str = "key";
const PRIVATE_KEY_SECRET_TYPE: &str = "private-key";
const PASSPHRASE_SECRET_TYPE: &str = "passphrase";
pub(crate) const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;

pub struct SyncRuntimeState {
    passphrase: Mutex<Option<Zeroizing<String>>>,
    pending: Mutex<Option<PendingSync>>,
}

impl Default for SyncRuntimeState {
    fn default() -> Self {
        Self {
            passphrase: Mutex::new(None),
            pending: Mutex::new(None),
        }
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
    pub encrypted_key_secrets: Vec<SyncEncryptedSecret>,
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
    pub proxy_jump_host_id: Option<String>,
    pub startup_command: Option<String>,
    pub working_directory: Option<String>,
    pub environment: Option<HashMap<String, String>>,
    pub tags: Vec<String>,
    pub favorite: bool,
    #[serde(default)]
    pub tab_color: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncHostGroup {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub enabled: bool,
    pub provider: Option<String>,
    pub folder_path: Option<String>,
    pub url: Option<String>,
    pub username: Option<String>,
    pub gist_id: Option<String>,
    pub last_sync_at: Option<i64>,
    pub last_remote_version: Option<String>,
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

pub async fn initialize(pool: &SqlitePool, runtime: &SyncRuntimeState) -> Result<()> {
    sqlx::query(
        "INSERT INTO sync_state (id, device_id, provider, last_synced_at, state)
         VALUES (1, ?1, NULL, NULL, NULL)
         ON CONFLICT(id) DO NOTHING",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .execute(pool)
    .await?;

    if let Ok(passphrase) = keychain_get(KEYCHAIN_PASSPHRASE) {
        *runtime.passphrase.lock().unwrap() = Some(Zeroizing::new(passphrase));
    }
    Ok(())
}

pub async fn export_encrypted(
    pool: &SqlitePool,
    vault_state: &VaultState,
    app_data_dir: &Path,
    path: &str,
    passphrase: &str,
) -> Result<ExportSummary> {
    let path_buf = validate_file_path(path, app_data_dir, false)?;
    let bundle = assemble_bundle(pool, vault_state, passphrase).await?;
    let counts = bundle.counts();
    let blob = encrypt_bundle(&bundle, passphrase)?;
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
    path: &str,
    passphrase: &str,
) -> Result<ImportPreview> {
    let bundle = read_encrypted_bundle(path, app_data_dir, passphrase)?;
    validate_bundle(&bundle)?;
    let local = assemble_bundle_without_private_keys(pool).await?;
    let outcome = merge_bundles(&local, &bundle, None, &[])?;
    Ok(ImportPreview {
        object_counts: bundle.counts(),
        conflicts: outcome.conflicts,
    })
}

pub async fn import_apply(
    pool: &SqlitePool,
    vault_state: &VaultState,
    app_data_dir: &Path,
    path: &str,
    passphrase: &str,
    resolutions: &[ConflictResolution],
) -> Result<ImportSummary> {
    let bundle = read_encrypted_bundle(path, app_data_dir, passphrase)?;
    validate_bundle(&bundle)?;
    let local = assemble_bundle(pool, vault_state, passphrase).await?;
    let outcome = merge_bundles(&local, &bundle, None, resolutions)?;
    validate_states(&outcome.states)?;
    let prepared = prepare_remote_secrets(
        vault_state,
        passphrase,
        &bundle.encrypted_key_secrets,
        &outcome.states,
        &outcome.remote_key_references,
    )?;
    apply_states(pool, &outcome.states).await?;
    let private_keys = apply_prepared_secrets(pool, vault_state, passphrase, prepared).await?;
    Ok(ImportSummary {
        applied: outcome.applied_remote,
        kept_local: outcome.kept_local,
        conflicts: outcome.conflicts,
        private_keys_applied: private_keys.applied,
        private_keys_skipped_locked: private_keys.skipped_locked,
    })
}

pub async fn get_config(pool: &SqlitePool) -> Result<SyncConfig> {
    let row = sqlx::query("SELECT provider, last_synced_at, state FROM sync_state WHERE id = 1")
        .fetch_one(pool)
        .await?;
    let provider: Option<String> = row.get("provider");
    let stored = parse_stored_state(row.get("state"))?;
    Ok(SyncConfig {
        enabled: provider.is_some(),
        provider,
        folder_path: stored.folder_path,
        url: stored.url,
        username: stored.username,
        gist_id: stored.gist_id,
        last_sync_at: row.get("last_synced_at"),
        last_remote_version: stored.last_remote_version,
        passphrase_remembered: keychain_get(KEYCHAIN_PASSPHRASE).is_ok(),
    })
}

pub async fn configure(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    app_data_dir: &Path,
    mut input: SyncConfigureInput,
) -> Result<()> {
    let provider = input.provider.trim();
    let mut stored = StoredSyncState::default();
    match provider {
        "local-folder" => {
            let folder = required_trimmed(input.folder_path.take(), "folderPath")?;
            let folder_path = PathBuf::from(&folder);
            providers::validate_local_folder(&folder_path)?;
            reject_app_data_path(&folder_path, app_data_dir)?;
            stored.folder_path = Some(folder);
            clear_keychain(KEYCHAIN_WEBDAV_PASSWORD);
            clear_keychain(KEYCHAIN_GIST_TOKEN);
        }
        "webdav" => {
            let url = required_trimmed(input.url.take(), "url")?;
            providers::validate_https_url(&url)?;
            let username = required_trimmed(input.username.take(), "username")?;
            let password = required_secret(input.password.take(), "password")?;
            keychain_set(KEYCHAIN_WEBDAV_PASSWORD, &password)?;
            clear_keychain(KEYCHAIN_GIST_TOKEN);
            stored.url = Some(url);
            stored.username = Some(username);
        }
        "github-gist" => {
            let token = required_secret(input.token.take(), "token")?;
            keychain_set(KEYCHAIN_GIST_TOKEN, &token)?;
            clear_keychain(KEYCHAIN_WEBDAV_PASSWORD);
            stored.gist_id = optional_identifier(input.gist_id.take(), "gistId")?;
        }
        _ => {
            return Err(LumaError::InvalidInput(
                "provider must be 'local-folder', 'webdav', or 'github-gist'".into(),
            ));
        }
    }

    let state_json = serde_json::to_string(&stored)
        .map_err(|_| LumaError::InvalidInput("sync configuration is invalid".into()))?;
    sqlx::query(
        "UPDATE sync_state SET provider = ?1, last_synced_at = NULL, state = ?2 WHERE id = 1",
    )
    .bind(provider)
    .bind(state_json)
    .execute(pool)
    .await?;
    *runtime.pending.lock().unwrap() = None;
    Ok(())
}

pub fn set_passphrase(
    runtime: &SyncRuntimeState,
    passphrase: String,
    remember: bool,
) -> Result<()> {
    validate_passphrase(&passphrase)?;
    if remember {
        keychain_set(KEYCHAIN_PASSPHRASE, &passphrase)?;
    } else {
        clear_keychain(KEYCHAIN_PASSPHRASE);
    }
    *runtime.passphrase.lock().unwrap() = Some(Zeroizing::new(passphrase));
    Ok(())
}

pub async fn disable(pool: &SqlitePool, runtime: &SyncRuntimeState) -> Result<()> {
    sqlx::query(
        "UPDATE sync_state SET provider = NULL, last_synced_at = NULL, state = NULL WHERE id = 1",
    )
    .execute(pool)
    .await?;
    clear_keychain(KEYCHAIN_WEBDAV_PASSWORD);
    clear_keychain(KEYCHAIN_GIST_TOKEN);
    clear_keychain(KEYCHAIN_PASSPHRASE);
    *runtime.passphrase.lock().unwrap() = None;
    *runtime.pending.lock().unwrap() = None;
    Ok(())
}

pub async fn sync_now(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    vault_state: &VaultState,
    app_data_dir: &Path,
) -> Result<SyncReport> {
    let (provider_name, mut stored) = load_enabled_config(pool).await?;
    let passphrase = current_passphrase(runtime)?;
    let provider = create_provider(&provider_name, &stored, app_data_dir)?;
    let remote = provider.download().await?;
    let local = assemble_bundle(pool, vault_state, &passphrase).await?;

    let Some(remote) = remote else {
        let blob = encrypt_bundle(&local, &passphrase)?;
        let uploaded = provider.upload(&blob, None).await?;
        update_after_upload(pool, &provider_name, &mut stored, &local, uploaded).await?;
        *runtime.pending.lock().unwrap() = None;
        return Ok(SyncReport {
            pulled: false,
            pushed: true,
            conflicts: Vec::new(),
            up_to_date: false,
            private_keys_applied: 0,
            private_keys_skipped_locked: 0,
        });
    };

    let remote_bundle = decrypt_bundle(&remote.bytes, &passphrase)?;
    validate_bundle(&remote_bundle)?;
    let outcome = merge_bundles(&local, &remote_bundle, Some(&stored.baseline), &[])?;
    validate_states(&outcome.states)?;
    let prepared = prepare_remote_secrets(
        vault_state,
        &passphrase,
        &remote_bundle.encrypted_key_secrets,
        &outcome.states,
        &outcome.remote_key_references,
    )?;
    apply_states(pool, &outcome.states).await?;
    let private_keys = apply_prepared_secrets(pool, vault_state, &passphrase, prepared).await?;
    let pulled = !outcome.applied_remote.is_empty() || private_keys.applied > 0;

    if !outcome.conflicts.is_empty() {
        *runtime.pending.lock().unwrap() = Some(PendingSync {
            provider: provider_name,
            remote_version: remote.version,
            remote_states: remote_bundle.states()?,
            remote_encrypted_key_secrets: remote_bundle.encrypted_key_secrets.clone(),
            conflicts: outcome.conflicts.clone(),
        });
        return Ok(SyncReport {
            pulled,
            pushed: false,
            conflicts: outcome.conflicts,
            up_to_date: false,
            private_keys_applied: private_keys.applied,
            private_keys_skipped_locked: private_keys.skipped_locked,
        });
    }

    let merged = assemble_bundle(pool, vault_state, &passphrase).await?;
    let compare_private_keys = private_key_sync_active(pool, vault_state).await?;
    let needs_push =
        !bundles_have_same_content(&merged, &remote_bundle, &passphrase, compare_private_keys)?;
    let pushed = if needs_push {
        let blob = encrypt_bundle(&merged, &passphrase)?;
        let uploaded = provider.upload(&blob, Some(&remote.version)).await?;
        update_after_upload(pool, &provider_name, &mut stored, &merged, uploaded).await?;
        true
    } else {
        stored.last_remote_version = Some(remote.version);
        stored.baseline = baseline_for_bundle(&merged)?;
        save_stored_state(pool, &stored, true).await?;
        false
    };
    *runtime.pending.lock().unwrap() = None;
    Ok(SyncReport {
        pulled,
        pushed,
        conflicts: Vec::new(),
        up_to_date: !pulled && !pushed,
        private_keys_applied: private_keys.applied,
        private_keys_skipped_locked: private_keys.skipped_locked,
    })
}

pub async fn sync_resolve(
    pool: &SqlitePool,
    runtime: &SyncRuntimeState,
    vault_state: &VaultState,
    app_data_dir: &Path,
    resolutions: &[ConflictResolution],
) -> Result<SyncReport> {
    let pending = runtime
        .pending
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| LumaError::InvalidInput("there are no pending sync conflicts".into()))?;
    let (provider_name, mut stored) = load_enabled_config(pool).await?;
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

    let passphrase = current_passphrase(runtime)?;
    let local = assemble_bundle(pool, vault_state, &passphrase).await?;
    let mut states = local.states()?;
    let mut pulled = false;
    let mut remote_key_references = HashSet::new();
    for conflict in &pending.conflicts {
        let key = object_key(&conflict.object_type, &conflict.object_id);
        if resolution_map[&key] == ResolutionChoice::TakeRemote {
            match pending.remote_states.get(&key) {
                Some(remote) => {
                    states.insert(key, remote.clone());
                    if remote.object_type == "key_reference" && remote.payload.is_some() {
                        remote_key_references.insert(remote.object_id.clone());
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
        vault_state,
        &passphrase,
        &pending.remote_encrypted_key_secrets,
        &states,
        &remote_key_references,
    )?;
    apply_states(pool, &states).await?;
    let private_keys = apply_prepared_secrets(pool, vault_state, &passphrase, prepared).await?;
    pulled |= private_keys.applied > 0;

    let provider = create_provider(&provider_name, &stored, app_data_dir)?;
    let merged = assemble_bundle(pool, vault_state, &passphrase).await?;
    let blob = encrypt_bundle(&merged, &passphrase)?;
    let uploaded = provider
        .upload(&blob, Some(&pending.remote_version))
        .await?;
    update_after_upload(pool, &provider_name, &mut stored, &merged, uploaded).await?;
    *runtime.pending.lock().unwrap() = None;
    Ok(SyncReport {
        pulled,
        pushed: true,
        conflicts: Vec::new(),
        up_to_date: false,
        private_keys_applied: private_keys.applied,
        private_keys_skipped_locked: private_keys.skipped_locked,
    })
}

fn encrypt_bundle(bundle: &SyncBundle, passphrase: &str) -> Result<Vec<u8>> {
    validate_passphrase(passphrase)?;
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
    let key = Zeroizing::new(derive_sync_key(passphrase, &salt)?);

    let mut blob = Vec::with_capacity(HEADER_LEN + plaintext.len() + 16);
    blob.extend_from_slice(MAGIC);
    blob.extend_from_slice(&[
        ENVELOPE_VERSION,
        KDF_ARGON2ID,
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

fn decrypt_bundle(blob: &[u8], passphrase: &str) -> Result<SyncBundle> {
    validate_passphrase(passphrase)?;
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
        || blob[9] != KDF_ARGON2ID
        || blob[10] != CIPHER_XCHACHA20_POLY1305
        || blob[11] as usize != SALT_LEN
        || blob[12] as usize != NONCE_LEN
    {
        return Err(LumaError::InvalidInput(
            "encrypted sync format is unsupported".into(),
        ));
    }
    let salt = &blob[13..13 + SALT_LEN];
    let nonce = &blob[13 + SALT_LEN..HEADER_LEN];
    let key = Zeroizing::new(derive_sync_key(passphrase, salt)?);
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
    let bundle: SyncBundle = serde_json::from_slice(&plaintext)
        .map_err(|_| LumaError::InvalidInput("sync bundle contains invalid JSON".into()))?;
    validate_bundle(&bundle)?;
    Ok(bundle)
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
    passphrase: &str,
) -> Result<SyncEncryptedSecret> {
    validate_passphrase(passphrase)?;
    if plaintext.len() > MAX_SYNC_SECRET_BYTES {
        return Err(LumaError::InvalidInput(
            "private key sync secret exceeds the size limit".into(),
        ));
    }
    let mut salt = [0_u8; SALT_LEN];
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let key = Zeroizing::new(derive_sync_key(passphrase, &salt)?);
    let aad = secret_aad(
        key_reference_id,
        secret_type,
        KDF_ARGON2ID,
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
        kdf_id: KDF_ARGON2ID,
        cipher_id: CIPHER_XCHACHA20_POLY1305,
        salt: base64.encode(salt),
        nonce: base64.encode(nonce),
        ciphertext: base64.encode(ciphertext),
        updated_at,
    })
}

fn decode_sync_secret_parts(secret: &SyncEncryptedSecret) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    validate_encrypted_secret_metadata(secret)?;
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
    passphrase: &str,
) -> Result<Zeroizing<String>> {
    validate_passphrase(passphrase)?;
    let (salt, nonce, ciphertext) = decode_sync_secret_parts(secret)?;
    let key = Zeroizing::new(derive_sync_key(passphrase, &salt)?);
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

async fn private_key_sync_active(pool: &SqlitePool, vault_state: &VaultState) -> Result<bool> {
    Ok(settings::sync_include_private_keys(pool).await? && vault::is_unlocked(vault_state))
}

async fn assemble_bundle(
    pool: &SqlitePool,
    vault_state: &VaultState,
    passphrase: &str,
) -> Result<SyncBundle> {
    assemble_bundle_inner(pool, Some((vault_state, passphrase))).await
}

async fn assemble_bundle_without_private_keys(pool: &SqlitePool) -> Result<SyncBundle> {
    assemble_bundle_inner(pool, None).await
}

async fn assemble_bundle_inner(
    pool: &SqlitePool,
    private_key_sync: Option<(&VaultState, &str)>,
) -> Result<SyncBundle> {
    let device_id: String = sqlx::query_scalar("SELECT device_id FROM sync_state WHERE id = 1")
        .fetch_one(pool)
        .await?;

    let hosts = sqlx::query(
        "SELECT id,name,hostname,port,username,group_id,auth_type,key_id,proxy_jump_host_id,
                startup_command,working_directory,environment,tags,favorite,tab_color,updated_at FROM hosts
         WHERE is_ephemeral = 0",
    )
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
            updated_at: row.get("updated_at"),
        })
    })
    .collect::<Result<Vec<_>>>()?;

    let host_groups =
        sqlx::query("SELECT id,name,parent_id,sort_order,updated_at FROM host_groups")
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|row| SyncHostGroup {
                id: row.get("id"),
                name: row.get("name"),
                parent_id: row.get("parent_id"),
                sort_order: row.get("sort_order"),
                updated_at: row.get("updated_at"),
            })
            .collect();

    let mut key_references = Vec::new();
    let mut private_key_reference_timestamps = Vec::new();
    for row in sqlx::query(
        "SELECT id,name,public_key,storage_mode,local_path,fingerprint,certificate,
                has_private_key,updated_at FROM key_references",
    )
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

    let mut encrypted_key_secrets = Vec::new();
    if let Some((vault_state, passphrase)) = private_key_sync {
        if private_key_sync_active(pool, vault_state).await? {
            for (key_reference_id, updated_at) in private_key_reference_timestamps {
                for secret_type in [PRIVATE_KEY_SECRET_TYPE, PASSPHRASE_SECRET_TYPE] {
                    match vault::load(
                        pool,
                        vault_state,
                        VAULT_KEY_OWNER_TYPE,
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
                                passphrase,
                            )?);
                        }
                        Ok(None) => {}
                        Err(_error) if !vault::is_unlocked(vault_state) => {
                            encrypted_key_secrets.clear();
                            break;
                        }
                        Err(error) => return Err(error),
                    }
                }
                if !vault::is_unlocked(vault_state) {
                    encrypted_key_secrets.clear();
                    break;
                }
            }
        }
    }

    let terminal_profiles = sqlx::query(
        "SELECT id,name,shell_path,args,working_directory,environment,platform,updated_at
         FROM terminal_profiles",
    )
    .fetch_all(pool)
    .await?
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
        "SELECT id,name,command,description,tags,variables,host_id,updated_at FROM snippets",
    )
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
    for row in sqlx::query("SELECT key,value,updated_at FROM settings")
        .fetch_all(pool)
        .await?
    {
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

    let tombstones = sqlx::query("SELECT object_type,object_id,deleted_at FROM tombstones")
        .fetch_all(pool)
        .await?
        .into_iter()
        .filter_map(|row| {
            let object_type: String = row.get("object_type");
            let object_id: String = row.get("object_id");
            (object_type != "setting" || is_safe_setting_key(&object_id)).then_some(SyncTombstone {
                object_type,
                object_id,
                deleted_at: row.get("deleted_at"),
            })
        })
        .collect();

    let bundle = SyncBundle {
        format_version: FORMAT_VERSION,
        device_id,
        updated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        hosts,
        host_groups,
        key_references,
        encrypted_key_secrets,
        terminal_profiles,
        snippets,
        settings: settings_map,
        tombstones,
    };
    validate_bundle(&bundle)?;
    Ok(bundle)
}

impl SyncBundle {
    fn counts(&self) -> ObjectCounts {
        ObjectCounts {
            hosts: self.hosts.len(),
            host_groups: self.host_groups.len(),
            key_references: self.key_references.len(),
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
    let mut used_resolutions = HashSet::new();

    for key in keys {
        let local_item = local.get(&key);
        let remote_item = remote.get(&key);
        match (local_item, remote_item) {
            (Some(local_item), Some(remote_item)) if local_item.hash() == remote_item.hash() => {
                let selected = if remote_item.updated_at > local_item.updated_at {
                    mark_remote_key_reference(remote_item, &mut remote_key_references);
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
                            mark_remote_key_reference(remote_item, &mut remote_key_references);
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
                        mark_remote_key_reference(remote_item, &mut remote_key_references);
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
                mark_remote_key_reference(remote_item, &mut remote_key_references);
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
    })
}

fn mark_remote_key_reference(item: &MergeItem, ids: &mut HashSet<String>) {
    if item.object_type == "key_reference" && item.payload.is_some() {
        ids.insert(item.object_id.clone());
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
    let mut secret_ids = HashSet::new();
    let mut salt_nonces = HashSet::new();
    for secret in &bundle.encrypted_key_secrets {
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
        || secret.kdf_id != KDF_ARGON2ID
        || secret.cipher_id != CIPHER_XCHACHA20_POLY1305
        || secret.updated_at < 0
    {
        return Err(LumaError::InvalidInput(
            "encrypted key secret metadata is invalid or unsupported".into(),
        ));
    }
    Ok(())
}

fn validate_states(states: &BTreeMap<String, MergeItem>) -> Result<()> {
    let mut group_parents = HashMap::new();
    let mut host_proxies = HashMap::new();
    let mut group_ids = HashSet::new();
    let mut key_ids = HashSet::new();
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
                group_ids.insert(group.id.clone());
                group_parents.insert(group.id, group.parent_id);
            }
            "key_reference" => {
                let key: SyncKeyReference = payload_as(item)?;
                key_references::validate(&key_references::KeyReferenceInput {
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
                    name: host.name,
                    hostname: host.hostname,
                    port: i64::from(host.port),
                    username: host.username,
                    group_id: host.group_id.clone(),
                    authentication_type: host.authentication_type,
                    key_id: host.key_id.clone(),
                    identity_id: None,
                    proxy_jump_host_id: host.proxy_jump_host_id.clone(),
                    startup_command: host.startup_command,
                    working_directory: host.working_directory,
                    environment: host.environment,
                    tags: host.tags,
                    favorite: host.favorite,
                    tab_color: host.tab_color,
                })?;
                host_ids.insert(host.id.clone());
                host_proxies.insert(
                    host.id,
                    (host.group_id, host.key_id, host.proxy_jump_host_id),
                );
            }
            "terminal_profile" => validate_sync_profile(&payload_as::<SyncTerminalProfile>(item)?)?,
            "snippet" => {
                let snippet: SyncSnippet = payload_as(item)?;
                snippets::validate_fields(&snippets::SnippetInput {
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
    for (host_id, (group_id, key_id, proxy_id)) in &host_proxies {
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
        if proxy_id.as_ref().is_some_and(|id| !host_ids.contains(id)) {
            return Err(LumaError::InvalidInput(
                "synced host references an unknown proxy jump host".into(),
            ));
        }
        let proxy_map: HashMap<String, Option<String>> = host_proxies
            .iter()
            .map(|(id, (_, _, proxy))| (id.clone(), proxy.clone()))
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
    vault_state: &VaultState,
    passphrase: &str,
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
    if !vault::is_unlocked(vault_state) {
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
        drop(decrypt_sync_secret(secret, passphrase)?);
    }
    Ok(PreparedRemoteSecrets {
        entries,
        skipped_locked: 0,
    })
}

async fn apply_prepared_secrets(
    pool: &SqlitePool,
    vault_state: &VaultState,
    passphrase: &str,
    prepared: PreparedRemoteSecrets,
) -> Result<PrivateKeyApplySummary> {
    let mut summary = PrivateKeyApplySummary {
        applied: 0,
        skipped_locked: prepared.skipped_locked,
    };
    let mut applied_private_key_ids = HashSet::new();
    for (index, secret) in prepared.entries.iter().enumerate() {
        if !vault::is_unlocked(vault_state) {
            summary.skipped_locked += prepared.entries[index..]
                .iter()
                .filter(|remaining| remaining.secret_type == PRIVATE_KEY_SECRET_TYPE)
                .map(|remaining| remaining.key_reference_id.as_str())
                .filter(|id| !applied_private_key_ids.contains(*id))
                .collect::<HashSet<_>>()
                .len();
            break;
        }
        let plaintext = decrypt_sync_secret(secret, passphrase)?;
        match vault::store(
            pool,
            vault_state,
            VAULT_KEY_OWNER_TYPE,
            &secret.key_reference_id,
            &secret.secret_type,
            &plaintext,
        )
        .await
        {
            Ok(()) => {}
            Err(_error) if !vault::is_unlocked(vault_state) => {
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

async fn apply_states(pool: &SqlitePool, states: &BTreeMap<String, MergeItem>) -> Result<()> {
    let mut deleted_key_references = Vec::new();
    let mut transaction = pool.begin().await?;
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *transaction)
        .await?;
    for item in states.values() {
        match &item.payload {
            None => {
                if item.object_type == "key_reference" {
                    deleted_key_references.push(item.object_id.clone());
                }
                let query = match item.object_type.as_str() {
                    "host" => "DELETE FROM hosts WHERE id = ?1",
                    "host_group" => "DELETE FROM host_groups WHERE id = ?1",
                    "key_reference" => "DELETE FROM key_references WHERE id = ?1",
                    "terminal_profile" => "DELETE FROM terminal_profiles WHERE id = ?1",
                    "snippet" => "DELETE FROM snippets WHERE id = ?1",
                    "setting" => "DELETE FROM settings WHERE key = ?1",
                    _ => return Err(LumaError::InvalidInput("unknown sync object type".into())),
                };
                sqlx::query(query)
                    .bind(&item.object_id)
                    .execute(&mut *transaction)
                    .await?;
                sqlx::query(
                    "INSERT INTO tombstones(object_type,object_id,deleted_at) VALUES(?1,?2,?3)
                     ON CONFLICT(object_type,object_id) DO UPDATE SET deleted_at=excluded.deleted_at",
                )
                .bind(&item.object_type)
                .bind(&item.object_id)
                .bind(item.updated_at)
                .execute(&mut *transaction)
                .await?;
            }
            Some(_) => {
                apply_object(&mut transaction, item).await?;
                sqlx::query("DELETE FROM tombstones WHERE object_type=?1 AND object_id=?2")
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
    Ok(())
}

async fn apply_object(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    item: &MergeItem,
) -> Result<()> {
    match item.object_type.as_str() {
        "host_group" => {
            let value: SyncHostGroup = payload_as(item)?;
            sqlx::query(
                "INSERT INTO host_groups(id,name,parent_id,sort_order,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?5)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,
                 sort_order=excluded.sort_order,updated_at=excluded.updated_at",
            )
            .bind(value.id)
            .bind(value.name)
            .bind(value.parent_id)
            .bind(value.sort_order)
            .bind(value.updated_at)
            .execute(&mut **transaction)
            .await?;
        }
        "key_reference" => {
            let value: SyncKeyReference = payload_as(item)?;
            sqlx::query(
                "INSERT INTO key_references(id,name,public_key,storage_mode,local_path,fingerprint,
                 certificate,has_private_key,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8,?8)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,public_key=excluded.public_key,
                 storage_mode=excluded.storage_mode,local_path=excluded.local_path,
                 fingerprint=excluded.fingerprint,certificate=excluded.certificate,
                 updated_at=excluded.updated_at",
            )
            .bind(value.id)
            .bind(value.name)
            .bind(value.public_key)
            .bind(value.storage_mode)
            .bind(value.local_path)
            .bind(value.fingerprint)
            .bind(value.certificate)
            .bind(value.updated_at)
            .execute(&mut **transaction)
            .await?;
        }
        "host" => {
            let value: SyncHost = payload_as(item)?;
            sqlx::query(
                "INSERT INTO hosts(id,name,hostname,port,username,group_id,auth_type,key_id,identity_id,
                 proxy_jump_host_id,startup_command,working_directory,environment,tags,favorite,tab_color,
                 created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,NULL,?9,?10,?11,?12,?13,?14,?15,?16,?16)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,hostname=excluded.hostname,
                 port=excluded.port,username=excluded.username,group_id=excluded.group_id,
                 auth_type=excluded.auth_type,key_id=excluded.key_id,
                 proxy_jump_host_id=excluded.proxy_jump_host_id,startup_command=excluded.startup_command,
                 working_directory=excluded.working_directory,environment=excluded.environment,
                 tags=excluded.tags,favorite=excluded.favorite,tab_color=excluded.tab_color,
                 updated_at=excluded.updated_at",
            )
            .bind(value.id)
            .bind(value.name)
            .bind(value.hostname)
            .bind(i64::from(value.port))
            .bind(value.username)
            .bind(value.group_id)
            .bind(value.authentication_type)
            .bind(value.key_id)
            .bind(value.proxy_jump_host_id)
            .bind(value.startup_command)
            .bind(value.working_directory)
            .bind(value.environment.map(|environment| serde_json::to_string(&environment)).transpose().map_err(|_| LumaError::InvalidInput("host environment is invalid".into()))?)
            .bind(serde_json::to_string(&value.tags).map_err(|_| LumaError::InvalidInput("host tags are invalid".into()))?)
            .bind(value.favorite)
            .bind(value.tab_color)
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
                "INSERT INTO snippets(id,name,command,description,tags,variables,host_id,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,command=excluded.command,
                 description=excluded.description,tags=excluded.tags,variables=excluded.variables,
                 host_id=excluded.host_id,updated_at=excluded.updated_at",
            )
            .bind(value.id)
            .bind(value.name)
            .bind(value.command)
            .bind(value.description)
            .bind(serde_json::to_string(&value.tags).map_err(|_| LumaError::InvalidInput("snippet tags are invalid".into()))?)
            .bind(serde_json::to_string(&value.variables).map_err(|_| LumaError::InvalidInput("snippet variables are invalid".into()))?)
            .bind(value.host_id)
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
    decrypt_bundle(&blob, passphrase)
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
        "host" | "host_group" | "key_reference" | "terminal_profile" | "snippet" | "setting"
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
    passphrase: &str,
    compare_private_keys: bool,
) -> Result<bool> {
    if baseline_for_bundle(left)? != baseline_for_bundle(right)? {
        return Ok(false);
    }
    if !compare_private_keys {
        return Ok(true);
    }
    Ok(secret_content_hashes(left, passphrase)? == secret_content_hashes(right, passphrase)?)
}

fn secret_content_hashes(
    bundle: &SyncBundle,
    passphrase: &str,
) -> Result<BTreeMap<(String, String), [u8; 32]>> {
    let mut hashes = BTreeMap::new();
    for secret in &bundle.encrypted_key_secrets {
        let plaintext = decrypt_sync_secret(secret, passphrase)?;
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

fn keychain_entry(account: &str) -> Result<Entry> {
    Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|_| LumaError::SyncUnavailable("OS credential store is unavailable".into()))
}

fn keychain_set(account: &str, secret: &str) -> Result<()> {
    keychain_entry(account)?
        .set_password(secret)
        .map_err(|_| LumaError::SyncUnavailable("could not store sync credential".into()))
}

fn keychain_get(account: &str) -> Result<String> {
    keychain_entry(account)?
        .get_password()
        .map_err(|_| LumaError::SyncAuthFailed("required sync credential is not available".into()))
}

fn clear_keychain(account: &str) {
    if let Ok(entry) = Entry::new(KEYCHAIN_SERVICE, account) {
        let _ = entry.delete_credential();
    }
}

fn current_passphrase(runtime: &SyncRuntimeState) -> Result<Zeroizing<String>> {
    runtime
        .passphrase
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| {
            LumaError::VaultLocked(
                "sync passphrase is not set; enter it before synchronizing".into(),
            )
        })
}

async fn load_enabled_config(pool: &SqlitePool) -> Result<(String, StoredSyncState)> {
    let row = sqlx::query("SELECT provider,state FROM sync_state WHERE id=1")
        .fetch_one(pool)
        .await?;
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

fn create_provider(
    provider: &str,
    stored: &StoredSyncState,
    app_data_dir: &Path,
) -> Result<Box<dyn SyncProvider>> {
    match provider {
        "local-folder" => {
            let folder = stored.folder_path.as_ref().ok_or_else(|| {
                LumaError::SyncUnavailable("local sync folder is not configured".into())
            })?;
            let path = PathBuf::from(folder);
            providers::validate_local_folder(&path)?;
            reject_app_data_path(&path, app_data_dir)?;
            Ok(Box::new(LocalFolderProvider::new(path)))
        }
        "webdav" => Ok(Box::new(WebDavProvider::new(
            stored
                .url
                .clone()
                .ok_or_else(|| LumaError::SyncUnavailable("WebDAV URL is not configured".into()))?,
            stored.username.clone().ok_or_else(|| {
                LumaError::SyncUnavailable("WebDAV username is not configured".into())
            })?,
            keychain_get(KEYCHAIN_WEBDAV_PASSWORD)?,
        )?)),
        "github-gist" => Ok(Box::new(GitHubGistProvider::new(
            keychain_get(KEYCHAIN_GIST_TOKEN)?,
            stored.gist_id.clone(),
        )?)),
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
) -> Result<()> {
    stored.last_remote_version = Some(uploaded.version);
    stored.baseline = baseline_for_bundle(bundle)?;
    if provider == "github-gist" {
        if let Some(gist_id) = uploaded.remote_id {
            stored.gist_id = Some(gist_id);
        }
    }
    save_stored_state(pool, stored, true).await
}

async fn save_stored_state(
    pool: &SqlitePool,
    stored: &StoredSyncState,
    mark_synced: bool,
) -> Result<()> {
    let state = serde_json::to_string(stored)
        .map_err(|_| LumaError::SyncUnavailable("could not save sync state".into()))?;
    if mark_synced {
        sqlx::query("UPDATE sync_state SET state=?1,last_synced_at=unixepoch() WHERE id=1")
            .bind(state)
            .execute(pool)
            .await?;
    } else {
        sqlx::query("UPDATE sync_state SET state=?1 WHERE id=1")
            .bind(state)
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
            encrypted_key_secrets: Vec::new(),
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

    #[test]
    fn encrypted_bundle_roundtrip() {
        let mut bundle = empty_bundle("11111111-1111-4111-8111-111111111111");
        bundle
            .settings
            .insert("appearance.theme".into(), setting("dark", 10));
        let encrypted = encrypt_bundle(&bundle, "correct horse battery staple").unwrap();
        let decrypted = decrypt_bundle(&encrypted, "correct horse battery staple").unwrap();
        assert_eq!(decrypted, bundle);
    }

    #[test]
    fn wrong_passphrase_and_tampering_fail_readably() {
        let bundle = empty_bundle("11111111-1111-4111-8111-111111111111");
        let mut encrypted = encrypt_bundle(&bundle, "correct passphrase").unwrap();
        let error = decrypt_bundle(&encrypted, "incorrect passphrase").unwrap_err();
        assert_eq!(error.category(), "sync-auth-failed");
        assert!(error.to_string().contains("incorrect sync passphrase"));

        let last = encrypted.len() - 1;
        encrypted[last] ^= 0x80;
        let error = decrypt_bundle(&encrypted, "correct passphrase").unwrap_err();
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
            "correct horse battery staple",
        )
        .unwrap();
        let decrypted = decrypt_sync_secret(&encrypted, "correct horse battery staple").unwrap();
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
                "correct horse battery staple",
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

    #[tokio::test]
    async fn private_key_sync_opt_in_off_assembles_no_encrypted_secrets() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let runtime = SyncRuntimeState::default();
        initialize(&pool, &runtime).await.unwrap();
        sqlx::query(
            "INSERT INTO key_references(id,name,storage_mode,has_private_key,updated_at)\n             VALUES('key-1','Local key','encrypted-vault',1,42)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let vault_state = VaultState::default();
        vault::setup(&pool, &vault_state, "vault password", false)
            .await
            .unwrap();
        vault::store(
            &pool,
            &vault_state,
            VAULT_KEY_OWNER_TYPE,
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

        let bundle = assemble_bundle(&pool, &vault_state, "correct horse battery staple")
            .await
            .unwrap();
        assert!(bundle.encrypted_key_secrets.is_empty());
        assert!(!serde_json::to_string(&bundle)
            .unwrap()
            .contains("encryptedKeySecrets"));
    }

    #[tokio::test]
    async fn vault_locked_apply_skips_private_keys_and_counts_them() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let vault_state = VaultState::default();
        let passphrase = "correct horse battery staple";
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
                passphrase,
            )
            .unwrap(),
        );
        let local = empty_bundle("11111111-1111-4111-8111-111111111111");
        let outcome = merge_bundles(&local, &remote, None, &[]).unwrap();
        let prepared = prepare_remote_secrets(
            &vault_state,
            passphrase,
            &remote.encrypted_key_secrets,
            &outcome.states,
            &outcome.remote_key_references,
        )
        .unwrap();
        apply_states(&pool, &outcome.states).await.unwrap();
        let summary = apply_prepared_secrets(&pool, &vault_state, passphrase, prepared)
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
    async fn unlocked_apply_reencrypts_private_key_into_local_vault() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let vault_state = VaultState::default();
        vault::setup(&pool, &vault_state, "vault password", false)
            .await
            .unwrap();
        let passphrase = "correct horse battery staple";
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
                passphrase,
            )
            .unwrap(),
        );
        let local = empty_bundle("11111111-1111-4111-8111-111111111111");
        let outcome = merge_bundles(&local, &remote, None, &[]).unwrap();
        let prepared = prepare_remote_secrets(
            &vault_state,
            passphrase,
            &remote.encrypted_key_secrets,
            &outcome.states,
            &outcome.remote_key_references,
        )
        .unwrap();
        apply_states(&pool, &outcome.states).await.unwrap();
        let summary = apply_prepared_secrets(&pool, &vault_state, passphrase, prepared)
            .await
            .unwrap();

        assert_eq!(summary.applied, 1);
        assert_eq!(summary.skipped_locked, 0);
        let stored = vault::load(
            &pool,
            &vault_state,
            VAULT_KEY_OWNER_TYPE,
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
        let vault_state = VaultState::default();
        vault::setup(&pool, &vault_state, "vault password", false)
            .await
            .unwrap();
        let local_private_key =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nLOCALKEY\n-----END OPENSSH PRIVATE KEY-----\n";
        vault::store(
            &pool,
            &vault_state,
            VAULT_KEY_OWNER_TYPE,
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
                "correct horse battery staple",
            )
            .unwrap(),
        );
        let outcome = merge_bundles(&local, &remote, None, &[]).unwrap();
        assert_eq!(outcome.conflicts.len(), 1);
        assert!(outcome.remote_key_references.is_empty());
        let prepared = prepare_remote_secrets(
            &vault_state,
            "correct horse battery staple",
            &remote.encrypted_key_secrets,
            &outcome.states,
            &outcome.remote_key_references,
        )
        .unwrap();
        apply_states(&pool, &outcome.states).await.unwrap();
        let summary = apply_prepared_secrets(
            &pool,
            &vault_state,
            "correct horse battery staple",
            prepared,
        )
        .await
        .unwrap();

        assert_eq!(summary.applied, 0);
        let stored = vault::load(
            &pool,
            &vault_state,
            VAULT_KEY_OWNER_TYPE,
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
        let bundle: SyncBundle = serde_json::from_value(value).unwrap();
        assert!(bundle.encrypted_key_secrets.is_empty());
        assert_eq!(bundle.hosts[0].tab_color, None);
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
        let error = encrypt_bundle(&bundle, "correct passphrase").unwrap_err();
        assert_eq!(error.category(), "invalid-input");
        assert!(!error.to_string().contains("do-not-sync"));
    }
}
