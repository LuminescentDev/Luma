export const ROOM_ROLES = ["owner", "controller", "viewer"] as const;
export type RoomRole = (typeof ROOM_ROLES)[number];

export const ENCRYPTED_EVENT_KINDS = [
  "terminal.input",
  "terminal.output",
  "layout.operation",
  "room.snapshot",
] as const;
export type EncryptedEventKind = (typeof ENCRYPTED_EVENT_KINDS)[number];

export const EVENT_ENCRYPTION_ALGORITHM = "AES-256-GCM" as const;

export interface EncryptedEventMessage {
  type: "encrypted.event";
  version: 1;
  algorithm: typeof EVENT_ENCRYPTION_ALGORITHM;
  roomId: string;
  eventId: string;
  kind: EncryptedEventKind;
  terminalId?: string;
  senderDeviceId: string;
  senderSequence: number;
  keyEpoch: number;
  nonce: string;
  ciphertext: string;
}

export type ClientMessage =
  | EncryptedEventMessage
  | { type: "presence.focus"; terminalId: string | null }
  | { type: "presence.heartbeat" }
  | { type: "history.replay"; afterSequence: number }
  | { type: "control.acquire"; terminalId: string }
  | { type: "control.release"; terminalId: string };

export function parseClientMessage(data: string, maxBytes: number): ClientMessage {
  if (Buffer.byteLength(data) > maxBytes) throw new ProtocolError("message is too large");
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ProtocolError("message must be valid JSON");
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ProtocolError("message type is required");
  }

  if (value.type === "presence.heartbeat") return { type: value.type };
  if (value.type === "history.replay") {
    if (!Number.isSafeInteger(value.afterSequence) || (value.afterSequence as number) < 0) {
      throw new ProtocolError("afterSequence must be a non-negative integer");
    }
    return { type: value.type, afterSequence: value.afterSequence as number };
  }
  if (value.type === "presence.focus") {
    if (value.terminalId !== null) validateTerminalId(value.terminalId);
    return { type: value.type, terminalId: value.terminalId as string | null };
  }
  if (value.type === "control.acquire" || value.type === "control.release") {
    validateTerminalId(value.terminalId);
    return { type: value.type, terminalId: value.terminalId as string };
  }
  if (value.type === "encrypted.event") {
    if (value.version !== 1 || value.algorithm !== EVENT_ENCRYPTION_ALGORITHM) {
      throw new ProtocolError("unsupported event encryption format");
    }
    if (typeof value.roomId !== "string" || !UUID.test(value.roomId)) {
      throw new ProtocolError("roomId must be a UUID");
    }
    if (typeof value.eventId !== "string" || !UUID.test(value.eventId)) {
      throw new ProtocolError("eventId must be a UUID");
    }
    if (typeof value.kind !== "string" || !ENCRYPTED_EVENT_KINDS.includes(value.kind as EncryptedEventKind)) {
      throw new ProtocolError("unsupported encrypted event kind");
    }
    if (!Number.isSafeInteger(value.senderSequence) || (value.senderSequence as number) < 0) {
      throw new ProtocolError("senderSequence must be a non-negative integer");
    }
    if (!Number.isSafeInteger(value.keyEpoch) || (value.keyEpoch as number) < 1) {
      throw new ProtocolError("keyEpoch must be a positive integer");
    }
    validateIdentifier(value.senderDeviceId, "senderDeviceId");
    validateBase64UrlLength(value.nonce, 12, "nonce");
    if (typeof value.ciphertext !== "string" || !BASE64URL.test(value.ciphertext)) {
      throw new ProtocolError("ciphertext must be base64url encoded");
    }
    if (value.kind.startsWith("terminal.")) validateTerminalId(value.terminalId);
    else if (value.terminalId !== undefined) validateTerminalId(value.terminalId);
    return value as ClientMessage;
  }
  throw new ProtocolError("unsupported message type");
}

export function canPublish(role: RoomRole, kind: EncryptedEventKind): boolean {
  if (role === "viewer") return false;
  if (kind === "room.snapshot") return role === "owner";
  return true;
}

export class ProtocolError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function validateTerminalId(value: unknown): asserts value is string {
  validateIdentifier(value, "terminalId");
}

function validateIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new ProtocolError(`${name} is invalid`);
  }
}

function validateBase64UrlLength(value: unknown, length: number, name: string): asserts value is string {
  if (typeof value !== "string" || !BASE64URL.test(value)) {
    throw new ProtocolError(`${name} must be base64url encoded`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedLength = Math.floor((value.length * 3) / 4) - padding;
  if (decodedLength !== length) throw new ProtocolError(`${name} has an invalid length`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
