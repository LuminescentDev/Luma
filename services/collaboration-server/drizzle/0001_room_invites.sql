CREATE TABLE "collaboration_room_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_id" uuid NOT NULL,
  "secret_hash" text NOT NULL,
  "role" text NOT NULL,
  "key_epoch" integer NOT NULL,
  "created_by_subject" text,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "collaboration_room_invites_role_check"
    CHECK ("collaboration_room_invites"."role" IN ('controller', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "collaboration_room_invites"
  ADD CONSTRAINT "collaboration_room_invites_room_id_collaboration_rooms_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."collaboration_rooms"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_room_invites_secret_hash_idx"
  ON "collaboration_room_invites" USING btree ("secret_hash");
