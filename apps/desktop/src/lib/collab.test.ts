import { describe, it, expect } from "vitest";
import { setInvoke } from "../test/tauriMock";
import {
  buildJoinToken,
  collabAddRoomMember,
  collabCreateRoom,
  collabJoinRoomWithCapability,
  collabMintRoomCapability,
  collabSetServerUrl,
  parseCollaborationError,
  parseJoinToken,
  type JoinLinkPayload,
} from "./collab";

describe("parseCollaborationError", () => {
  it("reads the { code, message, httpStatus } contract shape", () => {
    const parsed = parseCollaborationError({
      code: "forbidden",
      message: "Owner only",
      httpStatus: 403,
    });
    expect(parsed).toEqual({ code: "forbidden", message: "Owner only", httpStatus: 403 });
  });

  it("falls back to invalid-response for a bare message", () => {
    const parsed = parseCollaborationError({ message: "boom" });
    expect(parsed.code).toBe("invalid-response");
    expect(parsed.message).toBe("boom");
    expect(parsed.httpStatus).toBeNull();
  });

  it("stringifies unknown rejections", () => {
    const parsed = parseCollaborationError("weird");
    expect(parsed.code).toBe("invalid-response");
    expect(parsed.message).toBe("weird");
  });
});

describe("command adapters wrap arguments in the contract shape", () => {
  it("collab_create_room passes roomId + deviceKeys under input", async () => {
    let captured: unknown;
    setInvoke((cmd, args) => {
      captured = { cmd, args };
      return { roomId: "r", memberId: "m", keyEpoch: 1 };
    });
    await collabCreateRoom("room-uuid", []);
    expect(captured).toEqual({
      cmd: "collab_create_room",
      args: { input: { roomId: "room-uuid", deviceKeys: [] } },
    });
  });

  it("collab_add_room_member passes subject + role", async () => {
    let captured: unknown;
    setInvoke((cmd, args) => {
      captured = { cmd, args };
      return { memberId: "m", keyEpoch: 1 };
    });
    await collabAddRoomMember("room-uuid", "sub", "controller", []);
    expect(captured).toEqual({
      cmd: "collab_add_room_member",
      args: {
        input: { roomId: "room-uuid", subject: "sub", role: "controller", deviceKeys: [] },
      },
    });
  });

  it("collab_set_server_url wraps the url under input", async () => {
    let captured: unknown;
    setInvoke((cmd, args) => {
      captured = { cmd, args };
      return { serverUrl: "https://x" };
    });
    await collabSetServerUrl("https://x");
    expect(captured).toEqual({
      cmd: "collab_set_server_url",
      args: { input: { serverUrl: "https://x" } },
    });
  });

  it("collab_mint_room_capability passes roomId + role + ttl under input", async () => {
    let captured: unknown;
    setInvoke((cmd, args) => {
      captured = { cmd, args };
      return { capabilityId: "c", secret: "s", keyEpoch: 1, expiresAt: "2026-01-01T00:00:00Z" };
    });
    await collabMintRoomCapability("room-uuid", "controller", 3600);
    expect(captured).toEqual({
      cmd: "collab_mint_room_capability",
      args: { input: { roomId: "room-uuid", role: "controller", ttlSeconds: 3600 } },
    });
  });

  it("collab_join_room_with_capability passes the sealed envelope under input", async () => {
    let captured: unknown;
    const envelope = { version: 1 } as never;
    setInvoke((cmd, args) => {
      captured = { cmd, args };
      return { memberId: "m", role: "viewer", keyEpoch: 1 };
    });
    await collabJoinRoomWithCapability("room-uuid", "secret", "device-1", envelope);
    expect(captured).toEqual({
      cmd: "collab_join_room_with_capability",
      args: {
        input: {
          roomId: "room-uuid",
          secret: "secret",
          deviceId: "device-1",
          keyEnvelope: envelope,
        },
      },
    });
  });
});

describe("capability join token", () => {
  const payload: JoinLinkPayload = {
    v: 1,
    serverUrl: "https://collab.example",
    roomId: "11111111-1111-4111-8111-111111111111",
    role: "controller",
    keyEpoch: 3,
    secret: "one-time-secret",
    roomKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };

  it("round-trips a payload through build/parse", () => {
    expect(parseJoinToken(buildJoinToken(payload))).toEqual(payload);
  });

  it("produces the luma-collab-join-v1 prefix", () => {
    expect(buildJoinToken(payload).startsWith("luma-collab-join-v1.")).toBe(true);
  });

  it("rejects a wrong prefix", () => {
    expect(() => parseJoinToken("luma-collab-invite-v1.abc")).toThrow(/not a Luma join link/i);
  });

  it("rejects a tampered body", () => {
    const token = buildJoinToken(payload);
    expect(() => parseJoinToken(token + "$$$")).toThrow();
  });

  it("rejects an unsupported version", () => {
    const wrongVersion = buildJoinToken({ ...payload, v: 2 as 1 });
    expect(() => parseJoinToken(wrongVersion)).toThrow(/unsupported version/i);
  });

  it("rejects a payload missing required fields", () => {
    const encoded = btoa(JSON.stringify({ v: 1, serverUrl: "https://x" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
    expect(() => parseJoinToken(`luma-collab-join-v1.${encoded}`)).toThrow(
      /missing required information/i,
    );
  });
});
