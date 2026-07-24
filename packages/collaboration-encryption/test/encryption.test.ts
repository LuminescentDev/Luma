import { describe, expect, it } from "vitest";
import {
  CollaborationCryptoError,
  decodeEventText,
  decryptRoomEvent,
  encryptRoomEvent,
  exportDevicePrivateKey,
  exportDevicePublicKey,
  generateDeviceKeyPair,
  generateRoomKey,
  importDevicePrivateKey,
  importRoomKey,
  openRoomKey,
  ReplayError,
  ReplayProtector,
  sealRoomKey,
} from "../src/index.js";

const roomId = "285f25d1-d8e9-47c6-8133-f4485e6c2905";
const deviceId = "device-alice";

describe("room key envelopes", () => {
  it("wraps a room key for one device without exposing it to another", async () => {
    const alice = await generateDeviceKeyPair();
    const bob = await generateDeviceKeyPair();
    const roomKey = generateRoomKey();
    const context = { roomId, keyEpoch: 1, recipientDeviceId: deviceId };
    const envelope = await sealRoomKey(roomKey, await exportDevicePublicKey(alice.publicKey), context);
    const serializedPrivateKey = await exportDevicePrivateKey(alice.privateKey);
    const restored = await importDevicePrivateKey(serializedPrivateKey);

    await expect(openRoomKey(envelope, restored, context)).resolves.toEqual(roomKey);
    await expect(openRoomKey(envelope, bob.privateKey, context)).rejects.toThrow(
      "room key envelope authentication failed",
    );
  });

  it("authenticates room, recipient, epoch, and ephemeral public key metadata", async () => {
    const alice = await generateDeviceKeyPair();
    const context = { roomId, keyEpoch: 1, recipientDeviceId: deviceId };
    const envelope = await sealRoomKey(
      generateRoomKey(),
      await exportDevicePublicKey(alice.publicKey),
      context,
    );

    await expect(
      openRoomKey({ ...envelope, keyEpoch: 2 }, alice.privateKey, {
        ...context,
        keyEpoch: 2,
      }),
    ).rejects.toThrow("room key envelope authentication failed");
    await expect(
      openRoomKey(envelope, alice.privateKey, { ...context, recipientDeviceId: "device-bob" }),
    ).rejects.toThrow("room key envelope context does not match");
  });
});

describe("encrypted room events", () => {
  it("round-trips terminal data and rejects routing metadata tampering", async () => {
    const key = await importRoomKey(generateRoomKey());
    const event = await encryptRoomEvent(
      key,
      {
        roomId,
        eventId: "6569d440-2820-41a0-851e-e01f260d2595",
        kind: "terminal.output",
        terminalId: "pane-one",
        senderDeviceId: deviceId,
        senderSequence: 4,
        keyEpoch: 1,
      },
      "root@host:~$",
    );

    expect(decodeEventText(await decryptRoomEvent(key, event))).toBe("root@host:~$");
    await expect(
      decryptRoomEvent(key, { ...event, terminalId: "pane-two" }),
    ).rejects.toThrow("event authentication failed");
  });

  it("rejects duplicates while tracking split terminals independently", async () => {
    const key = await importRoomKey(generateRoomKey());
    const replay = new ReplayProtector();
    const first = await encryptRoomEvent(
      key,
      {
        roomId,
        eventId: "6246c129-8446-4ed8-9bb7-bfac48408408",
        kind: "terminal.input",
        terminalId: "pane-one",
        senderDeviceId: deviceId,
        senderSequence: 1,
        keyEpoch: 1,
      },
      "a",
    );
    const second = await encryptRoomEvent(
      key,
      {
        ...first,
        eventId: "ced4a338-275c-4d7f-9e71-31eb13dbd23f",
        terminalId: "pane-two",
      },
      "b",
    );

    await decryptRoomEvent(key, first, replay);
    await decryptRoomEvent(key, second, replay);
    await expect(decryptRoomEvent(key, first, replay)).rejects.toBeInstanceOf(ReplayError);
  });

  it("does not advance replay state for unauthenticated events", async () => {
    const key = await importRoomKey(generateRoomKey());
    const replay = new ReplayProtector();
    const event = await encryptRoomEvent(
      key,
      {
        roomId,
        eventId: "1f2f17e3-960c-4b9b-8b53-698ace0f7ec1",
        kind: "terminal.output",
        terminalId: "pane-one",
        senderDeviceId: deviceId,
        senderSequence: 9,
        keyEpoch: 1,
      },
      "safe",
    );
    const replacement = event.ciphertext[0] === "A" ? "B" : "A";
    const tampered = { ...event, ciphertext: `${replacement}${event.ciphertext.slice(1)}` };

    await expect(decryptRoomEvent(key, tampered, replay)).rejects.toBeInstanceOf(
      CollaborationCryptoError,
    );
    await expect(decryptRoomEvent(key, event, replay)).resolves.toBeInstanceOf(Uint8Array);
  });
});
