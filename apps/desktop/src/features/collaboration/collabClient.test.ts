import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  exportDevicePrivateKey,
  exportDevicePublicKey,
  encryptRoomEvent,
  generateDeviceKeyPair,
  generateRoomKey,
  importRoomKey,
  sealRoomKey,
} from "@luma/collaboration-encryption";
import { setInvoke, type InvokeHandler } from "../../test/tauriMock";
import { createdTerminals } from "../../test/xtermMock";
import { terminalManager } from "../terminal/terminalManager";
import { resetDeviceIdentityCache } from "./deviceIdentity";
import {
  joinRoom,
  resetCollabClientForTests,
  startSharing,
} from "./collabClient";

/*
 * Verifies the non-React collaboration bridge: owner output is encrypted and
 * broadcast, viewers decrypt into the display terminal, and only role-authorized
 * members can publish input. Real WebCrypto (via the shared encryption package)
 * runs end-to-end against a fake WebSocket; terminal bytes never touch React.
 */

type SentMessage = { type: string; kind?: string; ciphertext?: string };

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  // Test hooks -------------------------------------------------------------
  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  fireMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  parsedSent(): SentMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as SentMessage);
  }
  static last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await tick();
}

const noopCallbacks = () => ({
  onTitle: () => {},
  onExit: () => {},
  onSearchRequested: () => {},
  onSshAuthenticated: () => {},
  onSshPrompt: () => {},
  onSshProgress: () => {},
  onSshIssue: () => {},
  onRemoteOs: () => {},
});

let originalWebSocket: unknown;

beforeEach(() => {
  resetCollabClientForTests();
  resetDeviceIdentityCache();
  FakeWebSocket.instances = [];
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  resetCollabClientForTests();
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

describe("owner sharing bridges + encrypts PTY output", () => {
  it("encrypts tapped output and broadcasts terminal.output", async () => {
    const ownerPair = await generateDeviceKeyPair();
    const ownerDevicePublic = await exportDevicePublicKey(ownerPair.publicKey);
    let ptyDataChannel: { onmessage: (data: string) => void } | null = null;

    const handler: InvokeHandler = (cmd, args) => {
      switch (cmd) {
        case "pty_spawn":
          ptyDataChannel = args.onData as { onmessage: (data: string) => void };
          return { sessionId: "backend-1", shellName: "bash" };
        case "collab_get_device_identity":
          return null;
        case "collab_set_device_identity":
        case "collab_register_device":
          return null;
        case "collab_list_devices":
          return {
            devices: [{ deviceId: crypto.randomUUID(), publicKey: ownerDevicePublic }],
          };
        case "collab_create_room":
          return {
            roomId: (args.input as { roomId: string }).roomId,
            memberId: "member-owner",
            keyEpoch: 1,
          };
        case "collab_issue_realtime_ticket":
          return { ticket: "t", expiresIn: 60, realtimeUrl: "wss://collab/realtime?ticket=t" };
        case "collab_put_snapshot":
          return { etag: "etag-1" };
        default:
          throw new Error(`unexpected invoke: ${cmd}`);
      }
    };
    setInvoke(handler);

    await terminalManager.createSession("s1", { kind: "local", ref: undefined }, noopCallbacks());
    await startSharing("s1");
    const ws = FakeWebSocket.last();
    ws.fireOpen();

    // Backend emits output → tapped → encrypted → broadcast.
    ptyDataChannel!.onmessage("secret-output");
    await flush();

    const events = ws.parsedSent();
    const output = events.find(
      (m) => m.type === "encrypted.event" && m.kind === "terminal.output",
    );
    expect(output).toBeTruthy();
    expect(output!.ciphertext).toBeTruthy();
    // The plaintext must never appear on the wire.
    expect(JSON.stringify(output)).not.toContain("secret-output");

    terminalManager.dispose("s1");
  });
});

async function setupJoin(role: "viewer" | "controller") {
  const ourPair = await generateDeviceKeyPair();
  const ourPublic = await exportDevicePublicKey(ourPair.publicKey);
  const ourPrivate = await exportDevicePrivateKey(ourPair.privateKey);
  const ourDeviceId = crypto.randomUUID();
  const roomId = crypto.randomUUID();
  const roomKeyBytes = generateRoomKey();
  const envelope = await sealRoomKey(roomKeyBytes, ourPublic, {
    roomId,
    keyEpoch: 1,
    recipientDeviceId: ourDeviceId,
  });
  const peerRoomKey = await importRoomKey(roomKeyBytes);

  const handler: InvokeHandler = (cmd) => {
    switch (cmd) {
      case "collab_get_device_identity":
        return { deviceId: ourDeviceId, publicKey: ourPublic, privateKey: ourPrivate };
      case "collab_register_device":
        return null;
      case "collab_get_room":
        return {
          roomId,
          memberId: "member-self",
          role,
          keyEpoch: 1,
          keyEnvelope: envelope,
        };
      case "collab_issue_realtime_ticket":
        return { ticket: "t", expiresIn: 60, realtimeUrl: "wss://collab/realtime?ticket=t" };
      case "collab_get_snapshot":
        return Promise.reject({ code: "not-found", message: "none", httpStatus: 404 });
      default:
        throw new Error(`unexpected invoke: ${cmd}`);
    }
  };
  setInvoke(handler);
  return { roomId, peerRoomKey };
}

describe("viewer decrypts remote output into the display terminal", () => {
  it("writes decrypted terminal.output bytes via terminalManager", async () => {
    const { roomId, peerRoomKey } = await setupJoin("viewer");
    const writeSpy = vi.spyOn(terminalManager, "writeOutput");

    await joinRoom(roomId);
    const ws = FakeWebSocket.last();
    ws.fireOpen();

    const event = await encryptRoomEvent(
      peerRoomKey,
      {
        roomId,
        eventId: crypto.randomUUID(),
        kind: "terminal.output",
        terminalId: "term-1",
        senderDeviceId: "peer-device",
        senderSequence: 0,
        keyEpoch: 1,
      },
      new TextEncoder().encode("remote-hello"),
    );
    ws.fireMessage({ ...event, memberId: "member-peer", connectionId: "c-1", roomSequence: 5 });
    await flush();

    expect(writeSpy).toHaveBeenCalled();
    const lastCall = writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
    expect(lastCall[0]).toBe(`collab-view:${roomId}`);
    expect(new TextDecoder().decode(lastCall[1] as Uint8Array)).toBe("remote-hello");
    writeSpy.mockRestore();
  });
});

describe("role gating on publishing input", () => {
  it("a controller with the lease encrypts and sends terminal.input", async () => {
    const { roomId } = await setupJoin("controller");
    const before = createdTerminals.length;

    await joinRoom(roomId);
    const displayTerminal = createdTerminals[before];
    const ws = FakeWebSocket.last();
    ws.fireOpen();

    // Server grants this member the control lease.
    ws.fireMessage({
      type: "control.state",
      terminalId: "term-1",
      memberId: "member-self",
      connectionId: "c-self",
      acquired: true,
      roomSequence: 2,
    });
    await flush();

    displayTerminal.emitData("ls\r");
    await flush();

    const input = ws
      .parsedSent()
      .find((m) => m.type === "encrypted.event" && m.kind === "terminal.input");
    expect(input).toBeTruthy();
    expect(JSON.stringify(input)).not.toContain("ls");
  });

  it("a viewer cannot publish input even if it types", async () => {
    const { roomId } = await setupJoin("viewer");
    const before = createdTerminals.length;

    await joinRoom(roomId);
    const displayTerminal = createdTerminals[before];
    const ws = FakeWebSocket.last();
    ws.fireOpen();

    // A stray control.state must not grant a viewer publishing rights.
    ws.fireMessage({
      type: "control.state",
      terminalId: "term-1",
      memberId: "member-self",
      connectionId: "c-self",
      acquired: true,
      roomSequence: 2,
    });
    await flush();

    displayTerminal.emitData("rm -rf /\r");
    await flush();

    const input = ws
      .parsedSent()
      .find((m) => m.type === "encrypted.event" && m.kind === "terminal.input");
    expect(input).toBeUndefined();
  });
});
