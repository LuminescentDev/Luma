import { createHash } from "node:crypto";
import type { RoomKeyEnvelope } from "@luma/collaboration-encryption";
import { describe, expect, it, vi } from "vitest";
import { Database } from "../src/database.js";

const roomId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";
const capabilityId = "44444444-4444-4444-8444-444444444444";
const ownerSubject = "owner";
const joiningSubject = "joining-user";

const keyEnvelope: RoomKeyEnvelope = {
  version: 1,
  algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM",
  roomId,
  keyEpoch: 4,
  recipientDeviceId: deviceId,
  ephemeralPublicKey: {
    algorithm: "ECDH-P256",
    x: "test-x",
    y: "test-y",
  },
  salt: "test-salt",
  nonce: "test-nonce",
  ciphertext: "test-ciphertext",
};

interface QueryChain<T> extends PromiseLike<T> {
  from(...args: unknown[]): QueryChain<T>;
  innerJoin(...args: unknown[]): QueryChain<T>;
  where(...args: unknown[]): QueryChain<T>;
  for(...args: unknown[]): QueryChain<T>;
  limit(...args: unknown[]): QueryChain<T>;
  values(value: unknown): QueryChain<T>;
  onConflictDoUpdate(...args: unknown[]): QueryChain<T>;
  returning(...args: unknown[]): QueryChain<T>;
}

function queryChain<T>(result: T, captureValue?: (value: unknown) => void): QueryChain<T> {
  const promise = Promise.resolve(result);
  const query = {} as QueryChain<T>;
  query.from = () => query;
  query.innerJoin = () => query;
  query.where = () => query;
  query.for = () => query;
  query.limit = () => query;
  query.values = (value) => {
    captureValue?.(value);
    return query;
  };
  query.onConflictDoUpdate = () => query;
  query.returning = () => query;
  query.then = promise.then.bind(promise);
  return query;
}

function databaseWithTransaction(transaction: object): Database {
  const database = Object.create(Database.prototype) as Database;
  Object.defineProperty(database, "orm", {
    value: {
      transaction: async (callback: (tx: object) => Promise<unknown>) => await callback(transaction),
    } as unknown as Database["orm"],
  });
  return database;
}

function inviteRow(overrides: Partial<{
  role: "controller" | "viewer";
  keyEpoch: number;
  currentKeyEpoch: number;
  expiresAt: Date;
  revokedAt: Date | null;
}> = {}) {
  return {
    role: "viewer" as const,
    keyEpoch: 4,
    currentKeyEpoch: 4,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    ...overrides,
  };
}

describe("collaboration capability invites", () => {
  it("allows only an owner to mint a capability", async () => {
    const insert = vi.fn();
    const database = databaseWithTransaction({
      select: vi.fn(() => queryChain([{ role: "viewer", keyEpoch: 4 }])),
      insert,
    });

    await expect(
      database.createInvite(roomId, joiningSubject, "viewer", 86_400),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 403,
        message: "only the room owner can create capabilities",
      }),
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns the raw secret once while storing only its SHA-256 hash", async () => {
    let insertedValue: unknown;
    const database = databaseWithTransaction({
      select: vi.fn(() => queryChain([{ role: "owner", keyEpoch: 4 }])),
      insert: vi.fn(() =>
        queryChain([{ id: capabilityId }], (value) => {
          insertedValue = value;
        }),
      ),
    });

    const result = await database.createInvite(roomId, ownerSubject, "controller", 60);

    expect(result).toMatchObject({ capabilityId, keyEpoch: 4 });
    expect(result.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    expect(insertedValue).toEqual(
      expect.objectContaining({
        roomId,
        role: "controller",
        keyEpoch: 4,
        createdBySubject: ownerSubject,
        secretHash: createHash("sha256").update(result.secret, "utf8").digest("hex"),
      }),
    );
    expect(insertedValue).not.toHaveProperty("secret");
  });

  it("redeems a valid capability into a member and device envelope", async () => {
    const selectedRows = [[inviteRow({ role: "controller" })], [{ id: deviceId }]];
    const insertedValues: unknown[] = [];
    const insertedRows = [[{ id: memberId }], undefined];
    const database = databaseWithTransaction({
      select: vi.fn(() => queryChain(selectedRows.shift() ?? [])),
      insert: vi.fn(() =>
        queryChain(insertedRows.shift(), (value) => {
          insertedValues.push(value);
        }),
      ),
    });

    await expect(
      database.redeemInvite(roomId, joiningSubject, "valid-secret", deviceId, keyEnvelope),
    ).resolves.toEqual({ memberId, role: "controller", keyEpoch: 4 });
    expect(insertedValues).toEqual([
      { roomId, subject: joiningSubject, role: "controller" },
      {
        roomId,
        memberId,
        deviceId,
        keyEpoch: 4,
        keyEnvelope,
      },
    ]);
  });

  it("rejects an envelope with a mismatched capability context", async () => {
    const selectedRows = [[inviteRow()], [{ id: deviceId }]];
    const insert = vi.fn();
    const database = databaseWithTransaction({
      select: vi.fn(() => queryChain(selectedRows.shift() ?? [])),
      insert,
    });

    await expect(
      database.redeemInvite(roomId, joiningSubject, "valid-secret", deviceId, {
        ...keyEnvelope,
        keyEpoch: 5,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ status: 400, message: "room key envelope context is invalid" }),
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a capability for a device not registered to the caller", async () => {
    const selectedRows = [[inviteRow()], []];
    const insert = vi.fn();
    const database = databaseWithTransaction({
      select: vi.fn(() => queryChain(selectedRows.shift() ?? [])),
      insert,
    });

    await expect(
      database.redeemInvite(roomId, joiningSubject, "valid-secret", deviceId, keyEnvelope),
    ).rejects.toEqual(
      expect.objectContaining({ status: 403, message: "device is not registered" }),
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a wrong capability secret", async () => {
    const insert = vi.fn();
    const database = databaseWithTransaction({
      select: vi.fn(() => queryChain([])),
      insert,
    });

    await expect(
      database.redeemInvite(roomId, joiningSubject, "wrong-secret", deviceId, keyEnvelope),
    ).rejects.toEqual(
      expect.objectContaining({ status: 403, message: "capability is invalid or revoked" }),
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects an expired capability", async () => {
    const insert = vi.fn();
    const database = databaseWithTransaction({
      select: vi.fn(() =>
        queryChain([inviteRow({ expiresAt: new Date(Date.now() - 1_000) })]),
      ),
      insert,
    });

    await expect(
      database.redeemInvite(roomId, joiningSubject, "expired-secret", deviceId, keyEnvelope),
    ).rejects.toEqual(
      expect.objectContaining({ status: 410, message: "capability has expired" }),
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a capability from a stale key epoch", async () => {
    const insert = vi.fn();
    const database = databaseWithTransaction({
      select: vi.fn(() => queryChain([inviteRow({ currentKeyEpoch: 5 })])),
      insert,
    });

    await expect(
      database.redeemInvite(roomId, joiningSubject, "stale-secret", deviceId, keyEnvelope),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        message: "capability expired, request a new link",
      }),
    );
    expect(insert).not.toHaveBeenCalled();
  });
});
