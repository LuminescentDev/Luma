use crate::errors::{LumaError, Result};
use argon2::Argon2;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use keyring::Entry;
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use std::sync::Mutex;

const SERVICE: &str = "luma.encrypted-vault";
pub struct VaultState(pub Mutex<Option<[u8; 32]>>);
impl Default for VaultState {
    fn default() -> Self {
        Self(Mutex::new(None))
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
fn remember(key: &[u8; 32]) -> Result<()> {
    use base64::Engine;
    Entry::new(SERVICE, "unlock-key")
        .map_err(|e| LumaError::InvalidInput(e.to_string()))?
        .set_password(&base64::engine::general_purpose::STANDARD.encode(key))
        .map_err(|e| LumaError::InvalidInput(format!("could not remember vault on device: {e}")))?;
    Ok(())
}
fn forget() {
    if let Ok(e) = Entry::new(SERVICE, "unlock-key") {
        let _ = e.delete_credential();
    }
}

pub async fn status(pool: &SqlitePool, state: &VaultState) -> Result<VaultStatus> {
    let row = sqlx::query("SELECT remember_on_device FROM vault_config WHERE id=1")
        .fetch_optional(pool)
        .await?;
    Ok(VaultStatus {
        configured: row.is_some(),
        unlocked: state.0.lock().unwrap().is_some(),
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
        remember(&key)?;
    }
    *state.0.lock().unwrap() = Some(key);
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
    *state.0.lock().unwrap() = Some(key);
    Ok(())
}
pub async fn try_device_unlock(pool: &SqlitePool, state: &VaultState) {
    use base64::Engine;
    let row=sqlx::query("SELECT verifier_nonce,verifier_ciphertext FROM vault_config WHERE id=1 AND remember_on_device=1").fetch_optional(pool).await.ok().flatten();
    let Some(row) = row else { return };
    if let Ok(raw) = Entry::new(SERVICE, "unlock-key").and_then(|e| e.get_password()) {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw) {
            if let Ok(key) = <[u8; 32]>::try_from(bytes) {
                let nonce: Vec<u8> = row.get(0);
                let ciphertext: Vec<u8> = row.get(1);
                if decrypt(&key, &nonce, &ciphertext).is_ok() {
                    *state.0.lock().unwrap() = Some(key)
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
            .0
            .lock()
            .unwrap()
            .ok_or_else(|| LumaError::InvalidInput("vault is locked".into()))?;
        remember(&key)?
    } else {
        forget()
    }
    Ok(())
}
pub fn lock(state: &VaultState) {
    *state.0.lock().unwrap() = None
}

pub fn is_unlocked(state: &VaultState) -> bool {
    state.0.lock().unwrap().is_some()
}

pub async fn store(
    pool: &SqlitePool,
    state: &VaultState,
    owner: &str,
    id: &str,
    kind: &str,
    value: &str,
) -> Result<()> {
    let key = state.0.lock().unwrap().ok_or_else(|| {
        LumaError::InvalidInput("vault is locked; unlock it before saving secrets".into())
    })?;
    let (nonce, ciphertext) = encrypt(&key, value.as_bytes())?;
    sqlx::query("INSERT INTO vault_secrets(owner_type,owner_id,secret_type,nonce,ciphertext) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(owner_type,owner_id,secret_type) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext").bind(owner).bind(id).bind(kind).bind(nonce).bind(ciphertext).execute(pool).await?;
    Ok(())
}
pub async fn load(
    pool: &SqlitePool,
    state: &VaultState,
    owner: &str,
    id: &str,
    kind: &str,
) -> Result<Option<String>> {
    let key = state.0.lock().unwrap().ok_or_else(|| {
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
pub async fn delete(pool: &SqlitePool, owner: &str, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM vault_secrets WHERE owner_type=?1 AND owner_id=?2")
        .bind(owner)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
