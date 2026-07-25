import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  DevicePublicKey,
  RoomKeyEnvelope,
} from "@luma/collaboration-encryption";
import type { RoomRole } from "@luma/collaboration-protocol";

export const accounts = pgTable("collaboration_accounts", {
  subject: text().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const devices = pgTable(
  "collaboration_devices",
  {
    id: uuid().primaryKey(),
    subject: text()
      .notNull()
      .references(() => accounts.subject),
    publicKey: jsonb("public_key").$type<DevicePublicKey>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("collaboration_devices_subject_idx")
      .on(table.subject)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const rooms = pgTable(
  "collaboration_rooms",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerSubject: text("owner_subject")
      .notNull()
      .references(() => accounts.subject),
    keyEpoch: integer("key_epoch").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [check("collaboration_rooms_key_epoch_check", sql`${table.keyEpoch} > 0`)],
);

export const roomMembers = pgTable(
  "collaboration_room_members",
  {
    id: uuid().primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    subject: text()
      .notNull()
      .references(() => accounts.subject),
    role: text().$type<RoomRole>().notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "collaboration_room_members_role_check",
      sql`${table.role} IN ('owner', 'controller', 'viewer')`,
    ),
    unique("collaboration_room_members_room_id_subject_key").on(
      table.roomId,
      table.subject,
    ),
    index("collaboration_room_members_subject_idx")
      .on(table.subject)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const roomMemberKeys = pgTable(
  "collaboration_room_member_keys",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => roomMembers.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id),
    keyEpoch: integer("key_epoch").notNull(),
    keyEnvelope: jsonb("key_envelope").$type<RoomKeyEnvelope>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "collaboration_room_member_keys_pkey",
      columns: [table.roomId, table.deviceId, table.keyEpoch],
    }),
    check("collaboration_room_member_keys_key_epoch_check", sql`${table.keyEpoch} > 0`),
    index("collaboration_room_member_keys_member_idx").on(
      table.memberId,
      table.keyEpoch,
    ),
  ],
);
