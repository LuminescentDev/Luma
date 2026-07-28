use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::Utc;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use keyring::Entry;
use reqwest::header::{CONTENT_TYPE, ETAG, IF_MATCH, IF_NONE_MATCH};
use reqwest::redirect::Policy;
use reqwest::{Method, Response, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tokio::sync::Mutex as AsyncMutex;
use uuid::{Variant, Version};
use zeroize::Zeroizing;

#[cfg(any(target_os = "android", target_os = "ios"))]
use crate::keystore;
use crate::keystore::KeystoreState;

const SNAPSHOT_CONTENT_TYPE: &str = "application/vnd.luma.encrypted-room-snapshot";
const MAX_JSON_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_AUTH_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const INVITE_PREFIX: &str = "luma-collab-invite-v1.";
const SESSION_SECRET_ID: &str = "oidc-session";
const PRIVATE_KEY_SECRET_ID: &str = "device-private-key";
#[cfg(any(target_os = "android", target_os = "ios"))]
const KEYSTORE_OWNER: &str = "collaboration-credential";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const KEYCHAIN_SERVICE: &str = "luma.collaboration";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const KEYCHAIN_CHUNK_MANIFEST_PREFIX: &str = "luma-chunks-v1:";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const KEYCHAIN_CHUNK_UTF16_LIMIT: usize = 1200;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const KEYCHAIN_MAX_CHUNKS: usize = 64;

pub type CollaborationResult<T> = std::result::Result<T, CollaborationError>;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CollaborationErrorCode {
    InvalidInput,
    AuthRequired,
    AuthDenied,
    AuthExpired,
    Forbidden,
    NotFound,
    Conflict,
    PreconditionFailed,
    PayloadTooLarge,
    UnsupportedMediaType,
    PreconditionRequired,
    RateLimited,
    Network,
    ServerUnavailable,
    InvalidResponse,
    Storage,
}

#[derive(Debug, Serialize, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct CollaborationError {
    pub code: CollaborationErrorCode,
    pub message: String,
    pub http_status: Option<u16>,
}

impl CollaborationError {
    fn new(code: CollaborationErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            http_status: None,
        }
    }

    fn with_status(
        code: CollaborationErrorCode,
        message: impl Into<String>,
        status: StatusCode,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            http_status: Some(status.as_u16()),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(CollaborationErrorCode::InvalidInput, message)
    }

    fn storage(message: impl Into<String>) -> Self {
        Self::new(CollaborationErrorCode::Storage, message)
    }
}

pub struct CollaborationRuntimeState {
    pending_auth: Mutex<Option<PendingAuthorization>>,
    refresh_lock: AsyncMutex<()>,
}

impl Default for CollaborationRuntimeState {
    fn default() -> Self {
        Self {
            pending_auth: Mutex::new(None),
            refresh_lock: AsyncMutex::new(()),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationConfig {
    pub server_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetServerUrlInput {
    pub server_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevicePublicKey {
    pub algorithm: String,
    pub x: String,
    pub y: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerializedDevicePrivateKey {
    pub algorithm: String,
    pub pkcs8: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceIdentity {
    pub device_id: String,
    pub public_key: DevicePublicKey,
    pub private_key: SerializedDevicePrivateKey,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetDeviceIdentityInput {
    pub device_id: String,
    pub public_key: DevicePublicKey,
    pub private_key: SerializedDevicePrivateKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomKeyEnvelope {
    pub version: u8,
    pub algorithm: String,
    pub room_id: String,
    pub key_epoch: u64,
    pub recipient_device_id: String,
    pub ephemeral_public_key: DevicePublicKey,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceKeyEnvelope {
    pub device_id: String,
    pub envelope: RoomKeyEnvelope,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredDevice {
    pub device_id: String,
    pub public_key: DevicePublicKey,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicesResponse {
    pub devices: Vec<RegisteredDevice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterDeviceInput {
    pub device_id: String,
    pub public_key: DevicePublicKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRoomInput {
    pub room_id: String,
    pub device_keys: Vec<DeviceKeyEnvelope>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoomResponse {
    pub room_id: String,
    pub member_id: String,
    pub key_epoch: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InvitedRoomRole {
    Controller,
    Viewer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddRoomMemberInput {
    pub room_id: String,
    pub subject: String,
    pub role: InvitedRoomRole,
    pub device_keys: Vec<DeviceKeyEnvelope>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRoomMemberResponse {
    pub member_id: String,
    pub key_epoch: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MintCapabilityResponse {
    pub capability_id: String,
    pub secret: String,
    pub key_epoch: i64,
    pub expires_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfJoinResponse {
    pub member_id: String,
    pub role: String,
    pub key_epoch: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomDeviceInput {
    pub room_id: String,
    pub device_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDetailsResponse {
    pub room_id: String,
    pub member_id: String,
    pub role: String,
    pub key_epoch: u64,
    pub key_envelope: RoomKeyEnvelope,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeTicketResponse {
    pub ticket: String,
    pub expires_in: u64,
    pub realtime_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotateRoomKeyInput {
    pub room_id: String,
    pub key_epoch: u64,
    pub device_keys: Vec<DeviceKeyEnvelope>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomInput {
    pub room_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResponse {
    pub data_base64: String,
    pub content_type: String,
    pub etag: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutSnapshotInput {
    pub room_id: String,
    pub data_base64: String,
    pub expected_etag: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PutSnapshotResponse {
    pub etag: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStartResponse {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
    pub expires_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPollResponse {
    pub status: AuthPollStatus,
    pub retry_after_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthPollStatus {
    Pending,
    Complete,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusResponse {
    pub status: AuthStatus,
    pub server_url: String,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthStatus {
    SignedOut,
    Pending,
    SignedIn,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollaborationInvite {
    pub version: u8,
    pub server_url: String,
    pub subject: String,
    pub devices: Vec<RegisteredDevice>,
    pub issued_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInviteResponse {
    pub token: String,
    pub invite: CollaborationInvite,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParseInviteInput {
    pub token: String,
}

#[derive(Clone)]
struct PendingAuthorization {
    server_url: String,
    client_id: String,
    token_endpoint: String,
    issuer: String,
    audience: String,
    device_code: Zeroizing<String>,
    interval: u64,
    next_poll_at: i64,
    expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSession {
    server_url: String,
    client_id: String,
    token_endpoint: String,
    issuer: String,
    audience: String,
    subject: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientConfigResponse {
    issuer: String,
    audience: String,
    client_id: String,
    device_authorization_endpoint: String,
    token_endpoint: String,
}

#[derive(Debug, Deserialize)]
struct DeviceAuthorizationResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: u64,
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    token_type: String,
}

#[derive(Debug, Deserialize)]
struct OAuthErrorResponse {
    error: String,
}

#[derive(Debug, Deserialize)]
struct DevicesWireResponse {
    devices: Vec<RegisteredDevice>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TicketWireResponse {
    ticket: String,
    expires_in: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MintCapabilityRequest<'a> {
    role: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    ttl_seconds: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelfJoinRequest<'a> {
    secret: &'a str,
    device_id: &'a str,
    key_envelope: &'a serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct ServerErrorResponse {
    error: String,
}

pub async fn get_config(pool: &SqlitePool) -> CollaborationResult<CollaborationConfig> {
    Ok(CollaborationConfig {
        server_url: load_server_url(pool).await?,
    })
}

pub async fn set_server_url(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    input: SetServerUrlInput,
) -> CollaborationResult<CollaborationConfig> {
    let server_url = normalize_server_url(&input.server_url)?;
    sqlx::query(
        "UPDATE collaboration_state SET server_url = ?1, updated_at = unixepoch() WHERE id = 1",
    )
    .bind(&server_url)
    .execute(pool)
    .await
    .map_err(|_| CollaborationError::storage("could not save collaboration configuration"))?;
    *runtime.pending_auth.lock().unwrap() = None;
    Ok(CollaborationConfig { server_url })
}

pub async fn get_device_identity(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
) -> CollaborationResult<Option<DeviceIdentity>> {
    let row =
        sqlx::query("SELECT device_id, device_public_key FROM collaboration_state WHERE id = 1")
            .fetch_one(pool)
            .await
            .map_err(|_| {
                CollaborationError::storage("could not load collaboration device identity")
            })?;
    let device_id: Option<String> = row.get("device_id");
    let public_key: Option<String> = row.get("device_public_key");
    let (Some(device_id), Some(public_key)) = (device_id, public_key) else {
        return Ok(None);
    };
    let public_key = serde_json::from_str(&public_key)
        .map_err(|_| CollaborationError::storage("stored collaboration public key is invalid"))?;
    let private_key = secret_get(pool, keystore_state, PRIVATE_KEY_SECRET_ID)
        .await?
        .ok_or_else(|| {
            CollaborationError::storage("stored collaboration private key is unavailable")
        })?;
    let private_key = serde_json::from_str(&private_key)
        .map_err(|_| CollaborationError::storage("stored collaboration private key is invalid"))?;
    Ok(Some(DeviceIdentity {
        device_id,
        public_key,
        private_key,
    }))
}

pub async fn set_device_identity(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    input: SetDeviceIdentityInput,
) -> CollaborationResult<()> {
    let identity = DeviceIdentity {
        device_id: input.device_id,
        public_key: input.public_key,
        private_key: input.private_key,
    };
    validate_device_identity(&identity)?;
    let public_key = serde_json::to_string(&identity.public_key)
        .map_err(|_| CollaborationError::invalid("device public key is invalid"))?;
    let private_key = serde_json::to_string(&identity.private_key)
        .map_err(|_| CollaborationError::invalid("device private key is invalid"))?;

    secret_set(pool, keystore_state, PRIVATE_KEY_SECRET_ID, &private_key).await?;
    sqlx::query(
        "UPDATE collaboration_state
         SET device_id = ?1, device_public_key = ?2, updated_at = unixepoch()
         WHERE id = 1",
    )
    .bind(&identity.device_id)
    .bind(public_key)
    .execute(pool)
    .await
    .map_err(|_| CollaborationError::storage("could not save collaboration device identity"))?;
    Ok(())
}

pub async fn auth_start(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
) -> CollaborationResult<AuthStartResponse> {
    let server_url = load_server_url(pool).await?;
    let config = fetch_client_config(&server_url).await?;
    validate_external_https_url(&config.issuer, "identity issuer")?;
    validate_external_https_url(
        &config.device_authorization_endpoint,
        "device authorization endpoint",
    )?;
    validate_external_https_url(&config.token_endpoint, "token endpoint")?;
    validate_nonempty(&config.audience, 2048, "OIDC audience")?;
    validate_nonempty(&config.client_id, 512, "OIDC client id")?;

    let response = http_client()?
        .post(&config.device_authorization_endpoint)
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("scope", "openid profile offline_access"),
            ("audience", config.audience.as_str()),
        ])
        .send()
        .await
        .map_err(|_| {
            CollaborationError::new(
                CollaborationErrorCode::Network,
                "identity provider could not be reached",
            )
        })?;
    if !response.status().is_success() {
        return Err(CollaborationError::with_status(
            CollaborationErrorCode::AuthDenied,
            "identity provider rejected the login request",
            response.status(),
        ));
    }
    let authorization: DeviceAuthorizationResponse = read_json(
        response,
        MAX_AUTH_RESPONSE_BYTES,
        "identity provider returned an invalid login response",
    )
    .await?;
    validate_nonempty(&authorization.device_code, 16 * 1024, "device code")?;
    validate_nonempty(&authorization.user_code, 512, "user code")?;
    validate_external_https_url(&authorization.verification_uri, "verification URI")?;
    if let Some(uri) = &authorization.verification_uri_complete {
        validate_external_https_url(uri, "complete verification URI")?;
    }
    if authorization.expires_in == 0 {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "identity provider returned an invalid authorization lifetime",
        ));
    }
    let interval = authorization.interval.unwrap_or(5).clamp(1, 60);
    let now = Utc::now().timestamp();
    let expires_at = now.saturating_add(authorization.expires_in.min(i64::MAX as u64) as i64);
    *runtime.pending_auth.lock().unwrap() = Some(PendingAuthorization {
        server_url,
        client_id: config.client_id,
        token_endpoint: config.token_endpoint,
        issuer: config.issuer,
        audience: config.audience,
        device_code: Zeroizing::new(authorization.device_code),
        interval,
        next_poll_at: now.saturating_add(interval as i64),
        expires_at,
    });
    Ok(AuthStartResponse {
        user_code: authorization.user_code,
        verification_uri: authorization.verification_uri,
        verification_uri_complete: authorization.verification_uri_complete,
        expires_in: authorization.expires_in,
        interval,
        expires_at,
    })
}

pub async fn auth_poll(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
) -> CollaborationResult<AuthPollResponse> {
    let pending = runtime
        .pending_auth
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| CollaborationError::invalid("there is no pending collaboration login"))?;
    let current_server = load_server_url(pool).await?;
    if pending.server_url != current_server {
        *runtime.pending_auth.lock().unwrap() = None;
        return Err(CollaborationError::invalid(
            "collaboration server changed while login was pending",
        ));
    }
    let now = Utc::now().timestamp();
    if now >= pending.expires_at {
        *runtime.pending_auth.lock().unwrap() = None;
        return Err(CollaborationError::new(
            CollaborationErrorCode::AuthExpired,
            "collaboration login expired; try again",
        ));
    }
    if now < pending.next_poll_at {
        return Ok(AuthPollResponse {
            status: AuthPollStatus::Pending,
            retry_after_seconds: Some((pending.next_poll_at - now) as u64),
        });
    }

    let response = http_client()?
        .post(&pending.token_endpoint)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("device_code", pending.device_code.as_str()),
            ("client_id", pending.client_id.as_str()),
        ])
        .send()
        .await
        .map_err(|_| {
            CollaborationError::new(
                CollaborationErrorCode::Network,
                "identity provider could not be reached",
            )
        })?;
    if response.status().is_success() {
        let token: OAuthTokenResponse = read_json(
            response,
            MAX_AUTH_RESPONSE_BYTES,
            "identity provider returned an invalid token",
        )
        .await?;
        validate_oauth_token(&token)?;
        let subject = subject_from_access_token(&token.access_token)?;
        let config = fetch_client_config(&pending.server_url).await?;
        if config.client_id != pending.client_id
            || config.token_endpoint != pending.token_endpoint
            || config.issuer != pending.issuer
            || config.audience != pending.audience
        {
            *runtime.pending_auth.lock().unwrap() = None;
            return Err(CollaborationError::new(
                CollaborationErrorCode::InvalidResponse,
                "collaboration login configuration changed during authorization",
            ));
        }
        let session = StoredSession {
            server_url: pending.server_url,
            client_id: config.client_id,
            token_endpoint: config.token_endpoint,
            issuer: config.issuer,
            audience: config.audience,
            subject,
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: now.saturating_add(token.expires_in.min(i64::MAX as u64) as i64),
        };
        save_session(pool, keystore_state, &session).await?;
        *runtime.pending_auth.lock().unwrap() = None;
        return Ok(AuthPollResponse {
            status: AuthPollStatus::Complete,
            retry_after_seconds: None,
        });
    }

    let status = response.status();
    let error: OAuthErrorResponse = read_json(
        response,
        MAX_AUTH_RESPONSE_BYTES,
        "identity provider rejected the login request",
    )
    .await?;
    match error.error.as_str() {
        "authorization_pending" => {
            let next = now.saturating_add(pending.interval as i64);
            if let Some(active) = runtime.pending_auth.lock().unwrap().as_mut() {
                active.next_poll_at = next;
            }
            Ok(AuthPollResponse {
                status: AuthPollStatus::Pending,
                retry_after_seconds: Some(pending.interval),
            })
        }
        "slow_down" => {
            let interval = pending.interval.saturating_add(5).min(60);
            if let Some(active) = runtime.pending_auth.lock().unwrap().as_mut() {
                active.interval = interval;
                active.next_poll_at = now.saturating_add(interval as i64);
            }
            Ok(AuthPollResponse {
                status: AuthPollStatus::Pending,
                retry_after_seconds: Some(interval),
            })
        }
        "access_denied" => {
            *runtime.pending_auth.lock().unwrap() = None;
            Err(CollaborationError::with_status(
                CollaborationErrorCode::AuthDenied,
                "collaboration login was denied",
                status,
            ))
        }
        "expired_token" => {
            *runtime.pending_auth.lock().unwrap() = None;
            Err(CollaborationError::with_status(
                CollaborationErrorCode::AuthExpired,
                "collaboration login expired; try again",
                status,
            ))
        }
        _ => Err(CollaborationError::with_status(
            CollaborationErrorCode::AuthDenied,
            "identity provider rejected the login request",
            status,
        )),
    }
}

pub async fn auth_status(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
) -> CollaborationResult<AuthStatusResponse> {
    let server_url = load_server_url(pool).await?;
    if let Some(pending) = runtime.pending_auth.lock().unwrap().as_ref() {
        if pending.server_url == server_url && pending.expires_at > Utc::now().timestamp() {
            return Ok(AuthStatusResponse {
                status: AuthStatus::Pending,
                server_url,
                expires_at: Some(pending.expires_at),
            });
        }
    }
    let Some(session) = load_session(pool, keystore_state).await? else {
        return Ok(AuthStatusResponse {
            status: AuthStatus::SignedOut,
            server_url,
            expires_at: None,
        });
    };
    if session.server_url != server_url {
        return Ok(AuthStatusResponse {
            status: AuthStatus::SignedOut,
            server_url,
            expires_at: None,
        });
    }
    let expired = session.expires_at <= Utc::now().timestamp() && session.refresh_token.is_none();
    Ok(AuthStatusResponse {
        status: if expired {
            AuthStatus::Expired
        } else {
            AuthStatus::SignedIn
        },
        server_url,
        expires_at: Some(session.expires_at),
    })
}

pub async fn auth_sign_out(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
) -> CollaborationResult<()> {
    secret_delete(pool, keystore_state, SESSION_SECRET_ID).await?;
    *runtime.pending_auth.lock().unwrap() = None;
    Ok(())
}

pub async fn register_device(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    input: RegisterDeviceInput,
) -> CollaborationResult<()> {
    validate_uuid(&input.device_id, "deviceId")?;
    validate_device_public_key(&input.public_key)?;
    let response =
        authenticated_request(pool, runtime, keystore_state, Method::POST, "/v1/devices")
            .await?
            .json(&input)
            .send()
            .await
            .map_err(network_error)?;
    expect_empty_success(response).await
}

pub async fn list_devices(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
) -> CollaborationResult<DevicesResponse> {
    let response = authenticated_request(pool, runtime, keystore_state, Method::GET, "/v1/devices")
        .await?
        .send()
        .await
        .map_err(network_error)?;
    let response: DevicesWireResponse = read_server_json(response).await?;
    validate_registered_devices(&response.devices)?;
    Ok(DevicesResponse {
        devices: response.devices,
    })
}

pub async fn create_room(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    input: CreateRoomInput,
) -> CollaborationResult<CreateRoomResponse> {
    validate_uuid(&input.room_id, "roomId")?;
    validate_device_keys(&input.device_keys, &input.room_id, Some(1))?;
    let response = authenticated_request(pool, runtime, keystore_state, Method::POST, "/v1/rooms")
        .await?
        .json(&input)
        .send()
        .await
        .map_err(network_error)?;
    let room: CreateRoomResponse = read_server_json(response).await?;
    validate_uuid(&room.room_id, "roomId")?;
    validate_uuid(&room.member_id, "memberId")?;
    if room.room_id != input.room_id || room.key_epoch != 1 {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "collaboration server returned inconsistent room metadata",
        ));
    }
    Ok(room)
}

pub async fn add_room_member(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    input: AddRoomMemberInput,
) -> CollaborationResult<AddRoomMemberResponse> {
    validate_uuid(&input.room_id, "roomId")?;
    validate_subject(&input.subject)?;
    validate_device_keys(&input.device_keys, &input.room_id, None)?;
    let path = format!("/v1/rooms/{}/members", input.room_id);
    let response = authenticated_request(pool, runtime, keystore_state, Method::POST, &path)
        .await?
        .json(&serde_json::json!({
            "subject": input.subject,
            "role": input.role,
            "deviceKeys": input.device_keys,
        }))
        .send()
        .await
        .map_err(network_error)?;
    let member: AddRoomMemberResponse = read_server_json(response).await?;
    validate_uuid(&member.member_id, "memberId")?;
    if member.key_epoch == 0 {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "collaboration server returned an invalid key epoch",
        ));
    }
    Ok(member)
}

pub async fn mint_room_capability(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    room_id: &str,
    role: &str,
    ttl_seconds: Option<u32>,
) -> CollaborationResult<MintCapabilityResponse> {
    validate_uuid(room_id, "roomId")?;
    validate_capability_role(role)?;
    let path = format!("/v1/rooms/{room_id}/capabilities");
    let response = authenticated_request(pool, runtime, keystore_state, Method::POST, &path)
        .await?
        .json(&MintCapabilityRequest { role, ttl_seconds })
        .send()
        .await
        .map_err(network_error)?;
    read_server_json(response).await
}

pub async fn join_room_with_capability(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    room_id: &str,
    secret: &str,
    device_id: &str,
    key_envelope: serde_json::Value,
) -> CollaborationResult<SelfJoinResponse> {
    validate_uuid(room_id, "roomId")?;
    validate_uuid(device_id, "deviceId")?;
    let path = format!("/v1/rooms/{room_id}/join");
    let response = authenticated_request(pool, runtime, keystore_state, Method::POST, &path)
        .await?
        .json(&SelfJoinRequest {
            secret,
            device_id,
            key_envelope: &key_envelope,
        })
        .send()
        .await
        .map_err(network_error)?;
    read_server_json(response).await
}

pub async fn get_room(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    input: RoomDeviceInput,
) -> CollaborationResult<RoomDetailsResponse> {
    validate_uuid(&input.room_id, "roomId")?;
    validate_uuid(&input.device_id, "deviceId")?;
    let path = format!("/v1/rooms/{}", input.room_id);
    let response = authenticated_request(pool, runtime, keystore_state, Method::GET, &path)
        .await?
        .query(&[("deviceId", &input.device_id)])
        .send()
        .await
        .map_err(network_error)?;
    let details: RoomDetailsResponse = read_server_json(response).await?;
    validate_uuid(&details.room_id, "roomId")?;
    validate_uuid(&details.member_id, "memberId")?;
    validate_room_role(&details.role)?;
    validate_room_key_envelope(&details.key_envelope)?;
    if details.room_id != input.room_id
        || details.key_epoch == 0
        || details.key_envelope.room_id != details.room_id
        || details.key_envelope.key_epoch != details.key_epoch
        || details.key_envelope.recipient_device_id != input.device_id
    {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "collaboration server returned inconsistent room key metadata",
        ));
    }
    Ok(details)
}

pub async fn issue_realtime_ticket(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    input: RoomDeviceInput,
) -> CollaborationResult<RealtimeTicketResponse> {
    validate_uuid(&input.room_id, "roomId")?;
    validate_uuid(&input.device_id, "deviceId")?;
    let path = format!("/v1/rooms/{}/realtime-ticket", input.room_id);
    let response = authenticated_request(pool, runtime, keystore_state, Method::POST, &path)
        .await?
        .json(&serde_json::json!({ "deviceId": input.device_id }))
        .send()
        .await
        .map_err(network_error)?;
    let ticket: TicketWireResponse = read_server_json(response).await?;
    validate_identifier(&ticket.ticket, 128, "realtime ticket")?;
    if ticket.expires_in == 0 {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "collaboration server returned an invalid ticket lifetime",
        ));
    }
    let server_url = load_server_url(pool).await?;
    let realtime_url = build_realtime_url(&server_url, &ticket.ticket)?;
    Ok(RealtimeTicketResponse {
        ticket: ticket.ticket,
        expires_in: ticket.expires_in,
        realtime_url,
    })
}

pub async fn rotate_room_key(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    input: RotateRoomKeyInput,
) -> CollaborationResult<()> {
    validate_uuid(&input.room_id, "roomId")?;
    if input.key_epoch < 2 {
        return Err(CollaborationError::invalid(
            "keyEpoch must be an integer greater than one",
        ));
    }
    validate_device_keys(&input.device_keys, &input.room_id, Some(input.key_epoch))?;
    let path = format!("/v1/rooms/{}/key-epoch", input.room_id);
    let response = authenticated_request(pool, runtime, keystore_state, Method::PUT, &path)
        .await?
        .json(&serde_json::json!({
            "keyEpoch": input.key_epoch,
            "deviceKeys": input.device_keys,
        }))
        .send()
        .await
        .map_err(network_error)?;
    expect_empty_success(response).await
}

pub async fn get_snapshot(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    input: RoomInput,
) -> CollaborationResult<SnapshotResponse> {
    validate_uuid(&input.room_id, "roomId")?;
    let path = format!("/v1/rooms/{}/snapshot", input.room_id);
    let response = authenticated_request(pool, runtime, keystore_state, Method::GET, &path)
        .await?
        .send()
        .await
        .map_err(network_error)?;
    if !response.status().is_success() {
        return Err(server_error(response).await);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SNAPSHOT_BYTES as u64)
    {
        return Err(CollaborationError::new(
            CollaborationErrorCode::PayloadTooLarge,
            "collaboration snapshot exceeds the size limit",
        ));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or(SNAPSHOT_CONTENT_TYPE)
        .to_string();
    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response.bytes().await.map_err(network_error)?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(CollaborationError::new(
            CollaborationErrorCode::PayloadTooLarge,
            "collaboration snapshot exceeds the size limit",
        ));
    }
    Ok(SnapshotResponse {
        data_base64: STANDARD.encode(bytes),
        content_type,
        etag,
    })
}

pub async fn put_snapshot(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    input: PutSnapshotInput,
) -> CollaborationResult<PutSnapshotResponse> {
    validate_uuid(&input.room_id, "roomId")?;
    if input.data_base64.len() > MAX_SNAPSHOT_BYTES.div_ceil(3) * 4 + 4 {
        return Err(CollaborationError::invalid(
            "collaboration snapshot exceeds the size limit",
        ));
    }
    let bytes = STANDARD
        .decode(&input.data_base64)
        .map_err(|_| CollaborationError::invalid("dataBase64 is not valid base64"))?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(CollaborationError::invalid(
            "collaboration snapshot exceeds the size limit",
        ));
    }
    let path = format!("/v1/rooms/{}/snapshot", input.room_id);
    let mut request = authenticated_request(pool, runtime, keystore_state, Method::PUT, &path)
        .await?
        .header(CONTENT_TYPE, SNAPSHOT_CONTENT_TYPE)
        .body(bytes);
    request = match input.expected_etag.as_deref() {
        Some(etag) => {
            validate_etag(etag)?;
            request.header(IF_MATCH, etag)
        }
        None => request.header(IF_NONE_MATCH, "*"),
    };
    let response = request.send().await.map_err(network_error)?;
    if !response.status().is_success() {
        return Err(server_error(response).await);
    }
    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    Ok(PutSnapshotResponse { etag })
}

pub async fn create_invite(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
) -> CollaborationResult<CreateInviteResponse> {
    let server_url = load_server_url(pool).await?;
    let session = ensure_account_session(pool, runtime, keystore_state).await?;
    let current_device: Option<String> =
        sqlx::query_scalar("SELECT device_id FROM collaboration_state WHERE id = 1")
            .fetch_one(pool)
            .await
            .map_err(|_| {
                CollaborationError::storage("could not load collaboration device identity")
            })?;
    let current_device = current_device.ok_or_else(|| {
        CollaborationError::invalid("set a device identity before creating an invite")
    })?;
    let devices = list_devices(pool, runtime, keystore_state).await?.devices;
    if !devices
        .iter()
        .any(|device| device.device_id == current_device)
    {
        return Err(CollaborationError::invalid(
            "register this device before creating an invite",
        ));
    }
    let invite = CollaborationInvite {
        version: 1,
        server_url,
        subject: session.subject,
        devices,
        issued_at: Utc::now().timestamp(),
    };
    validate_invite(&invite)?;
    let encoded = serde_json::to_vec(&invite)
        .map_err(|_| CollaborationError::invalid("could not serialize collaboration invite"))?;
    let token = format!("{INVITE_PREFIX}{}", URL_SAFE_NO_PAD.encode(encoded));
    Ok(CreateInviteResponse { token, invite })
}

pub fn parse_invite(input: ParseInviteInput) -> CollaborationResult<CollaborationInvite> {
    if input.token.len() > 128 * 1024 {
        return Err(CollaborationError::invalid(
            "collaboration invite is too large",
        ));
    }
    let encoded = input
        .token
        .strip_prefix(INVITE_PREFIX)
        .ok_or_else(|| CollaborationError::invalid("collaboration invite format is unsupported"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| CollaborationError::invalid("collaboration invite is invalid"))?;
    let invite: CollaborationInvite = serde_json::from_slice(&bytes)
        .map_err(|_| CollaborationError::invalid("collaboration invite is invalid"))?;
    validate_invite(&invite)?;
    Ok(invite)
}

async fn load_server_url(pool: &SqlitePool) -> CollaborationResult<String> {
    let value: String =
        sqlx::query_scalar("SELECT server_url FROM collaboration_state WHERE id = 1")
            .fetch_one(pool)
            .await
            .map_err(|_| {
                CollaborationError::storage("could not load collaboration configuration")
            })?;
    normalize_server_url(&value)
        .map_err(|_| CollaborationError::storage("stored collaboration server URL is invalid"))
}

fn normalize_server_url(value: &str) -> CollaborationResult<String> {
    let trimmed = value.trim().trim_end_matches('/');
    let url = Url::parse(trimmed)
        .map_err(|_| CollaborationError::invalid("collaboration server URL is invalid"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || (url.path() != "" && url.path() != "/")
    {
        return Err(CollaborationError::invalid(
            "collaboration server URL must be an HTTPS origin without credentials, path, query, or fragment",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn validate_external_https_url(value: &str, label: &str) -> CollaborationResult<()> {
    let url = Url::parse(value).map_err(|_| {
        CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            format!("{label} is invalid"),
        )
    })?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            format!("{label} must use HTTPS without embedded credentials or a fragment"),
        ));
    }
    Ok(())
}

async fn fetch_client_config(server_url: &str) -> CollaborationResult<ClientConfigResponse> {
    let response = http_client()?
        .get(format!("{server_url}/v1/client-config"))
        .send()
        .await
        .map_err(network_error)?;
    if !response.status().is_success() {
        return Err(server_error(response).await);
    }
    read_json(
        response,
        MAX_AUTH_RESPONSE_BYTES,
        "collaboration server returned invalid client configuration",
    )
    .await
}

async fn authenticated_request(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
    method: Method,
    path: &str,
) -> CollaborationResult<reqwest::RequestBuilder> {
    let server_url = load_server_url(pool).await?;
    let session = ensure_account_session(pool, runtime, keystore_state).await?;
    Ok(http_client()?
        .request(method, format!("{server_url}{path}"))
        .bearer_auth(session.access_token))
}

/// Return a fresh access token for the signed-in Luma account, refreshing it if
/// needed. The token is audience-bound (`luma-api`), so it is valid for both the
/// collaboration server and Luma Cloud sync — this is the single sign-in shared
/// by both features.
pub async fn account_access_token(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
) -> CollaborationResult<String> {
    let session = ensure_account_session(pool, runtime, keystore_state).await?;
    Ok(session.access_token)
}

/// Network-free check that a usable account session exists (valid or refreshable).
pub async fn account_is_signed_in(pool: &SqlitePool, keystore_state: &KeystoreState) -> bool {
    match load_session(pool, keystore_state).await {
        Ok(Some(session)) => {
            session.expires_at > Utc::now().timestamp() || session.refresh_token.is_some()
        }
        _ => false,
    }
}

async fn ensure_account_session(
    pool: &SqlitePool,
    runtime: &CollaborationRuntimeState,
    keystore_state: &KeystoreState,
) -> CollaborationResult<StoredSession> {
    let _guard = runtime.refresh_lock.lock().await;
    let mut session = load_session(pool, keystore_state).await?.ok_or_else(|| {
        CollaborationError::new(
            CollaborationErrorCode::AuthRequired,
            "sign in to your Luma account before continuing",
        )
    })?;
    let now = Utc::now().timestamp();
    if session.expires_at > now.saturating_add(60) {
        return Ok(session);
    }
    let refresh_token = session.refresh_token.as_deref().ok_or_else(|| {
        CollaborationError::new(
            CollaborationErrorCode::AuthExpired,
            "your Luma account session expired; sign in again",
        )
    })?;
    // Refresh against the identity provider discovered from the server the
    // account signed in through.
    let discovery_url = session.server_url.clone();
    let config = fetch_client_config(&discovery_url).await?;
    validate_external_https_url(&config.token_endpoint, "token endpoint")?;
    if config.client_id != session.client_id
        || config.issuer != session.issuer
        || config.audience != session.audience
    {
        return Err(CollaborationError::new(
            CollaborationErrorCode::AuthExpired,
            "collaboration identity configuration changed; sign in again",
        ));
    }
    let response = http_client()?
        .post(&config.token_endpoint)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", config.client_id.as_str()),
            ("scope", "openid profile offline_access"),
        ])
        .send()
        .await
        .map_err(|_| {
            CollaborationError::new(
                CollaborationErrorCode::Network,
                "identity provider could not be reached",
            )
        })?;
    if !response.status().is_success() {
        return Err(CollaborationError::with_status(
            CollaborationErrorCode::AuthExpired,
            "collaboration session could not be refreshed; sign in again",
            response.status(),
        ));
    }
    let token: OAuthTokenResponse = read_json(
        response,
        MAX_AUTH_RESPONSE_BYTES,
        "identity provider returned an invalid token",
    )
    .await?;
    validate_oauth_token(&token)?;
    let subject = subject_from_access_token(&token.access_token)?;
    if subject != session.subject {
        return Err(CollaborationError::new(
            CollaborationErrorCode::AuthExpired,
            "refreshed collaboration session belongs to a different account",
        ));
    }
    session.access_token = token.access_token;
    if token.refresh_token.is_some() {
        session.refresh_token = token.refresh_token;
    }
    session.token_endpoint = config.token_endpoint;
    session.expires_at = now.saturating_add(token.expires_in.min(i64::MAX as u64) as i64);
    save_session(pool, keystore_state, &session).await?;
    Ok(session)
}

fn http_client() -> CollaborationResult<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| {
            CollaborationError::new(
                CollaborationErrorCode::Network,
                "could not initialize collaboration networking",
            )
        })
}

async fn expect_empty_success(response: Response) -> CollaborationResult<()> {
    if response.status().is_success() {
        Ok(())
    } else {
        Err(server_error(response).await)
    }
}

async fn read_server_json<T: DeserializeOwned>(response: Response) -> CollaborationResult<T> {
    if !response.status().is_success() {
        return Err(server_error(response).await);
    }
    read_json(
        response,
        MAX_JSON_RESPONSE_BYTES,
        "collaboration server returned an invalid response",
    )
    .await
}

async fn read_json<T: DeserializeOwned>(
    response: Response,
    max_bytes: usize,
    invalid_message: &str,
) -> CollaborationResult<T> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "remote response exceeds the size limit",
        ));
    }
    let bytes = response.bytes().await.map_err(network_error)?;
    if bytes.len() > max_bytes {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "remote response exceeds the size limit",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        CollaborationError::new(CollaborationErrorCode::InvalidResponse, invalid_message)
    })
}

async fn server_error(response: Response) -> CollaborationError {
    let status = response.status();
    let message = if response
        .content_length()
        .is_some_and(|length| length > MAX_AUTH_RESPONSE_BYTES as u64)
    {
        None
    } else {
        response
            .bytes()
            .await
            .ok()
            .filter(|bytes| bytes.len() <= MAX_AUTH_RESPONSE_BYTES)
            .and_then(|bytes| serde_json::from_slice::<ServerErrorResponse>(&bytes).ok())
            .map(|body| body.error)
            .filter(|message| !message.is_empty() && message.len() <= 1024)
    };
    map_http_error(status, message)
}

fn map_http_error(status: StatusCode, server_message: Option<String>) -> CollaborationError {
    let (code, fallback) = match status {
        StatusCode::BAD_REQUEST => (
            CollaborationErrorCode::InvalidInput,
            "collaboration request was invalid",
        ),
        StatusCode::UNAUTHORIZED => (
            CollaborationErrorCode::AuthRequired,
            "collaboration session was rejected; sign in again",
        ),
        StatusCode::FORBIDDEN => (
            CollaborationErrorCode::Forbidden,
            "collaboration action is not permitted",
        ),
        StatusCode::NOT_FOUND => (
            CollaborationErrorCode::NotFound,
            "collaboration resource was not found",
        ),
        StatusCode::CONFLICT => (
            CollaborationErrorCode::Conflict,
            "collaboration resource conflicts with existing state",
        ),
        StatusCode::PRECONDITION_FAILED => (
            CollaborationErrorCode::PreconditionFailed,
            "collaboration resource changed since it was read",
        ),
        StatusCode::PAYLOAD_TOO_LARGE => (
            CollaborationErrorCode::PayloadTooLarge,
            "collaboration payload exceeds the size limit",
        ),
        StatusCode::UNSUPPORTED_MEDIA_TYPE => (
            CollaborationErrorCode::UnsupportedMediaType,
            "collaboration payload type is unsupported",
        ),
        StatusCode::PRECONDITION_REQUIRED => (
            CollaborationErrorCode::PreconditionRequired,
            "collaboration update requires a current version",
        ),
        StatusCode::TOO_MANY_REQUESTS => (
            CollaborationErrorCode::RateLimited,
            "collaboration request rate limit was exceeded",
        ),
        status if status.is_server_error() => (
            CollaborationErrorCode::ServerUnavailable,
            "collaboration server is unavailable",
        ),
        _ => (
            CollaborationErrorCode::ServerUnavailable,
            "collaboration server rejected the request",
        ),
    };
    CollaborationError::with_status(
        code,
        server_message.unwrap_or_else(|| fallback.into()),
        status,
    )
}

fn network_error(_: reqwest::Error) -> CollaborationError {
    CollaborationError::new(
        CollaborationErrorCode::Network,
        "collaboration service could not be reached",
    )
}

fn validate_oauth_token(token: &OAuthTokenResponse) -> CollaborationResult<()> {
    if token.access_token.is_empty()
        || token.access_token.len() > 128 * 1024
        || token.expires_in == 0
        || !token.token_type.eq_ignore_ascii_case("bearer")
        || token
            .refresh_token
            .as_ref()
            .is_some_and(|value| value.len() > 128 * 1024)
    {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "identity provider returned an incomplete token",
        ));
    }
    Ok(())
}

fn subject_from_access_token(access_token: &str) -> CollaborationResult<String> {
    #[derive(Deserialize)]
    struct Claims {
        sub: String,
    }
    let mut parts = access_token.split('.');
    let _header = parts.next();
    let payload = parts.next().ok_or_else(|| {
        CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "identity provider access token does not expose a subject",
        )
    })?;
    if parts.next().is_none() || parts.next().is_some() || payload.len() > 64 * 1024 {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "identity provider access token is invalid",
        ));
    }
    let bytes = decode_base64url(payload, None, "access token payload")?;
    let claims: Claims = serde_json::from_slice(&bytes).map_err(|_| {
        CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "identity provider access token has invalid claims",
        )
    })?;
    validate_subject(&claims.sub)?;
    Ok(claims.sub)
}

async fn save_session(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    session: &StoredSession,
) -> CollaborationResult<()> {
    let encoded = serde_json::to_string(session)
        .map_err(|_| CollaborationError::storage("could not serialize collaboration session"))?;
    secret_set(pool, keystore_state, SESSION_SECRET_ID, &encoded).await
}

async fn load_session(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
) -> CollaborationResult<Option<StoredSession>> {
    let Some(encoded) = secret_get(pool, keystore_state, SESSION_SECRET_ID).await? else {
        return Ok(None);
    };
    serde_json::from_str(&encoded)
        .map(Some)
        .map_err(|_| CollaborationError::storage("stored collaboration session is invalid"))
}

async fn secret_set(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    id: &str,
    secret: &str,
) -> CollaborationResult<()> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (pool, keystore_state);
        keychain_set(id, secret)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        keystore::store(pool, keystore_state, KEYSTORE_OWNER, id, "secret", secret)
            .await
            .map_err(|_| CollaborationError::storage("could not store collaboration secret"))
    }
}

async fn secret_get(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    id: &str,
) -> CollaborationResult<Option<Zeroizing<String>>> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (pool, keystore_state);
        keychain_get(id)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        keystore::load(pool, keystore_state, KEYSTORE_OWNER, id, "secret")
            .await
            .map(|value| value.map(Zeroizing::new))
            .map_err(|_| CollaborationError::storage("could not load collaboration secret"))
    }
}

async fn secret_delete(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    id: &str,
) -> CollaborationResult<()> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (pool, keystore_state);
        clear_keychain(id);
        Ok(())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = keystore_state;
        sqlx::query("DELETE FROM keystore_secrets WHERE owner_type = ?1 AND owner_id = ?2")
            .bind(KEYSTORE_OWNER)
            .bind(id)
            .execute(pool)
            .await
            .map_err(|_| CollaborationError::storage("could not delete collaboration secret"))?;
        Ok(())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn keychain_entry(id: &str) -> CollaborationResult<Entry> {
    Entry::new(KEYCHAIN_SERVICE, id)
        .map_err(|_| CollaborationError::storage("OS credential store is unavailable"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn keychain_set(id: &str, secret: &str) -> CollaborationResult<()> {
    let chunks = split_keychain_secret(secret);
    let previous_chunks = keychain_entry(id)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|value| keychain_chunk_count(&value));
    if chunks.len() == 1 {
        keychain_entry(id)?
            .set_password(secret)
            .map_err(|_| CollaborationError::storage("could not store collaboration secret"))?;
        if let Some(count) = previous_chunks {
            delete_keychain_chunks(id, count);
        }
        return Ok(());
    }
    if chunks.len() > KEYCHAIN_MAX_CHUNKS {
        return Err(CollaborationError::storage(
            "collaboration secret exceeds the credential store limit",
        ));
    }
    for (index, chunk) in chunks.iter().enumerate() {
        let chunk_id = format!("{id}:chunk:{index}");
        if keychain_entry(&chunk_id)
            .and_then(|entry| {
                entry.set_password(chunk).map_err(|_| {
                    CollaborationError::storage("could not store collaboration secret")
                })
            })
            .is_err()
        {
            delete_keychain_chunks(id, index + 1);
            return Err(CollaborationError::storage(
                "could not store collaboration secret",
            ));
        }
    }
    let manifest = format!("{KEYCHAIN_CHUNK_MANIFEST_PREFIX}{}", chunks.len());
    if keychain_entry(id)
        .and_then(|entry| {
            entry
                .set_password(&manifest)
                .map_err(|_| CollaborationError::storage("could not store collaboration secret"))
        })
        .is_err()
    {
        delete_keychain_chunks(id, chunks.len());
        return Err(CollaborationError::storage(
            "could not store collaboration secret",
        ));
    }
    if let Some(previous) = previous_chunks {
        for index in chunks.len()..previous {
            clear_keychain_entry(&format!("{id}:chunk:{index}"));
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn keychain_get(id: &str) -> CollaborationResult<Option<Zeroizing<String>>> {
    let Ok(entry) = keychain_entry(id) else {
        return Err(CollaborationError::storage(
            "OS credential store is unavailable",
        ));
    };
    let Ok(stored) = entry.get_password() else {
        return Ok(None);
    };
    let Some(count) = keychain_chunk_count(&stored) else {
        return Ok(Some(Zeroizing::new(stored)));
    };
    let mut secret = Zeroizing::new(String::new());
    for index in 0..count {
        let chunk = keychain_entry(&format!("{id}:chunk:{index}"))?
            .get_password()
            .map_err(|_| {
                CollaborationError::storage("stored collaboration secret is incomplete")
            })?;
        secret.push_str(&chunk);
    }
    Ok(Some(secret))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn clear_keychain(id: &str) {
    let chunks = keychain_entry(id)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|value| keychain_chunk_count(&value));
    if let Some(count) = chunks {
        delete_keychain_chunks(id, count);
    }
    clear_keychain_entry(id);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn split_keychain_secret(secret: &str) -> Vec<Zeroizing<String>> {
    let mut chunks = Vec::new();
    let mut chunk = String::new();
    let mut utf16_units = 0;
    for character in secret.chars() {
        let units = character.len_utf16();
        if utf16_units + units > KEYCHAIN_CHUNK_UTF16_LIMIT && !chunk.is_empty() {
            chunks.push(Zeroizing::new(std::mem::take(&mut chunk)));
            utf16_units = 0;
        }
        chunk.push(character);
        utf16_units += units;
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
fn delete_keychain_chunks(id: &str, count: usize) {
    for index in 0..count.min(KEYCHAIN_MAX_CHUNKS) {
        clear_keychain_entry(&format!("{id}:chunk:{index}"));
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn clear_keychain_entry(id: &str) {
    if let Ok(entry) = Entry::new(KEYCHAIN_SERVICE, id) {
        let _ = entry.delete_credential();
    }
}

fn validate_device_identity(identity: &DeviceIdentity) -> CollaborationResult<()> {
    validate_uuid(&identity.device_id, "deviceId")?;
    validate_device_public_key(&identity.public_key)?;
    if identity.private_key.algorithm != "ECDH-P256" {
        return Err(CollaborationError::invalid(
            "unsupported device private key algorithm",
        ));
    }
    let pkcs8 = decode_base64url(&identity.private_key.pkcs8, None, "device private key")?;
    if pkcs8.is_empty() || pkcs8.len() > 16 * 1024 {
        return Err(CollaborationError::invalid(
            "device private key has an invalid length",
        ));
    }
    Ok(())
}

fn validate_registered_devices(devices: &[RegisteredDevice]) -> CollaborationResult<()> {
    if devices.len() > 32 {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "collaboration server returned too many devices",
        ));
    }
    for device in devices {
        validate_uuid(&device.device_id, "deviceId")?;
        validate_device_public_key(&device.public_key)?;
    }
    Ok(())
}

fn validate_device_public_key(key: &DevicePublicKey) -> CollaborationResult<()> {
    if key.algorithm != "ECDH-P256" {
        return Err(CollaborationError::invalid(
            "unsupported device public key algorithm",
        ));
    }
    decode_base64url(&key.x, Some(32), "device public key x-coordinate")?;
    decode_base64url(&key.y, Some(32), "device public key y-coordinate")?;
    Ok(())
}

fn validate_device_keys(
    device_keys: &[DeviceKeyEnvelope],
    room_id: &str,
    expected_epoch: Option<u64>,
) -> CollaborationResult<()> {
    if device_keys.is_empty() || device_keys.len() > 32 {
        return Err(CollaborationError::invalid(
            "deviceKeys must contain one envelope per active device",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let key_epoch = expected_epoch.unwrap_or(device_keys[0].envelope.key_epoch);
    for entry in device_keys {
        validate_uuid(&entry.device_id, "deviceId")?;
        if !seen.insert(&entry.device_id) {
            return Err(CollaborationError::invalid(
                "deviceKeys must not contain duplicate devices",
            ));
        }
        validate_room_key_envelope(&entry.envelope)?;
        if entry.envelope.room_id != room_id
            || entry.envelope.recipient_device_id != entry.device_id
            || entry.envelope.key_epoch != key_epoch
        {
            return Err(CollaborationError::invalid(
                "room key envelope context is invalid",
            ));
        }
    }
    Ok(())
}

fn validate_room_key_envelope(envelope: &RoomKeyEnvelope) -> CollaborationResult<()> {
    if envelope.version != 1 || envelope.algorithm != "ECDH-P256-HKDF-SHA256-AES-256-GCM" {
        return Err(CollaborationError::invalid(
            "unsupported room key envelope format",
        ));
    }
    validate_uuid(&envelope.room_id, "roomId")?;
    validate_uuid(&envelope.recipient_device_id, "recipientDeviceId")?;
    if envelope.key_epoch == 0 {
        return Err(CollaborationError::invalid(
            "keyEpoch must be a positive integer",
        ));
    }
    validate_device_public_key(&envelope.ephemeral_public_key)?;
    decode_base64url(&envelope.salt, Some(16), "room key envelope salt")?;
    decode_base64url(&envelope.nonce, Some(12), "room key envelope nonce")?;
    decode_base64url(
        &envelope.ciphertext,
        Some(48),
        "room key envelope ciphertext",
    )?;
    Ok(())
}

fn validate_invite(invite: &CollaborationInvite) -> CollaborationResult<()> {
    if invite.version != 1 {
        return Err(CollaborationError::invalid(
            "collaboration invite format is unsupported",
        ));
    }
    let normalized = normalize_server_url(&invite.server_url)?;
    if normalized != invite.server_url {
        return Err(CollaborationError::invalid(
            "collaboration invite server URL is not canonical",
        ));
    }
    validate_subject(&invite.subject)?;
    if invite.issued_at < 0 {
        return Err(CollaborationError::invalid(
            "collaboration invite issue time is invalid",
        ));
    }
    if invite.devices.is_empty() {
        return Err(CollaborationError::invalid(
            "collaboration invite has no registered devices",
        ));
    }
    validate_registered_devices(&invite.devices)?;
    let mut seen = std::collections::HashSet::new();
    if invite
        .devices
        .iter()
        .any(|device| !seen.insert(&device.device_id))
    {
        return Err(CollaborationError::invalid(
            "collaboration invite contains duplicate devices",
        ));
    }
    Ok(())
}

fn validate_subject(subject: &str) -> CollaborationResult<()> {
    validate_nonempty(subject, 512, "subject")
}

fn validate_nonempty(value: &str, max_len: usize, name: &str) -> CollaborationResult<()> {
    if value.is_empty() || value.len() > max_len || value.contains('\0') {
        return Err(CollaborationError::invalid(format!("{name} is invalid")));
    }
    Ok(())
}

fn validate_uuid(value: &str, name: &str) -> CollaborationResult<()> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| CollaborationError::invalid(format!("{name} must be a UUID")))?;
    if !matches!(
        parsed.get_version(),
        Some(
            Version::Mac
                | Version::Dce
                | Version::Md5
                | Version::Random
                | Version::Sha1
                | Version::SortMac
                | Version::SortRand
                | Version::Custom
        )
    ) || parsed.get_variant() != Variant::RFC4122
    {
        return Err(CollaborationError::invalid(format!(
            "{name} must be a UUID"
        )));
    }
    Ok(())
}

fn validate_identifier(value: &str, max_len: usize, name: &str) -> CollaborationResult<()> {
    if value.is_empty()
        || value.len() > max_len
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            format!("{name} is invalid"),
        ));
    }
    Ok(())
}

fn validate_room_role(role: &str) -> CollaborationResult<()> {
    if matches!(role, "owner" | "controller" | "viewer") {
        Ok(())
    } else {
        Err(CollaborationError::new(
            CollaborationErrorCode::InvalidResponse,
            "collaboration server returned an invalid room role",
        ))
    }
}

fn validate_capability_role(role: &str) -> CollaborationResult<()> {
    if matches!(role, "controller" | "viewer") {
        Ok(())
    } else {
        Err(CollaborationError::invalid(
            "role must be controller or viewer",
        ))
    }
}

fn validate_etag(etag: &str) -> CollaborationResult<()> {
    if etag.is_empty() || etag.len() > 512 || etag.contains(['\r', '\n', '\0']) {
        return Err(CollaborationError::invalid("expectedEtag is invalid"));
    }
    Ok(())
}

fn decode_base64url(
    value: &str,
    expected_len: Option<usize>,
    name: &str,
) -> CollaborationResult<Vec<u8>> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'='))
        || value.trim_end_matches('=').contains('=')
    {
        return Err(CollaborationError::invalid(format!(
            "{name} is not base64url encoded"
        )));
    }
    let stripped = value.trim_end_matches('=');
    let bytes = URL_SAFE_NO_PAD
        .decode(stripped)
        .map_err(|_| CollaborationError::invalid(format!("{name} is not base64url encoded")))?;
    if expected_len.is_some_and(|length| bytes.len() != length) {
        return Err(CollaborationError::invalid(format!(
            "{name} has an invalid length"
        )));
    }
    Ok(bytes)
}

fn build_realtime_url(server_url: &str, ticket: &str) -> CollaborationResult<String> {
    let mut url = Url::parse(server_url)
        .map_err(|_| CollaborationError::storage("stored collaboration server URL is invalid"))?;
    url.set_scheme("wss")
        .map_err(|_| CollaborationError::storage("stored collaboration server URL is invalid"))?;
    url.set_path("/v1/realtime");
    url.query_pairs_mut().clear().append_pair("ticket", ticket);
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public_key() -> DevicePublicKey {
        DevicePublicKey {
            algorithm: "ECDH-P256".into(),
            x: URL_SAFE_NO_PAD.encode([1_u8; 32]),
            y: URL_SAFE_NO_PAD.encode([2_u8; 32]),
        }
    }

    fn registered_device() -> RegisteredDevice {
        RegisteredDevice {
            device_id: "11111111-1111-4111-8111-111111111111".into(),
            public_key: public_key(),
        }
    }

    #[test]
    fn collaboration_server_url_requires_canonical_https_origin() {
        assert_eq!(
            normalize_server_url(" https://collab.example.com/ ").unwrap(),
            "https://collab.example.com"
        );
        assert_eq!(
            normalize_server_url("https://collab.example.com:8443").unwrap(),
            "https://collab.example.com:8443"
        );
        assert!(normalize_server_url("http://collab.example.com").is_err());
        assert!(normalize_server_url("https://user:secret@collab.example.com").is_err());
        assert!(normalize_server_url("https://collab.example.com/base").is_err());
        assert!(normalize_server_url("https://collab.example.com?tenant=x").is_err());
    }

    #[test]
    fn invite_token_roundtrips_and_rejects_duplicates() {
        let invite = CollaborationInvite {
            version: 1,
            server_url: "https://collab.example.com".into(),
            subject: "user-123".into(),
            devices: vec![registered_device()],
            issued_at: 1_700_000_000,
        };
        let token = format!(
            "{INVITE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invite).unwrap())
        );
        assert_eq!(parse_invite(ParseInviteInput { token }).unwrap(), invite);

        let duplicate = CollaborationInvite {
            devices: vec![registered_device(), registered_device()],
            ..invite
        };
        let token = format!(
            "{INVITE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&duplicate).unwrap())
        );
        assert!(parse_invite(ParseInviteInput { token }).is_err());
    }

    #[test]
    fn realtime_url_uses_wss_and_encodes_ticket() {
        assert_eq!(
            build_realtime_url("https://collab.example.com", "a_b-c").unwrap(),
            "wss://collab.example.com/v1/realtime?ticket=a_b-c"
        );
    }

    #[test]
    fn capability_inputs_reject_invalid_room_id_and_role() {
        let error = validate_uuid("not-a-uuid", "roomId").unwrap_err();
        assert_eq!(error.code, CollaborationErrorCode::InvalidInput);
        assert_eq!(error.message, "roomId must be a UUID");

        let error = validate_capability_role("owner").unwrap_err();
        assert_eq!(error.code, CollaborationErrorCode::InvalidInput);
        assert_eq!(error.message, "role must be controller or viewer");
        validate_capability_role("controller").unwrap();
        validate_capability_role("viewer").unwrap();
    }

    #[test]
    fn capability_ttl_is_omitted_when_absent() {
        let request = MintCapabilityRequest {
            role: "viewer",
            ttl_seconds: None,
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({ "role": "viewer" })
        );
    }

    #[test]
    fn jwt_subject_is_extracted_without_exposing_token() {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#);
        let payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"account-123"}"#);
        let token = format!("{header}.{payload}.signature");
        assert_eq!(subject_from_access_token(&token).unwrap(), "account-123");
        assert!(subject_from_access_token("opaque-token").is_err());
    }

    #[test]
    fn server_statuses_have_stable_error_codes() {
        let error = map_http_error(StatusCode::CONFLICT, Some("resource already exists".into()));
        assert_eq!(error.code, CollaborationErrorCode::Conflict);
        assert_eq!(error.http_status, Some(409));
        assert_eq!(error.message, "resource already exists");

        let error = map_http_error(StatusCode::TOO_MANY_REQUESTS, None);
        assert_eq!(error.code, CollaborationErrorCode::RateLimited);
        assert_eq!(error.http_status, Some(429));
    }

    #[test]
    fn room_envelope_validation_matches_typescript_crypto_shape() {
        let envelope = RoomKeyEnvelope {
            version: 1,
            algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM".into(),
            room_id: "22222222-2222-4222-8222-222222222222".into(),
            key_epoch: 1,
            recipient_device_id: "11111111-1111-4111-8111-111111111111".into(),
            ephemeral_public_key: public_key(),
            salt: URL_SAFE_NO_PAD.encode([3_u8; 16]),
            nonce: URL_SAFE_NO_PAD.encode([4_u8; 12]),
            ciphertext: URL_SAFE_NO_PAD.encode([5_u8; 48]),
        };
        validate_room_key_envelope(&envelope).unwrap();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn keychain_chunking_respects_windows_utf16_limit() {
        let secret = format!(
            "{}{}{}",
            "a".repeat(KEYCHAIN_CHUNK_UTF16_LIMIT - 1),
            "😀",
            "b".repeat(KEYCHAIN_CHUNK_UTF16_LIMIT)
        );
        let chunks = split_keychain_secret(&secret);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.encode_utf16().count() <= KEYCHAIN_CHUNK_UTF16_LIMIT));
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| chunk.as_str())
                .collect::<String>(),
            secret
        );
    }

    #[tokio::test]
    async fn migration_creates_default_collaboration_state() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let config = get_config(&pool).await.unwrap();
        assert_eq!(config.server_url, "https://collab.luma.bwmp.dev");
        let row: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT device_id, device_public_key FROM collaboration_state WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, (None, None));
    }
}
