import { describe, expect, it } from "vitest";
import { canPublish, parseClientMessage, ProtocolError } from "../src/index.js";

describe("collaboration protocol", () => {
  it("keeps terminal streams independently addressable", () => {
    const first = parseClientMessage(
      JSON.stringify({
        type: "encrypted.event",
        version: 1,
        algorithm: "AES-256-GCM",
        roomId: "285f25d1-d8e9-47c6-8133-f4485e6c2905",
        eventId: "52b03f7c-f044-4f10-8f2e-7aacdf710f3d",
        kind: "terminal.input",
        terminalId: "pane-one",
        senderDeviceId: "device-one",
        senderSequence: 7,
        keyEpoch: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "YWJj",
      }),
      4096,
    );
    const second = parseClientMessage(
      JSON.stringify({
        type: "encrypted.event",
        version: 1,
        algorithm: "AES-256-GCM",
        roomId: "285f25d1-d8e9-47c6-8133-f4485e6c2905",
        eventId: "56c04952-ae4f-4ccb-9cc9-172f19baf4ea",
        kind: "terminal.input",
        terminalId: "pane-two",
        senderDeviceId: "device-one",
        senderSequence: 3,
        keyEpoch: 1,
        nonce: "AQEBAQEBAQEBAQEB",
        ciphertext: "ZGVm",
      }),
      4096,
    );
    expect(first).toMatchObject({ terminalId: "pane-one", senderSequence: 7 });
    expect(second).toMatchObject({ terminalId: "pane-two", senderSequence: 3 });
  });

  it("rejects plaintext and oversized event payloads", () => {
    expect(() =>
      parseClientMessage(JSON.stringify({ type: "terminal.output", text: "secret" }), 4096),
    ).toThrow(ProtocolError);
    expect(() => parseClientMessage("x".repeat(20), 10)).toThrow("message is too large");
  });

  it("allows controllers to change layout but reserves snapshots for the owner", () => {
    expect(canPublish("owner", "layout.operation")).toBe(true);
    expect(canPublish("controller", "layout.operation")).toBe(true);
    expect(canPublish("controller", "room.snapshot")).toBe(false);
    expect(canPublish("viewer", "terminal.input")).toBe(false);
  });

  it("accepts a bounded replay cursor", () => {
    expect(parseClientMessage('{"type":"history.replay","afterSequence":42}', 4096)).toEqual({
      type: "history.replay",
      afterSequence: 42,
    });
    expect(() =>
      parseClientMessage('{"type":"history.replay","afterSequence":-1}', 4096),
    ).toThrow(ProtocolError);
  });
});
