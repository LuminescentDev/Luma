import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type {
  DevicePublicKey,
  RoomKeyEnvelope,
} from "@luma/collaboration-encryption";
import type { RoomRole } from "@luma/collaboration-protocol";
import { HttpError } from "./auth.js";
import {
  accounts,
  devices,
  roomInvites,
  roomMemberKeys,
  roomMembers,
  rooms,
} from "./schema.js";
import * as schema from "./schema.js";

export interface RoomMembership {
  roomId: string;
  memberId: string;
  subject: string;
  role: RoomRole;
}

export interface RoomDetails extends RoomMembership {
  keyEpoch: number;
  keyEnvelope: RoomKeyEnvelope;
}

export interface DeviceEnvelopeInput {
  deviceId: string;
  envelope: RoomKeyEnvelope;
}

export interface RegisteredDevice {
  deviceId: string;
  publicKey: DevicePublicKey;
}

export interface CreatedInvite {
  capabilityId: string;
  secret: string;
  keyEpoch: number;
  expiresAt: string;
}

export interface RedeemedInvite {
  memberId: string;
  role: Exclude<RoomRole, "owner">;
  keyEpoch: number;
}

type Transaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

export class Database {
  readonly pool: Pool;
  readonly orm: NodePgDatabase<typeof schema>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
    this.orm = drizzle(this.pool, { schema });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.orm.execute(sql`SELECT 1`);
  }

  async ensureAccount(subject: string): Promise<void> {
    await this.orm.insert(accounts).values({ subject }).onConflictDoNothing();
  }

  async registerDevice(
    subject: string,
    deviceId: string,
    publicKey: DevicePublicKey,
  ): Promise<void> {
    await this.ensureAccount(subject);
    await this.orm
      .insert(devices)
      .values({ id: deviceId, subject, publicKey })
      .onConflictDoNothing();

    const [device] = await this.orm
      .select({
        subject: devices.subject,
        publicKey: devices.publicKey,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    if (
      !device ||
      device.subject !== subject ||
      device.revokedAt !== null ||
      !samePublicKey(device.publicKey, publicKey)
    ) {
      throw new HttpError(409, "device id is already registered with different key material");
    }
  }

  async devices(subject: string): Promise<RegisteredDevice[]> {
    const rows = await this.orm
      .select({ deviceId: devices.id, publicKey: devices.publicKey })
      .from(devices)
      .where(and(eq(devices.subject, subject), isNull(devices.revokedAt)))
      .orderBy(asc(devices.createdAt), asc(devices.id));
    return rows;
  }

  async authorizeDevice(subject: string, deviceId: string): Promise<void> {
    await authorizeDevice(this.orm, subject, deviceId);
  }

  async membership(roomId: string, subject: string): Promise<RoomMembership> {
    const [row] = await this.orm
      .select({
        roomId: roomMembers.roomId,
        memberId: roomMembers.id,
        subject: roomMembers.subject,
        role: roomMembers.role,
      })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.subject, subject),
          isNull(roomMembers.revokedAt),
          isNull(rooms.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new HttpError(403, "room access denied");
    return row;
  }

  async roomDetails(roomId: string, subject: string, deviceId: string): Promise<RoomDetails> {
    const [row] = await this.orm
      .select({
        roomId: roomMembers.roomId,
        memberId: roomMembers.id,
        subject: roomMembers.subject,
        role: roomMembers.role,
        keyEpoch: rooms.keyEpoch,
        keyEnvelope: roomMemberKeys.keyEnvelope,
      })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .innerJoin(
        roomMemberKeys,
        and(
          eq(roomMemberKeys.memberId, roomMembers.id),
          eq(roomMemberKeys.roomId, rooms.id),
          eq(roomMemberKeys.keyEpoch, rooms.keyEpoch),
        ),
      )
      .innerJoin(
        devices,
        and(
          eq(devices.id, roomMemberKeys.deviceId),
          eq(devices.subject, roomMembers.subject),
        ),
      )
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.subject, subject),
          eq(devices.id, deviceId),
          isNull(roomMembers.revokedAt),
          isNull(rooms.deletedAt),
          isNull(devices.revokedAt),
        ),
      )
      .limit(1);
    if (!row) throw new HttpError(403, "room key is unavailable for this device");
    return row;
  }

  async createRoom(
    subject: string,
    roomId: string,
    deviceKeys: DeviceEnvelopeInput[],
  ): Promise<{ roomId: string; memberId: string; keyEpoch: number }> {
    return await this.orm.transaction(async (tx) => {
      await tx.insert(accounts).values({ subject }).onConflictDoNothing();
      await requireAllActiveDevices(tx, subject, deviceKeys.map((entry) => entry.deviceId));

      const [createdRoom] = await tx
        .insert(rooms)
        .values({ id: roomId, ownerSubject: subject })
        .returning({ id: rooms.id, keyEpoch: rooms.keyEpoch });
      if (!createdRoom) throw new Error("room insert returned no row");

      validateDeviceEnvelopeContexts(deviceKeys, roomId, createdRoom.keyEpoch);
      const [member] = await tx
        .insert(roomMembers)
        .values({ roomId, subject, role: "owner" })
        .returning({ id: roomMembers.id });
      if (!member) throw new Error("member insert returned no id");

      await insertDeviceEnvelopes(
        tx,
        roomId,
        member.id,
        createdRoom.keyEpoch,
        deviceKeys,
      );
      return { roomId, memberId: member.id, keyEpoch: createdRoom.keyEpoch };
    });
  }

  async addMember(
    roomId: string,
    ownerSubject: string,
    memberSubject: string,
    role: Exclude<RoomRole, "owner">,
    deviceKeys: DeviceEnvelopeInput[],
  ): Promise<{ memberId: string; keyEpoch: number }> {
    return await this.orm.transaction(async (tx) => {
      const [owner] = await tx
        .select({ role: roomMembers.role, keyEpoch: rooms.keyEpoch })
        .from(roomMembers)
        .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(roomMembers.subject, ownerSubject),
            isNull(roomMembers.revokedAt),
            isNull(rooms.deletedAt),
          ),
        )
        .for("update", { of: rooms })
        .limit(1);
      if (!owner || owner.role !== "owner") {
        throw new HttpError(403, "only the room owner can add members");
      }

      validateDeviceEnvelopeContexts(deviceKeys, roomId, owner.keyEpoch);
      await tx.insert(accounts).values({ subject: memberSubject }).onConflictDoNothing();
      await requireAllActiveDevices(
        tx,
        memberSubject,
        deviceKeys.map((entry) => entry.deviceId),
      );

      const [member] = await tx
        .insert(roomMembers)
        .values({ roomId, subject: memberSubject, role })
        .onConflictDoUpdate({
          target: [roomMembers.roomId, roomMembers.subject],
          set: { role, revokedAt: null },
        })
        .returning({ id: roomMembers.id });
      if (!member) throw new Error("member upsert returned no id");

      await insertDeviceEnvelopes(
        tx,
        roomId,
        member.id,
        owner.keyEpoch,
        deviceKeys,
      );
      return { memberId: member.id, keyEpoch: owner.keyEpoch };
    });
  }

  async createInvite(
    roomId: string,
    ownerSubject: string,
    role: Exclude<RoomRole, "owner">,
    ttlSeconds: number,
  ): Promise<CreatedInvite> {
    return await this.orm.transaction(async (tx) => {
      const [owner] = await tx
        .select({ role: roomMembers.role, keyEpoch: rooms.keyEpoch })
        .from(roomMembers)
        .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(roomMembers.subject, ownerSubject),
            isNull(roomMembers.revokedAt),
            isNull(rooms.deletedAt),
          ),
        )
        .for("update", { of: rooms })
        .limit(1);
      if (!owner || owner.role !== "owner") {
        throw new HttpError(403, "only the room owner can create capabilities");
      }

      const secret = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
      const [invite] = await tx
        .insert(roomInvites)
        .values({
          roomId,
          secretHash: hashCapabilitySecret(secret),
          role,
          keyEpoch: owner.keyEpoch,
          createdBySubject: ownerSubject,
          expiresAt,
        })
        .returning({ id: roomInvites.id });
      if (!invite) throw new Error("capability insert returned no id");

      return {
        capabilityId: invite.id,
        secret,
        keyEpoch: owner.keyEpoch,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async redeemInvite(
    roomId: string,
    subject: string,
    secret: string,
    deviceId: string,
    keyEnvelope: RoomKeyEnvelope,
  ): Promise<RedeemedInvite> {
    return await this.orm.transaction(async (tx) => {
      const [invite] = await tx
        .select({
          role: roomInvites.role,
          keyEpoch: roomInvites.keyEpoch,
          expiresAt: roomInvites.expiresAt,
          revokedAt: roomInvites.revokedAt,
          currentKeyEpoch: rooms.keyEpoch,
        })
        .from(roomInvites)
        .innerJoin(rooms, eq(rooms.id, roomInvites.roomId))
        .where(
          and(
            eq(roomInvites.roomId, roomId),
            eq(roomInvites.secretHash, hashCapabilitySecret(secret)),
            isNull(rooms.deletedAt),
          ),
        )
        .for("update", { of: rooms })
        .limit(1);
      if (!invite || invite.revokedAt !== null) {
        throw new HttpError(403, "capability is invalid or revoked");
      }
      if (invite.expiresAt.getTime() <= Date.now()) {
        throw new HttpError(410, "capability has expired");
      }
      if (invite.keyEpoch !== invite.currentKeyEpoch) {
        throw new HttpError(409, "capability expired, request a new link");
      }

      await authorizeDevice(tx, subject, deviceId);
      validateDeviceEnvelopeContexts(
        [{ deviceId, envelope: keyEnvelope }],
        roomId,
        invite.keyEpoch,
      );

      const [member] = await tx
        .insert(roomMembers)
        .values({ roomId, subject, role: invite.role })
        .onConflictDoUpdate({
          target: [roomMembers.roomId, roomMembers.subject],
          set: { role: invite.role, revokedAt: null },
        })
        .returning({ id: roomMembers.id });
      if (!member) throw new Error("member upsert returned no id");

      await insertDeviceEnvelopes(
        tx,
        roomId,
        member.id,
        invite.keyEpoch,
        [{ deviceId, envelope: keyEnvelope }],
      );
      return { memberId: member.id, role: invite.role, keyEpoch: invite.keyEpoch };
    });
  }

  async rotateRoomKey(
    roomId: string,
    ownerSubject: string,
    newKeyEpoch: number,
    deviceKeys: DeviceEnvelopeInput[],
  ): Promise<void> {
    await this.orm.transaction(async (tx) => {
      const [owner] = await tx
        .select({ role: roomMembers.role, keyEpoch: rooms.keyEpoch })
        .from(roomMembers)
        .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(roomMembers.subject, ownerSubject),
            isNull(roomMembers.revokedAt),
            isNull(rooms.deletedAt),
          ),
        )
        .for("update", { of: rooms })
        .limit(1);
      if (!owner || owner.role !== "owner") {
        throw new HttpError(403, "only the room owner can rotate room keys");
      }
      if (newKeyEpoch !== owner.keyEpoch + 1) {
        throw new HttpError(409, "key epoch must advance by exactly one");
      }

      validateDeviceEnvelopeContexts(deviceKeys, roomId, newKeyEpoch);
      const recipients = await tx
        .select({ deviceId: devices.id, memberId: roomMembers.id })
        .from(roomMembers)
        .innerJoin(devices, eq(devices.subject, roomMembers.subject))
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            isNull(roomMembers.revokedAt),
            isNull(devices.revokedAt),
          ),
        )
        .orderBy(asc(devices.id));
      const recipientByDevice = new Map(
        recipients.map((row) => [row.deviceId, row.memberId]),
      );
      if (
        recipientByDevice.size !== deviceKeys.length ||
        deviceKeys.some((entry) => !recipientByDevice.has(entry.deviceId))
      ) {
        throw new HttpError(400, "rotated envelopes must cover every active room device");
      }

      for (const entry of deviceKeys) {
        await insertDeviceEnvelopes(
          tx,
          roomId,
          recipientByDevice.get(entry.deviceId)!,
          newKeyEpoch,
          [entry],
        );
      }
      await tx.update(rooms).set({ keyEpoch: newKeyEpoch }).where(eq(rooms.id, roomId));
    });
  }
}

async function authorizeDevice(
  database: NodePgDatabase<typeof schema>,
  subject: string,
  deviceId: string,
): Promise<void> {
  const [device] = await database
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(
        eq(devices.id, deviceId),
        eq(devices.subject, subject),
        isNull(devices.revokedAt),
      ),
    )
    .limit(1);
  if (!device) throw new HttpError(403, "device is not registered");
}

async function requireAllActiveDevices(
  tx: Transaction,
  subject: string,
  deviceIds: string[],
): Promise<void> {
  const uniqueIds = new Set(deviceIds);
  if (uniqueIds.size === 0 || uniqueIds.size !== deviceIds.length) {
    throw new HttpError(400, "exactly one envelope per active device is required");
  }
  const rows = await tx
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.subject, subject), isNull(devices.revokedAt)))
    .orderBy(asc(devices.id));
  const activeIds = rows.map((row) => row.id);
  if (
    activeIds.length !== uniqueIds.size ||
    activeIds.some((deviceId) => !uniqueIds.has(deviceId))
  ) {
    throw new HttpError(400, "envelopes must cover every active device for the account");
  }
}

async function insertDeviceEnvelopes(
  tx: Transaction,
  roomId: string,
  memberId: string,
  keyEpoch: number,
  deviceKeys: DeviceEnvelopeInput[],
): Promise<void> {
  for (const entry of deviceKeys) {
    await tx
      .insert(roomMemberKeys)
      .values({
        roomId,
        memberId,
        deviceId: entry.deviceId,
        keyEpoch,
        keyEnvelope: entry.envelope,
      })
      .onConflictDoUpdate({
        target: [
          roomMemberKeys.roomId,
          roomMemberKeys.deviceId,
          roomMemberKeys.keyEpoch,
        ],
        set: {
          memberId,
          keyEnvelope: entry.envelope,
        },
      });
  }
}

function hashCapabilitySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function samePublicKey(left: DevicePublicKey, right: DevicePublicKey): boolean {
  return left.algorithm === right.algorithm && left.x === right.x && left.y === right.y;
}

function validateDeviceEnvelopeContexts(
  deviceKeys: DeviceEnvelopeInput[],
  roomId: string,
  keyEpoch: number,
): void {
  for (const entry of deviceKeys) {
    if (
      entry.envelope.roomId !== roomId ||
      entry.envelope.keyEpoch !== keyEpoch ||
      entry.envelope.recipientDeviceId !== entry.deviceId
    ) {
      throw new HttpError(400, "room key envelope context is invalid");
    }
  }
}
