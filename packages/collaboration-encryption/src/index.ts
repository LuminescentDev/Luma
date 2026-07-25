import {
  EVENT_ENCRYPTION_ALGORITHM,
  type EncryptedEventKind,
  type EncryptedEventMessage,
} from "@luma/collaboration-protocol";

export const ROOM_KEY_ENVELOPE_ALGORITHM =
  "ECDH-P256-HKDF-SHA256-AES-256-GCM" as const;
export const DEVICE_KEY_ALGORITHM = "ECDH-P256" as const;

export interface DeviceKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface DevicePublicKey {
  algorithm: typeof DEVICE_KEY_ALGORITHM;
  x: string;
  y: string;
}

export interface SerializedDevicePrivateKey {
  algorithm: typeof DEVICE_KEY_ALGORITHM;
  pkcs8: string;
}

export interface RoomKeyEnvelope {
  version: 1;
  algorithm: typeof ROOM_KEY_ENVELOPE_ALGORITHM;
  roomId: string;
  keyEpoch: number;
  recipientDeviceId: string;
  ephemeralPublicKey: DevicePublicKey;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export interface RoomKeyEnvelopeContext {
  roomId: string;
  keyEpoch: number;
  recipientDeviceId: string;
}

export interface RoomEventHeader {
  roomId: string;
  eventId: string;
  kind: EncryptedEventKind;
  terminalId?: string;
  senderDeviceId: string;
  senderSequence: number;
  keyEpoch: number;
}

export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  if (!("publicKey" in pair)) throw new CollaborationCryptoError("device key generation failed");
  return pair;
}

export async function exportDevicePublicKey(key: CryptoKey): Promise<DevicePublicKey> {
  assertEcKey(key, "public");
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new CollaborationCryptoError("device public key is invalid");
  }
  decodeBase64Url(jwk.x, 32, "device public key x-coordinate");
  decodeBase64Url(jwk.y, 32, "device public key y-coordinate");
  return { algorithm: DEVICE_KEY_ALGORITHM, x: jwk.x, y: jwk.y };
}

export async function exportDevicePrivateKey(key: CryptoKey): Promise<SerializedDevicePrivateKey> {
  assertEcKey(key, "private");
  const bytes = await crypto.subtle.exportKey("pkcs8", key);
  return { algorithm: DEVICE_KEY_ALGORITHM, pkcs8: encodeBase64Url(new Uint8Array(bytes)) };
}

export async function importDevicePrivateKey(serialized: SerializedDevicePrivateKey): Promise<CryptoKey> {
  if (serialized.algorithm !== DEVICE_KEY_ALGORITHM) {
    throw new CollaborationCryptoError("unsupported device private key algorithm");
  }
  const bytes = decodeBase64Url(serialized.pkcs8, undefined, "device private key");
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      toArrayBuffer(bytes),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
  } catch {
    throw new CollaborationCryptoError("device private key is invalid");
  }
}

export function generateRoomKey(): Uint8Array {
  return randomBytes(32);
}

export async function importRoomKey(rawKey: Uint8Array): Promise<CryptoKey> {
  assertRoomKeyBytes(rawKey);
  return await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(rawKey),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealRoomKey(
  roomKey: Uint8Array,
  recipientPublicKey: DevicePublicKey,
  context: RoomKeyEnvelopeContext,
): Promise<RoomKeyEnvelope> {
  assertRoomKeyBytes(roomKey);
  validateEnvelopeContext(context);
  const recipientKey = await importDevicePublicKey(recipientPublicKey);
  const ephemeral = await generateDeviceKeyPair();
  const ephemeralPublicKey = await exportDevicePublicKey(ephemeral.publicKey);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const wrappingKey = await deriveWrappingKey(
    ephemeral.privateKey,
    recipientKey,
    salt,
    envelopeKdfInfo(context),
    ["encrypt"],
  );
  const metadata = envelopeAssociatedData(context, ephemeralPublicKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(metadata), tagLength: 128 },
    wrappingKey,
    toArrayBuffer(roomKey),
  );
  return {
    version: 1,
    algorithm: ROOM_KEY_ENVELOPE_ALGORITHM,
    ...context,
    ephemeralPublicKey,
    salt: encodeBase64Url(salt),
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function openRoomKey(
  envelope: RoomKeyEnvelope,
  recipientPrivateKey: CryptoKey,
  expected: RoomKeyEnvelopeContext,
): Promise<Uint8Array> {
  validateEnvelope(envelope);
  validateEnvelopeContext(expected);
  if (
    envelope.roomId !== expected.roomId ||
    envelope.keyEpoch !== expected.keyEpoch ||
    envelope.recipientDeviceId !== expected.recipientDeviceId
  ) {
    throw new CollaborationCryptoError("room key envelope context does not match");
  }
  assertEcKey(recipientPrivateKey, "private");
  const ephemeralPublicKey = await importDevicePublicKey(envelope.ephemeralPublicKey);
  const salt = decodeBase64Url(envelope.salt, 16, "room key envelope salt");
  const nonce = decodeBase64Url(envelope.nonce, 12, "room key envelope nonce");
  const ciphertext = decodeBase64Url(
    envelope.ciphertext,
    48,
    "room key envelope ciphertext",
  );
  const wrappingKey = await deriveWrappingKey(
    recipientPrivateKey,
    ephemeralPublicKey,
    salt,
    envelopeKdfInfo(expected),
    ["decrypt"],
  );
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(
          envelopeAssociatedData(expected, envelope.ephemeralPublicKey),
        ),
        tagLength: 128,
      },
      wrappingKey,
      toArrayBuffer(ciphertext),
    );
    const roomKey = new Uint8Array(plaintext);
    assertRoomKeyBytes(roomKey);
    return roomKey;
  } catch {
    throw new CollaborationCryptoError("room key envelope authentication failed");
  }
}

export async function encryptRoomEvent(
  roomKey: CryptoKey,
  header: RoomEventHeader,
  plaintext: Uint8Array | string,
): Promise<EncryptedEventMessage> {
  assertRoomCryptoKey(roomKey, "encrypt");
  validateEventHeader(header);
  const nonce = randomBytes(12);
  const bytes = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(eventAssociatedData(header)),
      tagLength: 128,
    },
    roomKey,
    toArrayBuffer(bytes),
  );
  return {
    type: "encrypted.event",
    version: 1,
    algorithm: EVENT_ENCRYPTION_ALGORITHM,
    ...header,
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptRoomEvent(
  roomKey: CryptoKey,
  event: EncryptedEventMessage,
  replayProtector?: ReplayProtector,
): Promise<Uint8Array> {
  assertRoomCryptoKey(roomKey, "decrypt");
  validateEventHeader(event);
  if (event.version !== 1 || event.algorithm !== EVENT_ENCRYPTION_ALGORITHM) {
    throw new CollaborationCryptoError("unsupported event encryption format");
  }
  const nonce = decodeBase64Url(event.nonce, 12, "event nonce");
  const ciphertext = decodeBase64Url(event.ciphertext, undefined, "event ciphertext");
  if (ciphertext.byteLength < 16) throw new CollaborationCryptoError("event ciphertext is invalid");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(eventAssociatedData(event)),
        tagLength: 128,
      },
      roomKey,
      toArrayBuffer(ciphertext),
    );
    replayProtector?.accept(event);
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    throw new CollaborationCryptoError("event authentication failed");
  }
}

export function decodeEventText(plaintext: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

export class ReplayProtector {
  private readonly lastSequences = new Map<string, number>();
  private readonly eventIds = new Set<string>();
  private readonly eventOrder: string[] = [];

  constructor(private readonly maxEventIds = 10_000) {
    if (!Number.isSafeInteger(maxEventIds) || maxEventIds < 1) {
      throw new RangeError("maxEventIds must be a positive integer");
    }
  }

  accept(event: EncryptedEventMessage): void {
    if (this.eventIds.has(event.eventId)) throw new ReplayError("event was already processed");
    const stream = [
      event.roomId,
      event.keyEpoch,
      event.senderDeviceId,
      event.kind,
      event.terminalId ?? "",
    ].join("\u001f");
    const lastSequence = this.lastSequences.get(stream);
    if (lastSequence !== undefined && event.senderSequence <= lastSequence) {
      throw new ReplayError("event sequence is not newer than the last processed event");
    }
    this.lastSequences.set(stream, event.senderSequence);
    this.eventIds.add(event.eventId);
    this.eventOrder.push(event.eventId);
    if (this.eventOrder.length > this.maxEventIds) {
      this.eventIds.delete(this.eventOrder.shift()!);
    }
  }
}

export class CollaborationCryptoError extends Error {}
export class ReplayError extends CollaborationCryptoError {}

export function parseDevicePublicKey(value: unknown): DevicePublicKey {
  if (!isRecord(value)) throw new CollaborationCryptoError("device public key is invalid");
  const publicKey = {
    algorithm: value.algorithm,
    x: value.x,
    y: value.y,
  } as DevicePublicKey;
  validateDevicePublicKey(publicKey);
  return publicKey;
}

export function parseRoomKeyEnvelope(value: unknown): RoomKeyEnvelope {
  if (!isRecord(value) || !isRecord(value.ephemeralPublicKey)) {
    throw new CollaborationCryptoError("room key envelope is invalid");
  }
  const envelope = {
    version: value.version,
    algorithm: value.algorithm,
    roomId: value.roomId,
    keyEpoch: value.keyEpoch,
    recipientDeviceId: value.recipientDeviceId,
    ephemeralPublicKey: parseDevicePublicKey(value.ephemeralPublicKey),
    salt: value.salt,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
  } as RoomKeyEnvelope;
  validateEnvelope(envelope);
  decodeBase64Url(envelope.salt, 16, "room key envelope salt");
  decodeBase64Url(envelope.nonce, 12, "room key envelope nonce");
  decodeBase64Url(envelope.ciphertext, 48, "room key envelope ciphertext");
  return envelope;
}

export async function importDevicePublicKey(publicKey: DevicePublicKey): Promise<CryptoKey> {
  validateDevicePublicKey(publicKey);
  try {
    return await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: publicKey.x,
        y: publicKey.y,
        ext: true,
        key_ops: [],
      },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    throw new CollaborationCryptoError("device public key is invalid");
  }
}

async function deriveWrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array,
  info: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256),
  );
  try {
    const hkdfKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(sharedBits),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: toArrayBuffer(salt),
        info: toArrayBuffer(info),
      },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      usages,
    );
  } finally {
    sharedBits.fill(0);
  }
}

function envelopeKdfInfo(context: RoomKeyEnvelopeContext): Uint8Array {
  return encodeCanonical([
    "luma.collaboration.room-key.kdf",
    1,
    ROOM_KEY_ENVELOPE_ALGORITHM,
    context.roomId,
    context.keyEpoch,
    context.recipientDeviceId,
  ]);
}

function envelopeAssociatedData(
  context: RoomKeyEnvelopeContext,
  ephemeralPublicKey: DevicePublicKey,
): Uint8Array {
  return encodeCanonical([
    "luma.collaboration.room-key.envelope",
    1,
    ROOM_KEY_ENVELOPE_ALGORITHM,
    context.roomId,
    context.keyEpoch,
    context.recipientDeviceId,
    ephemeralPublicKey.algorithm,
    ephemeralPublicKey.x,
    ephemeralPublicKey.y,
  ]);
}

function eventAssociatedData(header: RoomEventHeader): Uint8Array {
  return encodeCanonical([
    "luma.collaboration.event",
    1,
    EVENT_ENCRYPTION_ALGORITHM,
    header.roomId,
    header.eventId,
    header.kind,
    header.terminalId ?? null,
    header.senderDeviceId,
    header.senderSequence,
    header.keyEpoch,
  ]);
}

function encodeCanonical(values: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(values));
}

function validateDevicePublicKey(value: DevicePublicKey): void {
  if (
    value.algorithm !== DEVICE_KEY_ALGORITHM ||
    typeof value.x !== "string" ||
    typeof value.y !== "string"
  ) {
    throw new CollaborationCryptoError("unsupported device public key algorithm");
  }
  decodeBase64Url(value.x, 32, "device public key x-coordinate");
  decodeBase64Url(value.y, 32, "device public key y-coordinate");
}

function validateEnvelope(envelope: RoomKeyEnvelope): void {
  if (envelope.version !== 1 || envelope.algorithm !== ROOM_KEY_ENVELOPE_ALGORITHM) {
    throw new CollaborationCryptoError("unsupported room key envelope format");
  }
  validateEnvelopeContext(envelope);
  validateDevicePublicKey(envelope.ephemeralPublicKey);
}

function validateEnvelopeContext(context: RoomKeyEnvelopeContext): void {
  validateUuid(context.roomId, "roomId");
  validateIdentifier(context.recipientDeviceId, "recipientDeviceId");
  if (!Number.isSafeInteger(context.keyEpoch) || context.keyEpoch < 1) {
    throw new CollaborationCryptoError("keyEpoch must be a positive integer");
  }
}

function validateEventHeader(header: RoomEventHeader): void {
  validateUuid(header.roomId, "roomId");
  validateUuid(header.eventId, "eventId");
  validateIdentifier(header.senderDeviceId, "senderDeviceId");
  if (header.terminalId !== undefined) validateIdentifier(header.terminalId, "terminalId");
  if (!Number.isSafeInteger(header.senderSequence) || header.senderSequence < 0) {
    throw new CollaborationCryptoError("senderSequence must be a non-negative integer");
  }
  if (!Number.isSafeInteger(header.keyEpoch) || header.keyEpoch < 1) {
    throw new CollaborationCryptoError("keyEpoch must be a positive integer");
  }
}

function assertRoomKeyBytes(roomKey: Uint8Array): void {
  if (!(roomKey instanceof Uint8Array) || roomKey.byteLength !== 32) {
    throw new CollaborationCryptoError("room key must contain 32 bytes");
  }
}

function assertRoomCryptoKey(key: CryptoKey, usage: KeyUsage): void {
  if (key.algorithm.name !== "AES-GCM" || !key.usages.includes(usage)) {
    throw new CollaborationCryptoError(`room key cannot ${usage} events`);
  }
}

function assertEcKey(key: CryptoKey, type: KeyType): void {
  if (key.type !== type || key.algorithm.name !== "ECDH") {
    throw new CollaborationCryptoError(`device ${type} key is invalid`);
  }
}

function validateUuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CollaborationCryptoError(`${name} must be a UUID`);
  }
}

function validateIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new CollaborationCryptoError(`${name} is invalid`);
  }
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string, expectedLength: number | undefined, name: string): Uint8Array {
  if (!BASE64URL.test(value)) throw new CollaborationCryptoError(`${name} is not base64url encoded`);
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new CollaborationCryptoError(`${name} is not base64url encoded`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    throw new CollaborationCryptoError(`${name} has an invalid length`);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/u;
