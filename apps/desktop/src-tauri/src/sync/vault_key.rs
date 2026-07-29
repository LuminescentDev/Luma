//! Sealing a managed vault's content key to a device.
//!
//! This is the same construction the collaboration client uses for room keys —
//! ECDH on P-256, HKDF-SHA256 to a wrapping key, AES-256-GCM to wrap — so a
//! device needs only the identity it already published to take part. It is
//! implemented here rather than called through the frontend because the content
//! key must never exist in JS: it decrypts every host, key and password in the
//! vault.
//!
//! The domain separation strings are vault-specific (`luma.sync.vault-key.*`
//! rather than `luma.collaboration.room-key.*`), so an envelope minted for a
//! collaboration room cannot be replayed as a vault key or the other way round,
//! even though both are sealed to the same device identity.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use p256::pkcs8::DecodePrivateKey;
use p256::{EncodedPoint, PublicKey, SecretKey};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::collaboration::{DevicePublicKey, SerializedDevicePrivateKey};
use crate::errors::{LumaError, Result};

pub const VAULT_KEY_ENVELOPE_ALGORITHM: &str = "ECDH-P256-HKDF-SHA256-AES-256-GCM";
pub const DEVICE_KEY_ALGORITHM: &str = "ECDH-P256";
pub const CONTENT_KEY_LEN: usize = 32;

const KDF_INFO_LABEL: &str = "luma.sync.vault-key.kdf";
const AAD_LABEL: &str = "luma.sync.vault-key.envelope";
const ENVELOPE_VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

/// The sealed content key as it is stored on the server: opaque JSON there, and
/// shaped like the collaboration room-key envelope so the two stay legible
/// side by side.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultKeyEnvelope {
    pub version: u8,
    pub algorithm: String,
    pub vault_id: String,
    pub key_epoch: u32,
    pub recipient_device_id: String,
    pub ephemeral_public_key: DevicePublicKey,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Copy)]
pub struct EnvelopeContext<'a> {
    pub vault_id: &'a str,
    pub key_epoch: u32,
    pub recipient_device_id: &'a str,
}

pub fn generate_content_key() -> Zeroizing<[u8; CONTENT_KEY_LEN]> {
    let mut key = Zeroizing::new([0_u8; CONTENT_KEY_LEN]);
    OsRng.fill_bytes(&mut *key);
    key
}

pub fn seal(
    content_key: &[u8; CONTENT_KEY_LEN],
    recipient: &DevicePublicKey,
    context: EnvelopeContext<'_>,
) -> Result<VaultKeyEnvelope> {
    validate_context(context)?;
    let recipient_key = import_public_key(recipient)?;

    let ephemeral = SecretKey::random(&mut OsRng);
    let ephemeral_public = export_public_key(&ephemeral.public_key());

    let mut salt = [0_u8; SALT_LEN];
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);

    let wrapping_key = derive_wrapping_key(
        ephemeral.to_nonzero_scalar(),
        &recipient_key,
        &salt,
        &kdf_info(context),
    )?;
    let aad = associated_data(context, &ephemeral_public);
    let ciphertext = Aes256Gcm::new((&*wrapping_key).into())
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: content_key.as_slice(),
                aad: &aad,
            },
        )
        .map_err(|_| LumaError::SyncUnavailable("could not seal the vault key".into()))?;

    let base64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    Ok(VaultKeyEnvelope {
        version: ENVELOPE_VERSION,
        algorithm: VAULT_KEY_ENVELOPE_ALGORITHM.to_string(),
        vault_id: context.vault_id.to_string(),
        key_epoch: context.key_epoch,
        recipient_device_id: context.recipient_device_id.to_string(),
        ephemeral_public_key: ephemeral_public,
        salt: base64.encode(salt),
        nonce: base64.encode(nonce),
        ciphertext: base64.encode(ciphertext),
    })
}

pub fn open(
    envelope: &VaultKeyEnvelope,
    recipient_private_key: &SerializedDevicePrivateKey,
    expected: EnvelopeContext<'_>,
) -> Result<Zeroizing<[u8; CONTENT_KEY_LEN]>> {
    validate_context(expected)?;
    if envelope.version != ENVELOPE_VERSION || envelope.algorithm != VAULT_KEY_ENVELOPE_ALGORITHM {
        return Err(LumaError::InvalidInput(
            "unsupported vault key envelope format".into(),
        ));
    }
    // The context is authenticated by the AAD as well; checking it here turns a
    // mismatched envelope into a clear error instead of a decryption failure.
    if envelope.vault_id != expected.vault_id
        || envelope.key_epoch != expected.key_epoch
        || envelope.recipient_device_id != expected.recipient_device_id
    {
        return Err(LumaError::InvalidInput(
            "vault key envelope was sealed for a different vault, epoch or device".into(),
        ));
    }

    let ephemeral_public = import_public_key(&envelope.ephemeral_public_key)?;
    let secret = import_private_key(recipient_private_key)?;
    let salt = decode_fixed(&envelope.salt, SALT_LEN, "vault key envelope salt")?;
    let nonce = decode_fixed(&envelope.nonce, NONCE_LEN, "vault key envelope nonce")?;
    let base64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let ciphertext = base64
        .decode(&envelope.ciphertext)
        .map_err(|_| LumaError::InvalidInput("vault key envelope ciphertext is invalid".into()))?;

    let wrapping_key = derive_wrapping_key(
        secret.to_nonzero_scalar(),
        &ephemeral_public,
        &salt,
        &kdf_info(expected),
    )?;
    let aad = associated_data(expected, &envelope.ephemeral_public_key);
    let plaintext = Zeroizing::new(
        Aes256Gcm::new((&*wrapping_key).into())
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| {
                LumaError::SyncAuthFailed("the vault key could not be authenticated".into())
            })?,
    );
    if plaintext.len() != CONTENT_KEY_LEN {
        return Err(LumaError::InvalidInput(
            "vault key envelope holds a key of the wrong length".into(),
        ));
    }
    let mut key = Zeroizing::new([0_u8; CONTENT_KEY_LEN]);
    key.copy_from_slice(&plaintext);
    Ok(key)
}

fn derive_wrapping_key(
    secret: p256::NonZeroScalar,
    public: &PublicKey,
    salt: &[u8],
    info: &[u8],
) -> Result<Zeroizing<[u8; 32]>> {
    let shared = diffie_hellman(secret, public.as_affine());
    let hkdf = Hkdf::<Sha256>::new(Some(salt), shared.raw_secret_bytes().as_slice());
    let mut key = Zeroizing::new([0_u8; 32]);
    hkdf.expand(info, &mut *key)
        .map_err(|_| LumaError::SyncUnavailable("vault key derivation failed".into()))?;
    Ok(key)
}

/// Both the KDF info and the AAD are the JSON encoding of a fixed-shape array,
/// matching `encodeCanonical` in `@luma/collaboration-encryption` so the two
/// implementations agree byte for byte.
fn kdf_info(context: EnvelopeContext<'_>) -> Vec<u8> {
    serde_json::json!([
        KDF_INFO_LABEL,
        ENVELOPE_VERSION,
        VAULT_KEY_ENVELOPE_ALGORITHM,
        context.vault_id,
        context.key_epoch,
        context.recipient_device_id,
    ])
    .to_string()
    .into_bytes()
}

fn associated_data(context: EnvelopeContext<'_>, ephemeral: &DevicePublicKey) -> Vec<u8> {
    serde_json::json!([
        AAD_LABEL,
        ENVELOPE_VERSION,
        VAULT_KEY_ENVELOPE_ALGORITHM,
        context.vault_id,
        context.key_epoch,
        context.recipient_device_id,
        ephemeral.algorithm,
        ephemeral.x,
        ephemeral.y,
    ])
    .to_string()
    .into_bytes()
}

fn validate_context(context: EnvelopeContext<'_>) -> Result<()> {
    if context.vault_id.is_empty()
        || context.vault_id.len() > 128
        || context.recipient_device_id.is_empty()
        || context.recipient_device_id.len() > 128
        || context.key_epoch == 0
    {
        return Err(LumaError::InvalidInput(
            "vault key envelope context is invalid".into(),
        ));
    }
    Ok(())
}

fn import_public_key(key: &DevicePublicKey) -> Result<PublicKey> {
    if key.algorithm != DEVICE_KEY_ALGORITHM {
        return Err(LumaError::InvalidInput(
            "unsupported device public key algorithm".into(),
        ));
    }
    let x = decode_fixed(&key.x, 32, "device public key x-coordinate")?;
    let y = decode_fixed(&key.y, 32, "device public key y-coordinate")?;
    let point =
        EncodedPoint::from_affine_coordinates(x.as_slice().into(), y.as_slice().into(), false);
    Option::from(PublicKey::from_encoded_point(&point))
        .ok_or_else(|| LumaError::InvalidInput("device public key is not on the curve".into()))
}

fn export_public_key(key: &PublicKey) -> DevicePublicKey {
    let point = key.to_encoded_point(false);
    let base64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    DevicePublicKey {
        algorithm: DEVICE_KEY_ALGORITHM.to_string(),
        // Uncompressed SEC1 points always carry both coordinates, so these
        // cannot be absent here.
        x: base64.encode(point.x().expect("uncompressed point has an x-coordinate")),
        y: base64.encode(point.y().expect("uncompressed point has a y-coordinate")),
    }
}

fn import_private_key(key: &SerializedDevicePrivateKey) -> Result<SecretKey> {
    if key.algorithm != DEVICE_KEY_ALGORITHM {
        return Err(LumaError::InvalidInput(
            "unsupported device private key algorithm".into(),
        ));
    }
    let base64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let der = Zeroizing::new(
        base64
            .decode(&key.pkcs8)
            .map_err(|_| LumaError::InvalidInput("device private key is invalid".into()))?,
    );
    SecretKey::from_pkcs8_der(&der)
        .map_err(|_| LumaError::InvalidInput("device private key is invalid".into()))
}

fn decode_fixed(value: &str, len: usize, name: &str) -> Result<Vec<u8>> {
    let base64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let bytes = base64
        .decode(value)
        .map_err(|_| LumaError::InvalidInput(format!("{name} is invalid")))?;
    if bytes.len() != len {
        return Err(LumaError::InvalidInput(format!(
            "{name} has an invalid length"
        )));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device() -> (DevicePublicKey, SerializedDevicePrivateKey) {
        use p256::pkcs8::EncodePrivateKey;
        let secret = SecretKey::random(&mut OsRng);
        let base64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let pkcs8 = secret.to_pkcs8_der().unwrap();
        (
            export_public_key(&secret.public_key()),
            SerializedDevicePrivateKey {
                algorithm: DEVICE_KEY_ALGORITHM.to_string(),
                pkcs8: base64.encode(pkcs8.as_bytes()),
            },
        )
    }

    fn context<'a>(vault_id: &'a str, epoch: u32, device_id: &'a str) -> EnvelopeContext<'a> {
        EnvelopeContext {
            vault_id,
            key_epoch: epoch,
            recipient_device_id: device_id,
        }
    }

    #[test]
    fn a_sealed_key_round_trips_for_the_recipient_device() {
        let (public, private) = device();
        let key = generate_content_key();
        let envelope = seal(&key, &public, context("vault-1", 1, "device-1")).unwrap();

        assert_eq!(envelope.algorithm, VAULT_KEY_ENVELOPE_ALGORITHM);
        assert_eq!(envelope.vault_id, "vault-1");
        let opened = open(&envelope, &private, context("vault-1", 1, "device-1")).unwrap();
        assert_eq!(*opened, *key);
    }

    #[test]
    fn another_device_cannot_open_the_envelope() {
        let (public, _) = device();
        let (_, other_private) = device();
        let key = generate_content_key();
        let envelope = seal(&key, &public, context("vault-1", 1, "device-1")).unwrap();

        let error = open(&envelope, &other_private, context("vault-1", 1, "device-1")).unwrap_err();
        assert!(matches!(error, LumaError::SyncAuthFailed(_)), "{error:?}");
    }

    #[test]
    fn the_context_is_bound_to_the_ciphertext() {
        let (public, private) = device();
        let key = generate_content_key();
        let envelope = seal(&key, &public, context("vault-1", 1, "device-1")).unwrap();

        for wrong in [
            context("vault-2", 1, "device-1"),
            context("vault-1", 2, "device-1"),
            context("vault-1", 1, "device-2"),
        ] {
            assert!(open(&envelope, &private, wrong).is_err());
        }

        // Rewriting the header alone does not help: the same values are AAD.
        let mut forged = envelope.clone();
        forged.vault_id = "vault-2".into();
        let error = open(&forged, &private, context("vault-2", 1, "device-1")).unwrap_err();
        assert!(matches!(error, LumaError::SyncAuthFailed(_)), "{error:?}");
    }

    #[test]
    fn a_tampered_ciphertext_is_rejected() {
        let (public, private) = device();
        let key = generate_content_key();
        let mut envelope = seal(&key, &public, context("vault-1", 1, "device-1")).unwrap();

        let base64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let mut bytes = base64.decode(&envelope.ciphertext).unwrap();
        bytes[0] ^= 0x01;
        envelope.ciphertext = base64.encode(&bytes);

        let error = open(&envelope, &private, context("vault-1", 1, "device-1")).unwrap_err();
        assert!(matches!(error, LumaError::SyncAuthFailed(_)), "{error:?}");
    }

    #[test]
    fn each_seal_uses_fresh_randomness() {
        let (public, _) = device();
        let key = generate_content_key();
        let first = seal(&key, &public, context("vault-1", 1, "device-1")).unwrap();
        let second = seal(&key, &public, context("vault-1", 1, "device-1")).unwrap();

        assert_ne!(first.ciphertext, second.ciphertext);
        assert_ne!(first.salt, second.salt);
        assert_ne!(first.nonce, second.nonce);
        assert_ne!(first.ephemeral_public_key.x, second.ephemeral_public_key.x);
    }

    /// The device identity is minted by WebCrypto in the collaboration client
    /// and only ever read here, so this fixture is a real `crypto.subtle`
    /// P-256 export: it pins the PKCS#8 and base64url-JWK shapes that Rust has
    /// to keep accepting.
    #[test]
    fn a_webcrypto_device_key_is_accepted_and_matches_its_public_half() {
        let public = DevicePublicKey {
            algorithm: DEVICE_KEY_ALGORITHM.to_string(),
            x: "mczqVe1A2ZhXVjaUn7GQ8xSJi5sr3UXJ41mRNhXPvAU".to_string(),
            y: "YobOp2rbaTqX0CHJu6U3RxpCmyxQ7L558HfLAIpqRLw".to_string(),
        };
        let private = SerializedDevicePrivateKey {
            algorithm: DEVICE_KEY_ALGORITHM.to_string(),
            pkcs8: "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgqC9QMcYzX2LuLzIOp4h0\
                    1jVjKdwG9JtiSiHC2ZRQLcOhRANCAASZzOpV7UDZmFdWNpSfsZDzFImLmyvdRcnjWZE2\
                    Fc-8BWKGzqdq22k6l9AhybulN0caQpssUOy-efB3ywCKakS8"
                .to_string(),
        };

        // The private key really is the counterpart of the advertised public one.
        let imported = import_private_key(&private).unwrap();
        assert_eq!(export_public_key(&imported.public_key()), public);

        let key = generate_content_key();
        let envelope = seal(&key, &public, context("vault-1", 3, "device-1")).unwrap();
        let opened = open(&envelope, &private, context("vault-1", 3, "device-1")).unwrap();
        assert_eq!(*opened, *key);
    }

    #[test]
    fn a_zero_epoch_or_empty_identifier_is_refused() {
        let (public, _) = device();
        let key = generate_content_key();
        assert!(seal(&key, &public, context("vault-1", 0, "device-1")).is_err());
        assert!(seal(&key, &public, context("", 1, "device-1")).is_err());
        assert!(seal(&key, &public, context("vault-1", 1, "")).is_err());
    }
}
