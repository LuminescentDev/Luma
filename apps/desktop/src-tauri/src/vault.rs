use crate::errors::{LumaError, Result};
use argon2::Argon2;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use keyring::Entry;
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use sqlx::{Executor, Row, Sqlite, SqlitePool};
use std::path::Path;
#[cfg(any(target_os = "android", target_os = "ios"))]
use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const SERVICE: &str = "luma.encrypted-vault";
#[cfg(any(target_os = "android", target_os = "ios"))]
const DEVICE_SECRET_FILE: &str = "vault-device-secret";
pub struct VaultState {
    key: Mutex<Option<[u8; 32]>>,
    #[cfg(any(target_os = "android", target_os = "ios"))]
    device_secret_path: PathBuf,
}
impl VaultState {
    pub fn new(app_data_dir: &Path) -> Self {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let _ = app_data_dir;
        Self {
            key: Mutex::new(None),
            #[cfg(any(target_os = "android", target_os = "ios"))]
            device_secret_path: app_data_dir.join(DEVICE_SECRET_FILE),
        }
    }
}
impl Default for VaultState {
    fn default() -> Self {
        Self::new(&std::env::temp_dir().join("luma"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub configured: bool,
    pub unlocked: bool,
    pub remember_on_device: bool,
}

fn derive(password: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let mut out = [0; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| LumaError::InvalidInput(format!("vault key derivation failed: {e}")))?;
    Ok(out)
}
fn encrypt(key: &[u8; 32], value: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut nonce = [0; 24];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new(key.into());
    let value = cipher
        .encrypt(XNonce::from_slice(&nonce), value)
        .map_err(|_| LumaError::InvalidInput("vault encryption failed".into()))?;
    Ok((nonce.to_vec(), value))
}
fn decrypt(key: &[u8; 32], nonce: &[u8], value: &[u8]) -> Result<Vec<u8>> {
    XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(nonce), value)
        .map_err(|_| LumaError::InvalidInput("incorrect master password or corrupted vault".into()))
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn remember(_state: &VaultState, key: &[u8; 32]) -> Result<()> {
    use base64::Engine;
    Entry::new(SERVICE, "unlock-key")
        .map_err(|e| LumaError::InvalidInput(e.to_string()))?
        .set_password(&base64::engine::general_purpose::STANDARD.encode(key))
        .map_err(|e| LumaError::InvalidInput(format!("could not remember vault on device: {e}")))?;
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn remember(state: &VaultState, key: &[u8; 32]) -> Result<()> {
    use base64::Engine;
    // TODO(mobile-keystore): replace this app-sandbox fallback with a native
    // Android Keystore / iOS Keychain bridge. The file contains only the same
    // device unlock key stored by desktop keyring; all vault payloads remain
    // encrypted through the existing XChaCha20-Poly1305 vault format.
    if let Some(parent) = state.device_secret_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(key);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(&state.device_secret_path)?;
    file.write_all(encoded.as_bytes())?;
    file.flush()?;
    file.sync_all()?;
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn forget(_state: &VaultState) {
    if let Ok(e) = Entry::new(SERVICE, "unlock-key") {
        let _ = e.delete_credential();
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn forget(state: &VaultState) {
    let _ = std::fs::remove_file(&state.device_secret_path);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn remembered_key(_state: &VaultState) -> Option<String> {
    Entry::new(SERVICE, "unlock-key")
        .and_then(|entry| entry.get_password())
        .ok()
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn remembered_key(state: &VaultState) -> Option<String> {
    std::fs::read_to_string(&state.device_secret_path).ok()
}

pub async fn status(pool: &SqlitePool, state: &VaultState) -> Result<VaultStatus> {
    let row = sqlx::query("SELECT remember_on_device FROM vault_config WHERE id=1")
        .fetch_optional(pool)
        .await?;
    Ok(VaultStatus {
        configured: row.is_some(),
        unlocked: state.key.lock().unwrap().is_some(),
        remember_on_device: row.map(|r| r.get::<i64, _>(0) != 0).unwrap_or(false),
    })
}
pub async fn setup(
    pool: &SqlitePool,
    state: &VaultState,
    password: &str,
    remember_device: bool,
) -> Result<()> {
    if password.len() < 8 {
        return Err(LumaError::InvalidInput(
            "master password must be at least 8 characters".into(),
        ));
    }
    let mut salt = [0; 16];
    OsRng.fill_bytes(&mut salt);
    let key = derive(password, &salt)?;
    let (nonce, ciphertext) = encrypt(&key, b"luma-vault-v1")?;
    sqlx::query("INSERT INTO vault_config(id,salt,verifier_nonce,verifier_ciphertext,remember_on_device) VALUES(1,?1,?2,?3,?4)").bind(salt.to_vec()).bind(nonce).bind(ciphertext).bind(remember_device).execute(pool).await?;
    if remember_device {
        remember(state, &key)?;
    }
    *state.key.lock().unwrap() = Some(key);
    Ok(())
}
pub async fn unlock(pool: &SqlitePool, state: &VaultState, password: &str) -> Result<()> {
    let row =
        sqlx::query("SELECT salt,verifier_nonce,verifier_ciphertext FROM vault_config WHERE id=1")
            .fetch_one(pool)
            .await?;
    let salt: Vec<u8> = row.get(0);
    let nonce: Vec<u8> = row.get(1);
    let ciphertext: Vec<u8> = row.get(2);
    let key = derive(password, &salt)?;
    decrypt(&key, &nonce, &ciphertext)?;
    *state.key.lock().unwrap() = Some(key);
    Ok(())
}
pub async fn try_device_unlock(pool: &SqlitePool, state: &VaultState) {
    use base64::Engine;
    let row=sqlx::query("SELECT verifier_nonce,verifier_ciphertext FROM vault_config WHERE id=1 AND remember_on_device=1").fetch_optional(pool).await.ok().flatten();
    let Some(row) = row else { return };
    if let Some(raw) = remembered_key(state) {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw.trim()) {
            if let Ok(key) = <[u8; 32]>::try_from(bytes) {
                let nonce: Vec<u8> = row.get(0);
                let ciphertext: Vec<u8> = row.get(1);
                if decrypt(&key, &nonce, &ciphertext).is_ok() {
                    *state.key.lock().unwrap() = Some(key)
                }
            }
        }
    }
}
pub async fn set_policy(
    pool: &SqlitePool,
    state: &VaultState,
    remember_device: bool,
) -> Result<()> {
    sqlx::query("UPDATE vault_config SET remember_on_device=?1 WHERE id=1")
        .bind(remember_device)
        .execute(pool)
        .await?;
    if remember_device {
        let key = state
            .key
            .lock()
            .unwrap()
            .ok_or_else(|| LumaError::InvalidInput("vault is locked".into()))?;
        remember(state, &key)?
    } else {
        forget(state)
    }
    Ok(())
}
pub fn lock(state: &VaultState) {
    *state.key.lock().unwrap() = None
}

pub fn is_unlocked(state: &VaultState) -> bool {
    state.key.lock().unwrap().is_some()
}

pub async fn store<'e, E>(
    executor: E,
    state: &VaultState,
    owner: &str,
    id: &str,
    kind: &str,
    value: &str,
) -> Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    let key = state.key.lock().unwrap().ok_or_else(|| {
        LumaError::InvalidInput("vault is locked; unlock it before saving secrets".into())
    })?;
    let (nonce, ciphertext) = encrypt(&key, value.as_bytes())?;
    sqlx::query("INSERT INTO vault_secrets(owner_type,owner_id,secret_type,nonce,ciphertext) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(owner_type,owner_id,secret_type) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext").bind(owner).bind(id).bind(kind).bind(nonce).bind(ciphertext).execute(executor).await?;
    Ok(())
}
pub async fn load(
    pool: &SqlitePool,
    state: &VaultState,
    owner: &str,
    id: &str,
    kind: &str,
) -> Result<Option<String>> {
    let key = state.key.lock().unwrap().ok_or_else(|| {
        LumaError::InvalidInput("vault is locked; unlock it before viewing secrets".into())
    })?;
    let row = sqlx::query("SELECT nonce,ciphertext FROM vault_secrets WHERE owner_type=?1 AND owner_id=?2 AND secret_type=?3")
        .bind(owner).bind(id).bind(kind).fetch_optional(pool).await?;
    let Some(row) = row else { return Ok(None) };
    let nonce: Vec<u8> = row.get(0);
    let ciphertext: Vec<u8> = row.get(1);
    String::from_utf8(decrypt(&key, &nonce, &ciphertext)?)
        .map(Some)
        .map_err(|_| LumaError::InvalidInput("vault secret is not valid UTF-8".into()))
}
pub async fn delete<'e, E>(executor: E, owner: &str, id: &str) -> Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM vault_secrets WHERE owner_type=?1 AND owner_id=?2")
        .bind(owner)
        .bind(id)
        .execute(executor)
        .await?;
    Ok(())
}
