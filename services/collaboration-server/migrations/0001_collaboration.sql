CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE collaboration_accounts (
    subject TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE collaboration_devices (
    id UUID PRIMARY KEY,
    subject TEXT NOT NULL REFERENCES collaboration_accounts(subject),
    public_key JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX collaboration_devices_subject_idx
    ON collaboration_devices(subject)
    WHERE revoked_at IS NULL;

CREATE TABLE collaboration_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_subject TEXT NOT NULL REFERENCES collaboration_accounts(subject),
    key_epoch INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE collaboration_room_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
    subject TEXT NOT NULL REFERENCES collaboration_accounts(subject),
    role TEXT NOT NULL CHECK (role IN ('owner', 'controller', 'viewer')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    UNIQUE (room_id, subject)
);

CREATE INDEX collaboration_room_members_subject_idx
    ON collaboration_room_members(subject)
    WHERE revoked_at IS NULL;

CREATE TABLE collaboration_room_member_keys (
    room_id UUID NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES collaboration_room_members(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES collaboration_devices(id),
    key_epoch INTEGER NOT NULL CHECK (key_epoch > 0),
    key_envelope JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, device_id, key_epoch)
);

CREATE INDEX collaboration_room_member_keys_member_idx
    ON collaboration_room_member_keys(member_id, key_epoch);
