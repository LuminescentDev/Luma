import { invoke } from "@tauri-apps/api/core";
import type {
  DevicePublicKey,
  RoomKeyEnvelope,
  SerializedDevicePrivateKey,
} from "@luma/collaboration-encryption";
import type {
  EncryptedEventMessage,
  RoomRole,
} from "@luma/collaboration-protocol";

/*
 * Typed invoke wrappers for the collaborative-terminals backend. This module is
 * the source of truth for the frontend-facing collaboration types. All fields
 * are camelCase. Commands with an `input` parameter are invoked as
 * `invoke("collab_x", { input: { ... } })`; the rest use `{}`.
 *
 * SECURITY: private key material and access tokens never flow OUT of these
 * calls. `collab_get_device_identity` returns the stored serialized private key
 * only so the non-React client can import it into a non-extractable CryptoKey;
 * it is never logged or held in React state.
 */

export type { DevicePublicKey, RoomKeyEnvelope, SerializedDevicePrivateKey };
export type { RoomRole };

export type DeviceIdentity = {
  deviceId: string;
  publicKey: DevicePublicKey;
  privateKey: SerializedDevicePrivateKey;
};

export type DeviceKeyEnvelope = {
  deviceId: string;
  envelope: RoomKeyEnvelope;
};

export type RegisteredDevice = {
  deviceId: string;
  publicKey: DevicePublicKey;
};

export type InvitedRoomRole = "controller" | "viewer";

/** Error code contract for every rejected collaboration command. */
export type CollaborationErrorCode =
  | "invalid-input"
  | "auth-required"
  | "auth-denied"
  | "auth-expired"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "precondition-failed"
  | "payload-too-large"
  | "unsupported-media-type"
  | "precondition-required"
  | "rate-limited"
  | "network"
  | "server-unavailable"
  | "invalid-response"
  | "storage";

export type CollaborationError = {
  code: CollaborationErrorCode;
  message: string;
  httpStatus: number | null;
};

export type CollabConfig = { serverUrl: string };

export type CollabAuthStart = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
  expiresAt: number;
};

export type CollabAuthPoll = {
  status: "pending" | "complete";
  retryAfterSeconds: number | null;
};

export type CollabAuthStatusValue = "signedOut" | "pending" | "signedIn" | "expired";

export type CollabAuthStatus = {
  status: CollabAuthStatusValue;
  serverUrl: string;
  expiresAt: number | null;
};

export type CreateRoomResult = {
  roomId: string;
  memberId: string;
  keyEpoch: number;
};

export type AddRoomMemberResult = {
  memberId: string;
  keyEpoch: number;
};

export type RoomDetails = {
  roomId: string;
  memberId: string;
  role: RoomRole;
  keyEpoch: number;
  keyEnvelope: RoomKeyEnvelope;
};

export type RealtimeTicket = {
  ticket: string;
  expiresIn: number;
  realtimeUrl: string;
};

export type RoomSnapshot = {
  dataBase64: string;
  contentType: string;
  etag: string;
};

export type PutSnapshotResult = { etag: string };

export type CollabInvite = {
  version: 1;
  serverUrl: string;
  subject: string;
  devices: RegisteredDevice[];
  issuedAt: number;
};

export type CreateInviteResult = {
  token: string;
  invite: CollabInvite;
};

// Realtime WebSocket server → client messages (frontend owns the socket). ------

export type PresenceJoined = {
  type: "presence.joined";
  memberId: string;
  connectionId: string;
  roomSequence: number;
};
export type PresenceLeft = {
  type: "presence.left";
  memberId: string;
  connectionId: string;
  roomSequence: number;
};
export type PresenceFocus = {
  type: "presence.focus";
  memberId: string;
  connectionId: string;
  terminalId: string | null;
  roomSequence: number;
};
export type ControlState = {
  type: "control.state";
  terminalId: string;
  memberId: string | null;
  connectionId: string | null;
  acquired: boolean;
  roomSequence: number;
};
export type RoomKeyEpoch = {
  type: "room.key-epoch";
  keyEpoch: number;
  roomSequence: number;
};
export type HistoryComplete = {
  type: "history.complete";
  afterSequence: number;
  returned: number;
  truncated: boolean;
};
export type RealtimeError = { type: "error"; error: string };
export type BroadcastEncryptedEvent = EncryptedEventMessage & {
  memberId: string;
  connectionId: string;
  roomSequence: number;
};

export type ServerMessage =
  | PresenceJoined
  | PresenceLeft
  | PresenceFocus
  | ControlState
  | RoomKeyEpoch
  | HistoryComplete
  | RealtimeError
  | BroadcastEncryptedEvent;

// Config / auth --------------------------------------------------------------

export function collabGetConfig(): Promise<CollabConfig> {
  return invoke<CollabConfig>("collab_get_config", {});
}

export function collabSetServerUrl(serverUrl: string): Promise<CollabConfig> {
  return invoke<CollabConfig>("collab_set_server_url", { input: { serverUrl } });
}

export function collabAuthStart(): Promise<CollabAuthStart> {
  return invoke<CollabAuthStart>("collab_auth_start", {});
}

export function collabAuthPoll(): Promise<CollabAuthPoll> {
  return invoke<CollabAuthPoll>("collab_auth_poll", {});
}

export function collabAuthStatus(): Promise<CollabAuthStatus> {
  return invoke<CollabAuthStatus>("collab_auth_status", {});
}

export function collabAuthSignOut(): Promise<null> {
  return invoke<null>("collab_auth_sign_out", {});
}

// Device identity ------------------------------------------------------------

export function collabGetDeviceIdentity(): Promise<DeviceIdentity | null> {
  return invoke<DeviceIdentity | null>("collab_get_device_identity", {});
}

export function collabSetDeviceIdentity(identity: DeviceIdentity): Promise<null> {
  return invoke<null>("collab_set_device_identity", {
    input: {
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
    },
  });
}

export function collabRegisterDevice(
  deviceId: string,
  publicKey: DevicePublicKey,
): Promise<null> {
  return invoke<null>("collab_register_device", {
    input: { deviceId, publicKey },
  });
}

export function collabListDevices(): Promise<{ devices: RegisteredDevice[] }> {
  return invoke<{ devices: RegisteredDevice[] }>("collab_list_devices", {});
}

// Rooms ----------------------------------------------------------------------

export function collabCreateRoom(
  roomId: string,
  deviceKeys: DeviceKeyEnvelope[],
): Promise<CreateRoomResult> {
  return invoke<CreateRoomResult>("collab_create_room", {
    input: { roomId, deviceKeys },
  });
}

export function collabAddRoomMember(
  roomId: string,
  subject: string,
  role: InvitedRoomRole,
  deviceKeys: DeviceKeyEnvelope[],
): Promise<AddRoomMemberResult> {
  return invoke<AddRoomMemberResult>("collab_add_room_member", {
    input: { roomId, subject, role, deviceKeys },
  });
}

export function collabGetRoom(roomId: string, deviceId: string): Promise<RoomDetails> {
  return invoke<RoomDetails>("collab_get_room", { input: { roomId, deviceId } });
}

export function collabIssueRealtimeTicket(
  roomId: string,
  deviceId: string,
): Promise<RealtimeTicket> {
  return invoke<RealtimeTicket>("collab_issue_realtime_ticket", {
    input: { roomId, deviceId },
  });
}

export function collabRotateRoomKey(
  roomId: string,
  keyEpoch: number,
  deviceKeys: DeviceKeyEnvelope[],
): Promise<null> {
  return invoke<null>("collab_rotate_room_key", {
    input: { roomId, keyEpoch, deviceKeys },
  });
}

export function collabGetSnapshot(roomId: string): Promise<RoomSnapshot> {
  return invoke<RoomSnapshot>("collab_get_snapshot", { input: { roomId } });
}

export function collabPutSnapshot(
  roomId: string,
  dataBase64: string,
  expectedEtag: string | null,
): Promise<PutSnapshotResult> {
  return invoke<PutSnapshotResult>("collab_put_snapshot", {
    input: { roomId, dataBase64, expectedEtag },
  });
}

// Invites --------------------------------------------------------------------

export function collabCreateInvite(): Promise<CreateInviteResult> {
  return invoke<CreateInviteResult>("collab_create_invite", {});
}

export function collabParseInvite(token: string): Promise<CollabInvite> {
  return invoke<CollabInvite>("collab_parse_invite", { input: { token } });
}

// Capability join links ------------------------------------------------------

export type MintRoomCapabilityResult = {
  capabilityId: string;
  secret: string;
  keyEpoch: number;
  expiresAt: string;
};

export type JoinRoomWithCapabilityResult = {
  memberId: string;
  role: RoomRole;
  keyEpoch: number;
};

/**
 * Decoded contents of a `luma://join?t=…` capability link. `roomKey` is the
 * standard-base64 encoding of the raw 32-byte room key and `secret` is the
 * one-time capability secret — this object is sensitive and must never be
 * persisted, placed in React state, or logged.
 */
export type JoinLinkPayload = {
  v: 1;
  serverUrl: string;
  roomId: string;
  role: InvitedRoomRole;
  keyEpoch: number;
  secret: string;
  roomKey: string;
};

const JOIN_TOKEN_PREFIX = "luma-collab-join-v1.";

export function collabMintRoomCapability(
  roomId: string,
  role: InvitedRoomRole,
  ttlSeconds?: number,
): Promise<MintRoomCapabilityResult> {
  return invoke<MintRoomCapabilityResult>("collab_mint_room_capability", {
    input: { roomId, role, ttlSeconds },
  });
}

export function collabJoinRoomWithCapability(
  roomId: string,
  secret: string,
  deviceId: string,
  keyEnvelope: RoomKeyEnvelope,
): Promise<JoinRoomWithCapabilityResult> {
  return invoke<JoinRoomWithCapabilityResult>("collab_join_room_with_capability", {
    input: { roomId, secret, deviceId, keyEnvelope },
  });
}

/** Encode a join-link payload into its `luma-collab-join-v1.<base64url>` token. */
export function buildJoinToken(payload: JoinLinkPayload): string {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return JOIN_TOKEN_PREFIX + encodeBase64Url(json);
}

/** Parse and validate a capability join token, throwing a clear Error when it is
 * malformed, truncated, or targets an unsupported version. */
export function parseJoinToken(token: string): JoinLinkPayload {
  if (typeof token !== "string" || !token.startsWith(JOIN_TOKEN_PREFIX)) {
    throw new Error("This is not a Luma join link.");
  }
  let json: string;
  try {
    json = new TextDecoder().decode(
      decodeBase64Url(token.slice(JOIN_TOKEN_PREFIX.length)),
    );
  } catch {
    throw new Error("This join link is malformed.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("This join link is malformed.");
  }
  return validateJoinLinkPayload(raw);
}

function validateJoinLinkPayload(raw: unknown): JoinLinkPayload {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("This join link is malformed.");
  }
  const record = raw as Record<string, unknown>;
  if (record.v !== 1) {
    throw new Error("This join link uses an unsupported version.");
  }
  const { serverUrl, roomId, role, keyEpoch, secret, roomKey } = record;
  if (
    typeof serverUrl !== "string" ||
    serverUrl.length === 0 ||
    typeof roomId !== "string" ||
    roomId.length === 0 ||
    (role !== "controller" && role !== "viewer") ||
    typeof keyEpoch !== "number" ||
    !Number.isSafeInteger(keyEpoch) ||
    keyEpoch < 1 ||
    typeof secret !== "string" ||
    secret.length === 0 ||
    typeof roomKey !== "string" ||
    roomKey.length === 0
  ) {
    throw new Error("This join link is missing required information.");
  }
  return { v: 1, serverUrl, roomId, role, keyEpoch, secret, roomKey };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// Error handling -------------------------------------------------------------

/** Parse a rejected collaboration command into its `{ code, message, httpStatus }`
 * shape. Defensive against non-conforming rejections (plain strings, unexpected
 * objects) so callers always get a usable message. */
export function parseCollaborationError(error: unknown): CollaborationError {
  if (typeof error === "object" && error !== null) {
    const record = error as {
      code?: unknown;
      message?: unknown;
      httpStatus?: unknown;
    };
    if (typeof record.code === "string" && typeof record.message === "string") {
      return {
        code: record.code as CollaborationErrorCode,
        message: record.message,
        httpStatus:
          typeof record.httpStatus === "number" ? record.httpStatus : null,
      };
    }
    if (typeof record.message === "string") {
      return { code: "invalid-response", message: record.message, httpStatus: null };
    }
  }
  return { code: "invalid-response", message: String(error), httpStatus: null };
}

/** Human-facing label for an auth status value. */
export const COLLAB_AUTH_LABELS: Record<CollabAuthStatusValue, string> = {
  signedOut: "Signed out",
  pending: "Sign-in pending",
  signedIn: "Signed in",
  expired: "Session expired",
};
