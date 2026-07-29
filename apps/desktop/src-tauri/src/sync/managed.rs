//! Managed vaults: shared vaults whose content key Luma Cloud distributes,
//! sealed per device, instead of every member typing the same passphrase.
//!
//! The server never sees the key. It stores an opaque envelope per (vault,
//! device, epoch), exactly as the collaboration server already does for room
//! keys, and enforces membership and roles around them. Sealing and opening
//! happen in [`super::vault_key`], here in Rust, so the key never reaches JS.

use reqwest::Method;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::collaboration::{
    account_access_token, CollaborationRuntimeState, DeviceIdentity, DevicePublicKey,
};
use crate::errors::{LumaError, Result};
use crate::keystore::KeystoreState;
use crate::storage::vaults::{self, Vault};

use super::vault_key::{self, EnvelopeContext, VaultKeyEnvelope};
use super::VaultSecret;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteVault {
    pub id: String,
    pub key_epoch: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInvite {
    pub id: String,
    pub secret: String,
    pub expires_at: i64,
    pub role: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinedVault {
    vault_id: String,
    key_epoch: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AwaitingDevice {
    subject: String,
    device_id: String,
    public_key: DevicePublicKey,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedKey {
    key_epoch: u32,
    envelope: VaultKeyEnvelope,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SealedKeyUpload<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    subject: Option<&'a str>,
    device_id: &'a str,
    envelope: &'a VaultKeyEnvelope,
}

/// Authenticated client for the vault routes on a Luma Cloud deployment.
pub struct ManagedClient {
    client: reqwest::Client,
    api_url: String,
    access_token: String,
}

impl ManagedClient {
    pub async fn connect(
        pool: &SqlitePool,
        collab_runtime: &CollaborationRuntimeState,
        keystore_state: &KeystoreState,
        api_url: &str,
    ) -> Result<Self> {
        super::providers::validate_cloud_api_url(api_url)?;
        let access_token = account_access_token(pool, collab_runtime, keystore_state)
            .await
            .map_err(|error| LumaError::SyncAuthFailed(error.to_string()))?;
        Ok(Self {
            client: super::providers::http_client()?,
            api_url: api_url.trim_end_matches('/').to_string(),
            access_token,
        })
    }

    async fn send<T: for<'de> Deserialize<'de>>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T> {
        let response = self.raw(method, path, body).await?;
        response
            .json::<T>()
            .await
            .map_err(|_| LumaError::SyncUnavailable("Luma Cloud sent an unreadable reply".into()))
    }

    async fn raw(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<reqwest::Response> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.api_url))
            .bearer_auth(&self.access_token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            LumaError::SyncUnavailable(format!("could not reach Luma Cloud: {error}"))
        })?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        // The server's message is the useful part ("this vault is shared with
        // you as a reader"), so surface it rather than the bare status.
        let message = response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|body| body.get("error")?.as_str().map(str::to_string))
            .unwrap_or_else(|| format!("Luma Cloud returned {status}"));
        Err(match status {
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
                LumaError::SyncAuthFailed(message)
            }
            _ => LumaError::SyncUnavailable(message),
        })
    }

    pub async fn create_vault(&self) -> Result<RemoteVault> {
        self.send(Method::POST, "/v1/vaults", Some(serde_json::json!({})))
            .await
    }

    pub async fn create_invite(&self, remote_vault_id: &str, role: &str) -> Result<VaultInvite> {
        self.send(
            Method::POST,
            &format!("/v1/vaults/{remote_vault_id}/invites"),
            Some(serde_json::json!({ "role": role })),
        )
        .await
    }

    pub async fn bump_key_epoch(&self, remote_vault_id: &str) -> Result<u32> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Bumped {
            key_epoch: u32,
        }
        Ok(self
            .send::<Bumped>(
                Method::POST,
                &format!("/v1/vaults/{remote_vault_id}/key-epoch"),
                Some(serde_json::json!({})),
            )
            .await?
            .key_epoch)
    }

    pub async fn remove_member(&self, remote_vault_id: &str, subject: &str) -> Result<()> {
        let subject = urlencoding(subject);
        self.raw(
            Method::DELETE,
            &format!("/v1/vaults/{remote_vault_id}/members/{subject}"),
            None,
        )
        .await?;
        Ok(())
    }

    async fn register_device(&self, identity: &DeviceIdentity) -> Result<()> {
        self.raw(
            Method::POST,
            "/v1/vaults/devices",
            Some(serde_json::json!({
                "deviceId": identity.device_id,
                "publicKey": identity.public_key,
            })),
        )
        .await?;
        Ok(())
    }

    async fn join(&self, secret: &str) -> Result<JoinedVault> {
        self.send(
            Method::POST,
            "/v1/vaults/join",
            Some(serde_json::json!({ "secret": secret })),
        )
        .await
    }

    async fn devices_awaiting_keys(&self, remote_vault_id: &str) -> Result<Vec<AwaitingDevice>> {
        #[derive(Deserialize)]
        struct Listed {
            devices: Vec<AwaitingDevice>,
        }
        Ok(self
            .send::<Listed>(
                Method::GET,
                &format!("/v1/vaults/{remote_vault_id}/keys"),
                None,
            )
            .await?
            .devices)
    }

    async fn upload_keys(&self, remote_vault_id: &str, keys: &[SealedKeyUpload<'_>]) -> Result<()> {
        self.raw(
            Method::POST,
            &format!("/v1/vaults/{remote_vault_id}/keys"),
            Some(serde_json::json!({ "keys": keys })),
        )
        .await?;
        Ok(())
    }

    async fn fetch_key(&self, remote_vault_id: &str, device_id: &str) -> Result<Option<SealedKey>> {
        let response = self
            .client
            .request(
                Method::GET,
                format!(
                    "{}/v1/vaults/{remote_vault_id}/key?deviceId={}",
                    self.api_url,
                    urlencoding(device_id)
                ),
            )
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|error| {
                LumaError::SyncUnavailable(format!("could not reach Luma Cloud: {error}"))
            })?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(LumaError::SyncUnavailable(format!(
                "Luma Cloud returned {}",
                response.status()
            )));
        }
        response
            .json::<SealedKey>()
            .await
            .map(Some)
            .map_err(|_| LumaError::SyncUnavailable("Luma Cloud sent an unreadable key".into()))
    }
}

/// Percent-encode the few characters that could otherwise change the shape of
/// a path or query. Subjects and device ids are server-issued, but they reach
/// this code as plain strings and must not be able to inject a segment.
fn urlencoding(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

async fn device_identity(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
) -> Result<DeviceIdentity> {
    crate::collaboration::get_device_identity(pool, keystore_state)
        .await
        .map_err(|error| LumaError::SyncUnavailable(error.to_string()))?
        .ok_or_else(|| {
            LumaError::SyncUnavailable(
                "this device has no Luma identity yet; open Collaboration settings once to create one"
                    .into(),
            )
        })
}

/// Create a managed vault: mint a content key, seal it to this device, and
/// register it with the server. The key is returned so the caller can encrypt
/// the first bundle without a round trip.
pub async fn create(
    pool: &SqlitePool,
    collab_runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    api_url: &str,
    name: &str,
    share_secrets: bool,
) -> Result<(Vault, VaultSecret)> {
    let client = ManagedClient::connect(pool, collab_runtime, keystore_state, api_url).await?;
    let identity = device_identity(pool, keystore_state).await?;
    client.register_device(&identity).await?;

    let remote = client.create_vault().await?;
    let content_key = vault_key::generate_content_key();
    let envelope = vault_key::seal(
        &content_key,
        &identity.public_key,
        EnvelopeContext {
            vault_id: &remote.id,
            key_epoch: remote.key_epoch,
            recipient_device_id: &identity.device_id,
        },
    )?;
    // Without this the vault would exist but be unopenable, including by its
    // own creator on this very device.
    client
        .upload_keys(
            &remote.id,
            &[SealedKeyUpload {
                subject: None,
                device_id: &identity.device_id,
                envelope: &envelope,
            }],
        )
        .await?;

    let vault =
        vaults::create_managed(pool, name, &remote.id, remote.key_epoch, share_secrets).await?;
    Ok((vault, VaultSecret::ContentKey(content_key)))
}

/// Redeem an invite. The vault is recorded locally straight away, but its
/// content key only becomes available once a member with the key seals it to
/// this device, so the first sync may report that it is still pending.
pub async fn join(
    pool: &SqlitePool,
    collab_runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    api_url: &str,
    name: &str,
    invite_secret: &str,
) -> Result<Vault> {
    let client = ManagedClient::connect(pool, collab_runtime, keystore_state, api_url).await?;
    let identity = device_identity(pool, keystore_state).await?;
    // Register first: the server can only offer this device for sealing once it
    // knows the public key, and the inviter may be online right now.
    client.register_device(&identity).await?;

    let joined = client.join(invite_secret).await?;
    if let Some(existing) = vaults::by_remote_id(pool, &joined.vault_id).await? {
        return Ok(existing);
    }
    vaults::create_managed(pool, name, &joined.vault_id, joined.key_epoch, false).await
}

/// Fetch and unseal this vault's content key for this device.
pub async fn content_key(
    pool: &SqlitePool,
    collab_runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    api_url: &str,
    vault: &Vault,
) -> Result<VaultSecret> {
    let remote_vault_id = vault
        .remote_vault_id
        .as_deref()
        .ok_or_else(|| LumaError::InvalidInput("this vault is not managed by Luma Cloud".into()))?;
    let client = ManagedClient::connect(pool, collab_runtime, keystore_state, api_url).await?;
    let identity = device_identity(pool, keystore_state).await?;

    let Some(sealed) = client
        .fetch_key(remote_vault_id, &identity.device_id)
        .await?
    else {
        // Membership without a key is the normal state right after joining.
        client.register_device(&identity).await?;
        return Err(LumaError::SyncUnavailable(
            "waiting for a member of this vault to share its key with this device".into(),
        ));
    };

    let content_key = vault_key::open(
        &sealed.envelope,
        &identity.private_key,
        EnvelopeContext {
            vault_id: remote_vault_id,
            key_epoch: sealed.key_epoch,
            recipient_device_id: &identity.device_id,
        },
    )?;
    if sealed.key_epoch != vault.key_epoch {
        vaults::set_key_epoch(pool, &vault.id, sealed.key_epoch).await?;
    }
    Ok(VaultSecret::ContentKey(content_key))
}

/// Seal this vault's key to every member device that does not yet hold it.
/// Runs opportunistically after a successful sync: a device that joins while
/// nobody is online simply waits for the next member to sync.
pub async fn share_key_with_pending_devices(
    pool: &SqlitePool,
    collab_runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    api_url: &str,
    vault: &Vault,
    secret: &VaultSecret,
) -> Result<usize> {
    let (Some(remote_vault_id), VaultSecret::ContentKey(content_key)) =
        (vault.remote_vault_id.as_deref(), secret)
    else {
        return Ok(0);
    };
    let client = ManagedClient::connect(pool, collab_runtime, keystore_state, api_url).await?;
    let pending = match client.devices_awaiting_keys(remote_vault_id).await {
        Ok(pending) => pending,
        // Readers may not hand the key on; the server says so with a 403. That
        // is a statement about this member's role, not a sync failure, so their
        // sync carries on and an owner or writer seals the waiting devices.
        Err(LumaError::SyncAuthFailed(_)) => return Ok(0),
        Err(error) => return Err(error),
    };
    if pending.is_empty() {
        return Ok(0);
    }

    let mut envelopes = Vec::with_capacity(pending.len());
    for device in &pending {
        envelopes.push((
            device,
            vault_key::seal(
                content_key,
                &device.public_key,
                EnvelopeContext {
                    vault_id: remote_vault_id,
                    key_epoch: vault.key_epoch,
                    recipient_device_id: &device.device_id,
                },
            )?,
        ));
    }
    let uploads: Vec<SealedKeyUpload<'_>> = envelopes
        .iter()
        .map(|(device, envelope)| SealedKeyUpload {
            subject: Some(&device.subject),
            device_id: &device.device_id,
            envelope,
        })
        .collect();
    client.upload_keys(remote_vault_id, &uploads).await?;
    Ok(uploads.len())
}

/// Start a new key epoch and re-seal to the devices that remain. Removing a
/// member does not retract what they already hold — the UI says so — but it
/// does stop them reading anything written afterwards.
pub async fn rotate_key(
    pool: &SqlitePool,
    collab_runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    api_url: &str,
    vault: &Vault,
) -> Result<VaultSecret> {
    let remote_vault_id = vault
        .remote_vault_id
        .as_deref()
        .ok_or_else(|| LumaError::InvalidInput("this vault is not managed by Luma Cloud".into()))?;
    let client = ManagedClient::connect(pool, collab_runtime, keystore_state, api_url).await?;
    let identity = device_identity(pool, keystore_state).await?;

    let key_epoch = client.bump_key_epoch(remote_vault_id).await?;
    let content_key = vault_key::generate_content_key();
    let envelope = vault_key::seal(
        &content_key,
        &identity.public_key,
        EnvelopeContext {
            vault_id: remote_vault_id,
            key_epoch,
            recipient_device_id: &identity.device_id,
        },
    )?;
    client
        .upload_keys(
            remote_vault_id,
            &[SealedKeyUpload {
                subject: None,
                device_id: &identity.device_id,
                envelope: &envelope,
            }],
        )
        .await?;
    vaults::set_key_epoch(pool, &vault.id, key_epoch).await?;
    Ok(VaultSecret::ContentKey(content_key))
}
