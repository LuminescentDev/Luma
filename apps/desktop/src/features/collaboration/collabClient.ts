import {
  encryptRoomEvent,
  decryptRoomEvent,
  generateRoomKey,
  importRoomKey,
  openRoomKey,
  sealRoomKey,
  ReplayProtector,
  ReplayError,
  type RoomKeyEnvelope,
} from "@luma/collaboration-encryption";
import type {
  ClientMessage,
  EncryptedEventKind,
  EncryptedEventMessage,
  RoomRole,
} from "@luma/collaboration-protocol";
import { canPublish } from "@luma/collaboration-protocol";
import {
  buildJoinToken,
  collabAddRoomMember,
  collabCreateRoom,
  collabGetConfig,
  collabGetRoom,
  collabGetSnapshot,
  collabIssueRealtimeTicket,
  collabJoinRoomWithCapability,
  collabListDevices,
  collabMintRoomCapability,
  collabParseInvite,
  collabPutSnapshot,
  parseCollaborationError,
  type BroadcastEncryptedEvent,
  type DeviceKeyEnvelope,
  type InvitedRoomRole,
  type JoinLinkPayload,
  type ServerMessage,
} from "../../lib/collab";
import { terminalManager } from "../terminal/terminalManager";
import { loadDeviceIdentity, registerDevice } from "./deviceIdentity";

/*
 * Non-React collaboration client. Owns the realtime WebSocket and every byte of
 * encryption/decryption, bridging directly to terminalManager's PTY/xterm
 * pipeline. Terminal bytes flow manager ↔ this module ↔ WebSocket and NEVER pass
 * through React state; React only observes the metadata snapshot published via
 * `setCollabObserver`.
 *
 * The room CryptoKey and the device private key are held here only; they are
 * never logged nor exposed to React.
 */

export type CollabConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "key-rotating"
  | "error";

export type CollabMode = "idle" | "hosting" | "viewing";

export type CollabParticipant = {
  connectionId: string;
  memberId: string;
  /** Known role, or null when this member's role was not assigned by us. */
  role: RoomRole | null;
  focusTerminalId: string | null;
};

export type CollabRuntimeState = {
  mode: CollabMode;
  status: CollabConnectionStatus;
  roomId: string | null;
  role: RoomRole | null;
  keyEpoch: number | null;
  selfMemberId: string | null;
  /** The terminal id of the single shared terminal, once known. */
  sharedTerminalId: string | null;
  /** Whether the local member currently holds the shared terminal's control lease. */
  holdsControl: boolean;
  participants: CollabParticipant[];
  /** terminalId → memberId currently holding its control lease (null = free). */
  control: Record<string, string | null>;
  errorMessage: string | null;
  /** Local terminal session associated with this room (host rooms only). */
  ownerSessionId: string | null;
};

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const SNAPSHOT_MAX_BYTES = 256 * 1024;
const SNAPSHOT_INTERVAL_MS = 5_000;
const VIEWER_DISPLAY_PREFIX = "collab-view:";

type Room = {
  mode: "hosting" | "viewing";
  roomId: string;
  deviceId: string;
  role: RoomRole;
  keyEpoch: number;
  memberId: string;
  roomKey: CryptoKey;
  /** Raw room key bytes retained by the owner to reseal on member add / rotation. */
  roomKeyBytes: Uint8Array | null;
  sharedTerminalId: string | null;
  /** Hosting only: the local backend session whose output is shared. */
  ownerSessionId: string | null;
  /** Viewing only: the local display-only xterm session id. */
  displaySessionId: string | null;

  ws: WebSocket | null;
  replay: ReplayProtector;
  senderSequence: number;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  snapshotTimer: ReturnType<typeof setInterval> | null;
  closing: boolean;
  lastRoomSequence: number;
  hasSeededOnce: boolean;
  renderedAnyOutput: boolean;

  participants: Map<string, CollabParticipant>;
  roleByMemberId: Map<string, RoomRole>;
  control: Map<string, string | null>;
  holdsControl: boolean;

  /** Owner rolling snapshot buffer (raw shared output, capped). */
  snapshotChunks: Uint8Array[];
  snapshotBytes: number;
  snapshotEtag: string | null;
  errorMessage: string | null;
  status: CollabConnectionStatus;
};

const rooms = new Map<string, Room>();
let viewingRoomId: string | null = null;
let observer: ((states: CollabRuntimeState[]) => void) | null = null;

export function setCollabObserver(fn: ((states: CollabRuntimeState[]) => void) | null): void {
  observer = fn;
}

const IDLE_STATE: CollabRuntimeState = {
  mode: "idle",
  status: "idle",
  roomId: null,
  role: null,
  keyEpoch: null,
  selfMemberId: null,
  sharedTerminalId: null,
  holdsControl: false,
  participants: [],
  control: {},
  errorMessage: null,
  ownerSessionId: null,
};

export function getCollabState(): CollabRuntimeState {
  const first = rooms.values().next().value as Room | undefined;
  return first ? snapshot(first) : { ...IDLE_STATE };
}

export function getCollabStates(): CollabRuntimeState[] {
  return [...rooms.values()].map(snapshot);
}

function snapshot(r: Room): CollabRuntimeState {
  return {
    mode: r.mode,
    status: r.status,
    roomId: r.roomId,
    role: r.role,
    keyEpoch: r.keyEpoch,
    selfMemberId: r.memberId,
    sharedTerminalId: r.sharedTerminalId,
    holdsControl: r.holdsControl,
    participants: [...r.participants.values()].map((p) => ({
      ...p,
      role: p.role ?? r.roleByMemberId.get(p.memberId) ?? null,
    })),
    control: Object.fromEntries(r.control),
    errorMessage: r.errorMessage,
    ownerSessionId: r.ownerSessionId,
  };
}

function notify(): void {
  observer?.(getCollabStates());
}

function setStatus(r: Room, status: CollabConnectionStatus): void {
  r.status = status;
  notify();
}

// Base64 (standard) helpers for the opaque snapshot blob. The encrypted snapshot
// is an ASCII JSON string, so btoa/atob round-trip it directly.
function toBase64(ascii: string): string {
  return btoa(ascii);
}
function fromBase64(value: string): string {
  return atob(value);
}

function nextSequence(r: Room): number {
  const seq = r.senderSequence;
  r.senderSequence += 1;
  return seq;
}

function send(r: Room, message: ClientMessage): void {
  if (r.ws && r.ws.readyState === WebSocket.OPEN) {
    r.ws.send(JSON.stringify(message));
  }
}

async function encryptAndSend(
  r: Room,
  kind: EncryptedEventKind,
  plaintext: Uint8Array | string,
  terminalId: string | undefined,
): Promise<void> {
  if (!canPublish(r.role, kind)) return;
  const message = await encryptRoomEvent(
    r.roomKey,
    {
      roomId: r.roomId,
      eventId: crypto.randomUUID(),
      kind,
      terminalId,
      senderDeviceId: r.deviceId,
      senderSequence: nextSequence(r),
      keyEpoch: r.keyEpoch,
    },
    plaintext,
  );
  send(r, message);
}

// -- Device-key sealing helpers ---------------------------------------------

async function sealToDevices(
  roomKeyBytes: Uint8Array,
  roomId: string,
  keyEpoch: number,
  devices: { deviceId: string; publicKey: RoomKeyEnvelope["ephemeralPublicKey"] }[],
): Promise<DeviceKeyEnvelope[]> {
  const envelopes: DeviceKeyEnvelope[] = [];
  for (const device of devices) {
    const envelope = await sealRoomKey(roomKeyBytes, device.publicKey, {
      roomId,
      keyEpoch,
      recipientDeviceId: device.deviceId,
    });
    envelopes.push({ deviceId: device.deviceId, envelope });
  }
  return envelopes;
}

// -- Owner: start / stop sharing --------------------------------------------

/**
 * Share a live local/SSH terminal: create a room sealed to the owner's own
 * devices, tap the session's output byte stream, and broadcast it as encrypted
 * `terminal.output` events. Returns the room id to share out-of-band.
 */
export async function startSharing(sessionId: string): Promise<{ roomId: string }> {
  const existing = [...rooms.values()].find((candidate) => candidate.ownerSessionId === sessionId);
  if (existing) return { roomId: existing.roomId };
  if (!terminalManager.isKnown(sessionId)) {
    throw new Error("This terminal is no longer available to share.");
  }
  const identity = await registerDevice();
  const roomKeyBytes = generateRoomKey();
  const roomId = crypto.randomUUID();
  const keyEpoch = 1;

  const { devices } = await collabListDevices();
  const deviceKeys = await sealToDevices(roomKeyBytes, roomId, keyEpoch, devices);
  const created = await collabCreateRoom(roomId, deviceKeys);
  const roomKey = await importRoomKey(roomKeyBytes);
  const sharedTerminalId = crypto.randomUUID();

  const room = newRoom({
    mode: "hosting",
    roomId,
    deviceId: identity.deviceId,
    role: "owner",
    keyEpoch: created.keyEpoch,
    memberId: created.memberId,
    roomKey,
    roomKeyBytes,
    sharedTerminalId,
    ownerSessionId: sessionId,
    displaySessionId: null,
  });
  rooms.set(roomId, room);
  room.roleByMemberId.set(created.memberId, "owner");

  // Tap output bytes → encrypt → broadcast, and accumulate the rolling snapshot.
  terminalManager.setOutputTap(sessionId, (bytes) => {
    if (rooms.get(roomId) !== room) return;
    appendSnapshot(room, bytes);
    void encryptAndSend(room, "terminal.output", bytes, sharedTerminalId).catch(() => {});
  });

  await connect(room);
  startSnapshotLoop(room);
  return { roomId };
}

/** Stop sharing and tear down the room (owner). */
export async function stopSharing(): Promise<void> {
  const hosted = [...rooms.values()].find((candidate) => candidate.mode === "hosting");
  if (hosted) await leaveRoom(hosted.roomId);
}

export async function stopSharingRoom(roomId: string): Promise<void> {
  const target = rooms.get(roomId);
  if (target?.mode === "hosting") await leaveRoom(roomId);
}

// -- Owner: add a participant from their invite token -----------------------

/**
 * Complete the owner side of the invite handshake: parse the invitee's token,
 * verify it targets this server, seal the current room key to every device in
 * the invite, and register the member with the chosen role.
 */
export async function addParticipant(
  token: string,
  role: InvitedRoomRole,
  roomId?: string,
): Promise<void> {
  const room = roomId ? rooms.get(roomId) : [...rooms.values()].find((r) => r.mode === "hosting");
  if (!room || room.mode !== "hosting" || !room.roomKeyBytes) {
    throw new Error("Start sharing a terminal before adding participants.");
  }
  const invite = await collabParseInvite(token);
  const config = await collabGetConfig();
  if (invite.serverUrl !== config.serverUrl) {
    throw new Error(
      "This invite targets a different collaboration server than the one you are signed in to.",
    );
  }
  const deviceKeys = await sealToDevices(
    room.roomKeyBytes,
    room.roomId,
    room.keyEpoch,
    invite.devices,
  );
  const result = await collabAddRoomMember(room.roomId, invite.subject, role, deviceKeys);
  room.roleByMemberId.set(result.memberId, role);
  notify();
}

// -- Capability join links --------------------------------------------------

function roomKeyToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function roomKeyFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Owner: mint a single-use capability for the active hosting room and encode it,
 * together with the raw room key, into a `luma://join?t=…` deep link. The raw
 * room key stays inside this module except within the returned link, which the
 * caller shows once for the owner to hand out over a trusted channel.
 */
export async function createJoinLink(role: InvitedRoomRole, roomId?: string): Promise<string> {
  const room = roomId ? rooms.get(roomId) : [...rooms.values()].find((r) => r.mode === "hosting");
  if (!room || room.mode !== "hosting" || !room.roomKeyBytes) {
    throw new Error("Start sharing a terminal before creating a join link.");
  }
  const capability = await collabMintRoomCapability(room.roomId, role);
  const config = await collabGetConfig();
  const payload: JoinLinkPayload = {
    v: 1,
    serverUrl: config.serverUrl,
    roomId: room.roomId,
    role,
    keyEpoch: room.keyEpoch,
    secret: capability.secret,
    roomKey: roomKeyToBase64(room.roomKeyBytes),
  };
  return `luma://join?t=${buildJoinToken(payload)}`;
}

/**
 * Viewer: redeem a capability join link. Register this device, seal the link's
 * room key to it, redeem the capability so the server stores that envelope, then
 * reuse the standard viewer join path to fetch the envelope and connect.
 */
export async function joinRoomByCapability(payload: JoinLinkPayload): Promise<void> {
  const identity = await registerDevice();
  const roomKeyBytes = roomKeyFromBase64(payload.roomKey);
  try {
    const envelope = await sealRoomKey(roomKeyBytes, identity.publicKey, {
      roomId: payload.roomId,
      keyEpoch: payload.keyEpoch,
      recipientDeviceId: identity.deviceId,
    });
    await collabJoinRoomWithCapability(
      payload.roomId,
      payload.secret,
      identity.deviceId,
      envelope,
    );
  } finally {
    roomKeyBytes.fill(0);
  }
  await joinRoom(payload.roomId);
}

// -- Viewer: join a shared room ---------------------------------------------

/**
 * Join a room the owner has already added this device to: open the room key,
 * connect the realtime socket, and render decrypted output into a display-only
 * xterm (viewer/controller). Call `attachViewer` to mount it.
 */
export async function joinRoom(roomId: string): Promise<void> {
  if (viewingRoomId) await leaveRoom(viewingRoomId);
  const identity = await registerDevice();
  const details = await collabGetRoom(roomId, identity.deviceId);
  const roomKeyBytes = await openRoomKey(details.keyEnvelope, identity.privateKey, {
    roomId,
    keyEpoch: details.keyEpoch,
    recipientDeviceId: identity.deviceId,
  });
  const roomKey = await importRoomKey(roomKeyBytes);
  const displaySessionId = `${VIEWER_DISPLAY_PREFIX}${roomId}`;

  const room = newRoom({
    mode: "viewing",
    roomId,
    deviceId: identity.deviceId,
    role: details.role,
    keyEpoch: details.keyEpoch,
    memberId: details.memberId,
    roomKey,
    roomKeyBytes: null,
    sharedTerminalId: null,
    ownerSessionId: null,
    displaySessionId,
  });
  rooms.set(roomId, room);
  viewingRoomId = roomId;
  room.roleByMemberId.set(details.memberId, details.role);

  terminalManager.createDisplaySession(displaySessionId, {
    onInput: undefined, // read-only until control is granted (see applyControlLease)
  });

  await connect(room);
}

/** Leave the current room (viewer or owner) and release every resource. */
export async function leaveRoom(roomId?: string): Promise<void> {
  const targetId = roomId ?? viewingRoomId ?? rooms.keys().next().value;
  const r = targetId ? rooms.get(targetId) : undefined;
  if (!r) return;
  r.closing = true;
  clearTimers(r);
  if (r.ownerSessionId) terminalManager.clearOutputTap(r.ownerSessionId);
  if (r.displaySessionId) terminalManager.dispose(r.displaySessionId);
  if (r.ws) {
    try {
      r.ws.close(1000, "leaving");
    } catch {
      // ignore
    }
  }
  rooms.delete(r.roomId);
  if (viewingRoomId === r.roomId) viewingRoomId = null;
  notify();
}

// -- Viewer terminal attach / control ---------------------------------------

/** The local xterm session id for the shared viewer terminal, or null. */
export function viewerDisplaySessionId(): string | null {
  return viewingRoomId ? rooms.get(viewingRoomId)?.displaySessionId ?? null : null;
}

export function attachViewer(host: HTMLElement): void {
  const room = viewingRoomId ? rooms.get(viewingRoomId) : null;
  if (room?.displaySessionId) terminalManager.attach(room.displaySessionId, host);
}

export function detachViewer(): void {
  const room = viewingRoomId ? rooms.get(viewingRoomId) : null;
  if (room?.displaySessionId) terminalManager.detach(room.displaySessionId);
}

/** Request the shared terminal's control lease (controller role only). */
export function requestControl(): void {
  const room = viewingRoomId ? rooms.get(viewingRoomId) : null;
  if (!room || room.role !== "controller" || !room.sharedTerminalId) return;
  send(room, { type: "control.acquire", terminalId: room.sharedTerminalId });
}

/** Release the control lease held by this connection. */
export function releaseControl(): void {
  const room = viewingRoomId ? rooms.get(viewingRoomId) : null;
  if (!room || !room.sharedTerminalId) return;
  send(room, { type: "control.release", terminalId: room.sharedTerminalId });
}

// -- Connection lifecycle ----------------------------------------------------

async function connect(r: Room): Promise<void> {
  setStatus(r, r.reconnectAttempt > 0 ? "reconnecting" : "connecting");
  let ticket: { realtimeUrl: string };
  try {
    ticket = await collabIssueRealtimeTicket(r.roomId, r.deviceId);
  } catch (error) {
    if (rooms.get(r.roomId) !== r) return;
    r.errorMessage = parseCollaborationError(error).message;
    setStatus(r, "error");
    scheduleReconnect(r);
    return;
  }
  if (rooms.get(r.roomId) !== r || r.closing) return;

  const ws = new WebSocket(ticket.realtimeUrl);
  r.ws = ws;
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    if (rooms.get(r.roomId) !== r) return;
    r.reconnectAttempt = 0;
    setStatus(r, "connected");
    startHeartbeat(r);
    if (r.mode === "hosting" && r.sharedTerminalId) {
      // Advertise the shared terminal id so viewers can learn it immediately.
      send(r, { type: "presence.focus", terminalId: r.sharedTerminalId });
    }
    if (r.mode === "viewing") beginSeeding(r);
  };

  ws.onmessage = (event) => {
    if (rooms.get(r.roomId) !== r || typeof event.data !== "string") return;
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data) as ServerMessage;
    } catch {
      return;
    }
    void handleServerMessage(r, message);
  };

  ws.onclose = (event) => {
    if (rooms.get(r.roomId) !== r) return;
    stopHeartbeat(r);
    r.ws = null;
    if (r.closing) return;
    if (event.code === 4003) {
      // Room key rotated: fetch the new envelope/key and reconnect fresh.
      setStatus(r, "key-rotating");
      void rekeyAndReconnect(r);
      return;
    }
    // 1012 (restart), 1011 (internal), or any abnormal close → backoff reconnect.
    scheduleReconnect(r);
  };

  ws.onerror = () => {
    // The close handler drives reconnection; errors here are informational.
  };
}

async function rekeyAndReconnect(r: Room): Promise<void> {
  try {
    const identity = await loadDeviceIdentity();
    const details = await collabGetRoom(r.roomId, r.deviceId);
    const roomKeyBytes = await openRoomKey(details.keyEnvelope, identity.privateKey, {
      roomId: r.roomId,
      keyEpoch: details.keyEpoch,
      recipientDeviceId: r.deviceId,
    });
    if (rooms.get(r.roomId) !== r) return;
    r.roomKey = await importRoomKey(roomKeyBytes);
    r.roomKeyBytes = r.mode === "hosting" ? roomKeyBytes : null;
    r.keyEpoch = details.keyEpoch;
    r.role = details.role;
    // A new epoch is a fresh replay stream; reset protection.
    r.replay = new ReplayProtector();
    notify();
    await connect(r);
  } catch (error) {
    if (rooms.get(r.roomId) !== r) return;
    r.errorMessage = parseCollaborationError(error).message;
    setStatus(r, "error");
    scheduleReconnect(r);
  }
}

function scheduleReconnect(r: Room): void {
  if (r.closing || rooms.get(r.roomId) !== r) return;
  r.reconnectAttempt += 1;
  setStatus(r, "reconnecting");
  const delay = Math.min(
    MAX_RECONNECT_DELAY_MS,
    1000 * 2 ** (r.reconnectAttempt - 1),
  );
  const jitter = Math.floor(Math.random() * 400);
  if (r.reconnectTimer) clearTimeout(r.reconnectTimer);
  r.reconnectTimer = setTimeout(() => {
    r.reconnectTimer = null;
    if (rooms.get(r.roomId) === r && !r.closing) void connect(r);
  }, delay + jitter);
}

function startHeartbeat(r: Room): void {
  stopHeartbeat(r);
  r.heartbeatTimer = setInterval(() => {
    send(r, { type: "presence.heartbeat" });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(r: Room): void {
  if (r.heartbeatTimer) {
    clearInterval(r.heartbeatTimer);
    r.heartbeatTimer = null;
  }
}

function clearTimers(r: Room): void {
  stopHeartbeat(r);
  if (r.reconnectTimer) {
    clearTimeout(r.reconnectTimer);
    r.reconnectTimer = null;
  }
  if (r.snapshotTimer) {
    clearInterval(r.snapshotTimer);
    r.snapshotTimer = null;
  }
}

// -- Server message handling -------------------------------------------------

async function handleServerMessage(r: Room, message: ServerMessage): Promise<void> {
  switch (message.type) {
    case "presence.joined": {
      r.participants.set(message.connectionId, {
        connectionId: message.connectionId,
        memberId: message.memberId,
        role: r.roleByMemberId.get(message.memberId) ?? null,
        focusTerminalId: null,
      });
      r.lastRoomSequence = message.roomSequence;
      // A late joiner benefits from a fresh snapshot of the current screen.
      if (r.mode === "hosting") void publishSnapshot(r);
      notify();
      break;
    }
    case "presence.left": {
      r.participants.delete(message.connectionId);
      r.lastRoomSequence = message.roomSequence;
      notify();
      break;
    }
    case "presence.focus": {
      const existing = r.participants.get(message.connectionId);
      if (existing) existing.focusTerminalId = message.terminalId;
      if (r.mode === "viewing" && message.terminalId && !r.sharedTerminalId) {
        r.sharedTerminalId = message.terminalId;
      }
      r.lastRoomSequence = message.roomSequence;
      notify();
      break;
    }
    case "control.state": {
      r.control.set(message.terminalId, message.acquired ? message.memberId : null);
      r.lastRoomSequence = message.roomSequence;
      applyControlLease(r, message.terminalId);
      notify();
      break;
    }
    case "room.key-epoch": {
      // The connection will be closed with 4003 next; surface the rotation now.
      r.lastRoomSequence = message.roomSequence;
      setStatus(r, "key-rotating");
      break;
    }
    case "history.complete": {
      if (r.mode === "viewing" && message.returned === 0 && !r.renderedAnyOutput) {
        void seedFromSnapshot(r);
      }
      break;
    }
    case "error": {
      r.errorMessage = message.error;
      notify();
      break;
    }
    default: {
      if ((message as { type?: string }).type === "encrypted.event") {
        await handleEncryptedEvent(r, message as BroadcastEncryptedEvent);
      }
    }
  }
}

async function handleEncryptedEvent(
  r: Room,
  event: BroadcastEncryptedEvent,
): Promise<void> {
  if (typeof event.roomSequence === "number") {
    r.lastRoomSequence = Math.max(r.lastRoomSequence, event.roomSequence);
  }
  // Skip our own echoed events (owner's output, controller's own input).
  if (event.senderDeviceId === r.deviceId) return;

  let plaintext: Uint8Array;
  try {
    plaintext = await decryptRoomEvent(r.roomKey, event as EncryptedEventMessage, r.replay);
  } catch (error) {
    // A duplicate/out-of-order replay is expected during reconnect gap-fills.
    if (!(error instanceof ReplayError)) {
      r.errorMessage = "A room event could not be decrypted.";
      notify();
    }
    return;
  }

  if (event.kind === "terminal.output") {
    if (r.mode !== "viewing" || !r.displaySessionId) return;
    if (event.terminalId && !r.sharedTerminalId) r.sharedTerminalId = event.terminalId;
    terminalManager.writeOutput(r.displaySessionId, plaintext);
    r.renderedAnyOutput = true;
    return;
  }
  if (event.kind === "terminal.input") {
    // Owner applies a controller's input to the real PTY. terminalManager gates
    // this to the backend session; the PTY echo flows back out via the tap.
    if (r.mode !== "hosting" || !r.ownerSessionId) return;
    const text = new TextDecoder().decode(plaintext);
    terminalManager.injectInput(r.ownerSessionId, text);
    return;
  }
  if (event.kind === "room.snapshot") {
    // Late live snapshot: only used by a viewer that has not rendered anything.
    if (r.mode === "viewing" && r.displaySessionId && !r.renderedAnyOutput) {
      terminalManager.writeOutput(r.displaySessionId, plaintext);
      r.renderedAnyOutput = true;
    }
    return;
  }
}

/** Grant or revoke the local display terminal's input based on the control lease. */
function applyControlLease(r: Room, terminalId: string): void {
  if (r.mode !== "viewing" || !r.displaySessionId) return;
  if (r.sharedTerminalId && terminalId !== r.sharedTerminalId) return;
  const holder = r.control.get(terminalId) ?? null;
  const holds = holder !== null && holder === r.memberId && r.role === "controller";
  r.holdsControl = holds;
  terminalManager.setDisplayInput(
    r.displaySessionId,
    holds
      ? (data) => {
          if (rooms.get(r.roomId) !== r) return;
          void encryptAndSend(r, "terminal.input", data, terminalId).catch(() => {});
        }
      : null,
  );
}

// -- Seeding (viewer late-join scrollback) ----------------------------------

function beginSeeding(r: Room): void {
  r.renderedAnyOutput = false;
  // Ask the server to replay stored events; if none are returned we fall back to
  // the stored snapshot (see history.complete handling).
  const afterSequence = r.hasSeededOnce ? r.lastRoomSequence : 0;
  r.hasSeededOnce = true;
  send(r, { type: "history.replay", afterSequence });
}

async function seedFromSnapshot(r: Room): Promise<void> {
  if (!r.displaySessionId) return;
  try {
    const snap = await collabGetSnapshot(r.roomId);
    if (rooms.get(r.roomId) !== r || r.renderedAnyOutput) return;
    const json = fromBase64(snap.dataBase64);
    const event = JSON.parse(json) as EncryptedEventMessage;
    const plaintext = await decryptRoomEvent(r.roomKey, event);
    if (rooms.get(r.roomId) !== r || r.renderedAnyOutput) return;
    terminalManager.writeOutput(r.displaySessionId, plaintext);
    r.renderedAnyOutput = true;
  } catch (error) {
    // A missing snapshot (not-found) or an epoch mismatch is non-fatal; the
    // viewer simply starts from live output.
    const code = parseCollaborationError(error).code;
    if (code !== "not-found") {
      // Leave the terminal empty rather than surfacing a scary error for a
      // best-effort seed.
    }
  }
}

// -- Owner snapshot publishing ----------------------------------------------

function appendSnapshot(r: Room, bytes: Uint8Array): void {
  if (bytes.byteLength === 0) return;
  r.snapshotChunks.push(bytes);
  r.snapshotBytes += bytes.byteLength;
  while (r.snapshotBytes > SNAPSHOT_MAX_BYTES && r.snapshotChunks.length > 1) {
    const dropped = r.snapshotChunks.shift();
    if (dropped) r.snapshotBytes -= dropped.byteLength;
  }
}

function startSnapshotLoop(r: Room): void {
  if (r.snapshotTimer) clearInterval(r.snapshotTimer);
  r.snapshotTimer = setInterval(() => {
    void publishSnapshot(r);
  }, SNAPSHOT_INTERVAL_MS);
  void publishSnapshot(r);
}

async function publishSnapshot(r: Room): Promise<void> {
  if (r.mode !== "hosting" || r.snapshotBytes === 0 || !r.sharedTerminalId) return;
  const total = new Uint8Array(r.snapshotBytes);
  let offset = 0;
  for (const chunk of r.snapshotChunks) {
    total.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const event = await encryptRoomEvent(
      r.roomKey,
      {
        roomId: r.roomId,
        eventId: crypto.randomUUID(),
        kind: "room.snapshot",
        senderDeviceId: r.deviceId,
        senderSequence: nextSequence(r),
        keyEpoch: r.keyEpoch,
      },
      total,
    );
    const dataBase64 = toBase64(JSON.stringify(event));
    const result = await collabPutSnapshot(r.roomId, dataBase64, r.snapshotEtag);
    r.snapshotEtag = result.etag;
  } catch (error) {
    // A concurrent-writer conflict just means another owner device updated the
    // snapshot; refresh the etag opportunistically and retry on the next tick.
    if (parseCollaborationError(error).code === "conflict") {
      try {
        const current = await collabGetSnapshot(r.roomId);
        r.snapshotEtag = current.etag;
      } catch {
        // ignore
      }
    }
  }
}

// -- Room construction -------------------------------------------------------

function newRoom(fields: {
  mode: "hosting" | "viewing";
  roomId: string;
  deviceId: string;
  role: RoomRole;
  keyEpoch: number;
  memberId: string;
  roomKey: CryptoKey;
  roomKeyBytes: Uint8Array | null;
  sharedTerminalId: string | null;
  ownerSessionId: string | null;
  displaySessionId: string | null;
}): Room {
  return {
    ...fields,
    ws: null,
    replay: new ReplayProtector(),
    senderSequence: 0,
    reconnectAttempt: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    snapshotTimer: null,
    closing: false,
    lastRoomSequence: 0,
    hasSeededOnce: false,
    renderedAnyOutput: false,
    participants: new Map(),
    roleByMemberId: new Map(),
    control: new Map(),
    holdsControl: false,
    snapshotChunks: [],
    snapshotBytes: 0,
    snapshotEtag: null,
    errorMessage: null,
    status: "idle",
  };
}

/** Test-only: drop the active room without touching the network. */
export function resetCollabClientForTests(): void {
  for (const room of rooms.values()) clearTimers(room);
  rooms.clear();
  viewingRoomId = null;
  observer = null;
}
