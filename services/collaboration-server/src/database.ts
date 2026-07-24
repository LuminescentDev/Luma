import type { PoolClient } from "pg";
import { Pool } from "pg";
import type {
  DevicePublicKey,
  RoomKeyEnvelope,
} from "@luma/collaboration-encryption";
import type { RoomRole } from "@luma/collaboration-protocol";
import { HttpError } from "./auth.js";

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

export class Database {
  readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async ensureAccount(subject: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO collaboration_accounts (subject) VALUES ($1)
       ON CONFLICT (subject) DO NOTHING`,
      [subject],
    );
  }

  async registerDevice(
    subject: string,
    deviceId: string,
    publicKey: DevicePublicKey,
  ): Promise<void> {
    await this.ensureAccount(subject);
    await this.pool.query(
      `INSERT INTO collaboration_devices (id, subject, public_key)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [deviceId, subject, JSON.stringify(publicKey)],
    );
    const result = await this.pool.query<{
      subject: string;
      public_key: DevicePublicKey;
      revoked_at: Date | null;
    }>(
      `SELECT subject, public_key, revoked_at
       FROM collaboration_devices WHERE id = $1`,
      [deviceId],
    );
    const device = result.rows[0];
    if (
      !device ||
      device.subject !== subject ||
      device.revoked_at !== null ||
      !samePublicKey(device.public_key, publicKey)
    ) {
      throw new HttpError(409, "device id is already registered with different key material");
    }
  }

  async devices(subject: string): Promise<RegisteredDevice[]> {
    const result = await this.pool.query<{
      id: string;
      public_key: DevicePublicKey;
    }>(
      `SELECT id, public_key
       FROM collaboration_devices
       WHERE subject = $1 AND revoked_at IS NULL
       ORDER BY created_at, id`,
      [subject],
    );
    return result.rows.map((row) => ({ deviceId: row.id, publicKey: row.public_key }));
  }

  async authorizeDevice(subject: string, deviceId: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM collaboration_devices
       WHERE id = $1 AND subject = $2 AND revoked_at IS NULL`,
      [deviceId, subject],
    );
    if (result.rowCount !== 1) throw new HttpError(403, "device is not registered");
  }

  async membership(roomId: string, subject: string): Promise<RoomMembership> {
    const result = await this.pool.query<{
      room_id: string;
      member_id: string;
      subject: string;
      role: RoomRole;
    }>(
      `SELECT member.room_id, member.id AS member_id, member.subject, member.role
       FROM collaboration_room_members member
       JOIN collaboration_rooms room ON room.id = member.room_id
       WHERE member.room_id = $1 AND member.subject = $2
         AND member.revoked_at IS NULL AND room.deleted_at IS NULL`,
      [roomId, subject],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(403, "room access denied");
    return membershipFromRow(row);
  }

  async roomDetails(roomId: string, subject: string, deviceId: string): Promise<RoomDetails> {
    const result = await this.pool.query<{
      room_id: string;
      member_id: string;
      subject: string;
      role: RoomRole;
      key_epoch: number;
      key_envelope: RoomKeyEnvelope;
    }>(
      `SELECT member.room_id, member.id AS member_id, member.subject, member.role,
              room.key_epoch, member_key.key_envelope
       FROM collaboration_room_members member
       JOIN collaboration_rooms room ON room.id = member.room_id
       JOIN collaboration_room_member_keys member_key
         ON member_key.member_id = member.id
        AND member_key.room_id = room.id
        AND member_key.key_epoch = room.key_epoch
       JOIN collaboration_devices device
         ON device.id = member_key.device_id
        AND device.subject = member.subject
       WHERE member.room_id = $1 AND member.subject = $2 AND device.id = $3
         AND member.revoked_at IS NULL AND room.deleted_at IS NULL
         AND device.revoked_at IS NULL`,
      [roomId, subject, deviceId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(403, "room key is unavailable for this device");
    return {
      ...membershipFromRow(row),
      keyEpoch: row.key_epoch,
      keyEnvelope: row.key_envelope,
    };
  }

  async createRoom(
    subject: string,
    roomId: string,
    deviceKeys: DeviceEnvelopeInput[],
  ): Promise<{ roomId: string; memberId: string; keyEpoch: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO collaboration_accounts (subject) VALUES ($1)
         ON CONFLICT (subject) DO NOTHING`,
        [subject],
      );
      await requireAllActiveDevices(client, subject, deviceKeys.map((entry) => entry.deviceId));
      const room = await client.query<{ id: string; key_epoch: number }>(
        `INSERT INTO collaboration_rooms (id, owner_subject)
         VALUES ($1, $2) RETURNING id, key_epoch`,
        [roomId, subject],
      );
      const createdRoom = room.rows[0];
      if (!createdRoom) throw new Error("room insert returned no row");
      validateDeviceEnvelopeContexts(deviceKeys, roomId, createdRoom.key_epoch);
      const member = await client.query<{ id: string }>(
        `INSERT INTO collaboration_room_members (room_id, subject, role)
         VALUES ($1, $2, 'owner') RETURNING id`,
        [roomId, subject],
      );
      const memberId = member.rows[0]?.id;
      if (!memberId) throw new Error("member insert returned no id");
      await insertDeviceEnvelopes(client, roomId, memberId, createdRoom.key_epoch, deviceKeys);
      await client.query("COMMIT");
      return { roomId, memberId, keyEpoch: createdRoom.key_epoch };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async addMember(
    roomId: string,
    ownerSubject: string,
    memberSubject: string,
    role: Exclude<RoomRole, "owner">,
    deviceKeys: DeviceEnvelopeInput[],
  ): Promise<{ memberId: string; keyEpoch: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ role: RoomRole; key_epoch: number }>(
        `SELECT owner.role, room.key_epoch
         FROM collaboration_room_members owner
         JOIN collaboration_rooms room ON room.id = owner.room_id
         WHERE owner.room_id = $1 AND owner.subject = $2
           AND owner.revoked_at IS NULL AND room.deleted_at IS NULL
         FOR UPDATE OF room`,
        [roomId, ownerSubject],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || ownerRow.role !== "owner") {
        throw new HttpError(403, "only the room owner can add members");
      }
      validateDeviceEnvelopeContexts(deviceKeys, roomId, ownerRow.key_epoch);
      await client.query(
        `INSERT INTO collaboration_accounts (subject) VALUES ($1)
         ON CONFLICT (subject) DO NOTHING`,
        [memberSubject],
      );
      await requireAllActiveDevices(
        client,
        memberSubject,
        deviceKeys.map((entry) => entry.deviceId),
      );
      const member = await client.query<{ id: string }>(
        `INSERT INTO collaboration_room_members (room_id, subject, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (room_id, subject) DO UPDATE
           SET role = EXCLUDED.role, revoked_at = NULL
         RETURNING id`,
        [roomId, memberSubject, role],
      );
      const memberId = member.rows[0]?.id;
      if (!memberId) throw new Error("member upsert returned no id");
      await insertDeviceEnvelopes(client, roomId, memberId, ownerRow.key_epoch, deviceKeys);
      await client.query("COMMIT");
      return { memberId, keyEpoch: ownerRow.key_epoch };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateRoomKey(
    roomId: string,
    ownerSubject: string,
    newKeyEpoch: number,
    deviceKeys: DeviceEnvelopeInput[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ role: RoomRole; key_epoch: number }>(
        `SELECT owner.role, room.key_epoch
         FROM collaboration_room_members owner
         JOIN collaboration_rooms room ON room.id = owner.room_id
         WHERE owner.room_id = $1 AND owner.subject = $2
           AND owner.revoked_at IS NULL AND room.deleted_at IS NULL
         FOR UPDATE OF room`,
        [roomId, ownerSubject],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || ownerRow.role !== "owner") {
        throw new HttpError(403, "only the room owner can rotate room keys");
      }
      if (newKeyEpoch !== ownerRow.key_epoch + 1) {
        throw new HttpError(409, "key epoch must advance by exactly one");
      }
      validateDeviceEnvelopeContexts(deviceKeys, roomId, newKeyEpoch);
      const recipients = await client.query<{ device_id: string; member_id: string }>(
        `SELECT device.id AS device_id, member.id AS member_id
         FROM collaboration_room_members member
         JOIN collaboration_devices device ON device.subject = member.subject
         WHERE member.room_id = $1 AND member.revoked_at IS NULL
           AND device.revoked_at IS NULL
         ORDER BY device.id`,
        [roomId],
      );
      const recipientByDevice = new Map(
        recipients.rows.map((row) => [row.device_id, row.member_id]),
      );
      if (
        recipientByDevice.size !== deviceKeys.length ||
        deviceKeys.some((entry) => !recipientByDevice.has(entry.deviceId))
      ) {
        throw new HttpError(400, "rotated envelopes must cover every active room device");
      }
      for (const entry of deviceKeys) {
        await insertDeviceEnvelopes(
          client,
          roomId,
          recipientByDevice.get(entry.deviceId)!,
          newKeyEpoch,
          [entry],
        );
      }
      await client.query(
        "UPDATE collaboration_rooms SET key_epoch = $2 WHERE id = $1",
        [roomId, newKeyEpoch],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function requireAllActiveDevices(
  client: PoolClient,
  subject: string,
  deviceIds: string[],
): Promise<void> {
  const uniqueIds = new Set(deviceIds);
  if (uniqueIds.size === 0 || uniqueIds.size !== deviceIds.length) {
    throw new HttpError(400, "exactly one envelope per active device is required");
  }
  const result = await client.query<{ id: string }>(
    `SELECT id FROM collaboration_devices
     WHERE subject = $1 AND revoked_at IS NULL
     ORDER BY id`,
    [subject],
  );
  const activeIds = result.rows.map((row) => row.id);
  if (
    activeIds.length !== uniqueIds.size ||
    activeIds.some((deviceId) => !uniqueIds.has(deviceId))
  ) {
    throw new HttpError(400, "envelopes must cover every active device for the account");
  }
}

async function insertDeviceEnvelopes(
  client: PoolClient,
  roomId: string,
  memberId: string,
  keyEpoch: number,
  deviceKeys: DeviceEnvelopeInput[],
): Promise<void> {
  for (const entry of deviceKeys) {
    await client.query(
      `INSERT INTO collaboration_room_member_keys
         (room_id, member_id, device_id, key_epoch, key_envelope)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (room_id, device_id, key_epoch) DO UPDATE
         SET member_id = EXCLUDED.member_id, key_envelope = EXCLUDED.key_envelope`,
      [roomId, memberId, entry.deviceId, keyEpoch, JSON.stringify(entry.envelope)],
    );
  }
}

function membershipFromRow(row: {
  room_id: string;
  member_id: string;
  subject: string;
  role: RoomRole;
}): RoomMembership {
  return {
    roomId: row.room_id,
    memberId: row.member_id,
    subject: row.subject,
    role: row.role,
  };
}

function samePublicKey(left: DevicePublicKey, right: DevicePublicKey): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.x === right.x &&
    left.y === right.y
  );
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
