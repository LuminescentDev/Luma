CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collaboration_accounts" (
  "subject" text PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collaboration_devices" (
  "id" uuid PRIMARY KEY NOT NULL,
  "subject" text NOT NULL REFERENCES "collaboration_accounts"("subject"),
  "public_key" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collaboration_rooms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_subject" text NOT NULL REFERENCES "collaboration_accounts"("subject"),
  "key_epoch" integer DEFAULT 1 NOT NULL CHECK ("key_epoch" > 0),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collaboration_room_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_id" uuid NOT NULL REFERENCES "collaboration_rooms"("id") ON DELETE CASCADE,
  "subject" text NOT NULL REFERENCES "collaboration_accounts"("subject"),
  "role" text NOT NULL CHECK ("role" IN ('owner', 'controller', 'viewer')),
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "collaboration_room_members_room_id_subject_key" UNIQUE("room_id", "subject")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collaboration_room_member_keys" (
  "room_id" uuid NOT NULL REFERENCES "collaboration_rooms"("id") ON DELETE CASCADE,
  "member_id" uuid NOT NULL REFERENCES "collaboration_room_members"("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "collaboration_devices"("id"),
  "key_epoch" integer NOT NULL CHECK ("key_epoch" > 0),
  "key_envelope" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "collaboration_room_member_keys_pkey"
    PRIMARY KEY("room_id", "device_id", "key_epoch")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collaboration_devices_subject_idx"
  ON "collaboration_devices" ("subject")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collaboration_room_members_subject_idx"
  ON "collaboration_room_members" ("subject")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collaboration_room_member_keys_member_idx"
  ON "collaboration_room_member_keys" ("member_id", "key_epoch");
