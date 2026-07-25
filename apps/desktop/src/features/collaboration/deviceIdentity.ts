import {
  exportDevicePrivateKey,
  exportDevicePublicKey,
  generateDeviceKeyPair,
  importDevicePrivateKey,
  type DevicePublicKey,
} from "@luma/collaboration-encryption";
import {
  collabGetDeviceIdentity,
  collabRegisterDevice,
  collabSetDeviceIdentity,
} from "../../lib/collab";

/*
 * Non-React device-identity bootstrap for collaboration. The imported private
 * CryptoKey is cached at module scope and NEVER placed in React state or logged;
 * the serialized private key only ever travels between the backend credential
 * store and `crypto.subtle` here. React components read only the non-secret
 * deviceId / public key via the collab store.
 */

export type LoadedDeviceIdentity = {
  deviceId: string;
  publicKey: DevicePublicKey;
  /** Non-extractable ECDH private key for opening room-key envelopes. */
  privateKey: CryptoKey;
};

let cached: LoadedDeviceIdentity | null = null;
let loading: Promise<LoadedDeviceIdentity> | null = null;

/**
 * Return this device's collaboration identity, generating and persisting one on
 * first use. On first use a fresh ECDH-P256 keypair is created, exported, and
 * stored via `collab_set_device_identity` (the private key goes to the OS
 * credential store / encrypted vault). The imported private CryptoKey is cached
 * for the process lifetime.
 */
export function loadDeviceIdentity(): Promise<LoadedDeviceIdentity> {
  if (cached) return Promise.resolve(cached);
  if (loading) return loading;
  loading = (async () => {
    const existing = await collabGetDeviceIdentity();
    if (existing) {
      const privateKey = await importDevicePrivateKey(existing.privateKey);
      cached = {
        deviceId: existing.deviceId,
        publicKey: existing.publicKey,
        privateKey,
      };
      return cached;
    }
    const pair = await generateDeviceKeyPair();
    const publicKey = await exportDevicePublicKey(pair.publicKey);
    const serializedPrivate = await exportDevicePrivateKey(pair.privateKey);
    const deviceId = crypto.randomUUID();
    await collabSetDeviceIdentity({
      deviceId,
      publicKey,
      privateKey: serializedPrivate,
    });
    cached = { deviceId, publicKey, privateKey: pair.privateKey };
    return cached;
  })();
  try {
    return loading;
  } finally {
    void loading.catch(() => {
      // A failed bootstrap must not be cached as a permanent rejection.
      loading = null;
    });
  }
}

/** Register this device's public key with the collaboration server (idempotent).
 * Requires an active sign-in; callers surface auth errors to the user. */
export async function registerDevice(): Promise<LoadedDeviceIdentity> {
  const identity = await loadDeviceIdentity();
  await collabRegisterDevice(identity.deviceId, identity.publicKey);
  return identity;
}

/** The cached identity if already loaded, else null (no await). */
export function cachedDeviceIdentity(): LoadedDeviceIdentity | null {
  return cached;
}

/** Test-only: drop the cached identity so a fresh bootstrap runs. */
export function resetDeviceIdentityCache(): void {
  cached = null;
  loading = null;
}
