-- SSH agent authentication and ssh-agent key storage are removed: the OS agent
-- is unavailable on mobile and the embedded engine cannot reach it. Former
-- agent hosts fall back to interactive authentication (server prompts, no
-- stored secrets required). The CHECK constraints in 0001 still permit the old
-- values; application-level validation is what narrows them.

-- Hosts keyed to an ssh-agent key reference lose the key and become interactive.
UPDATE hosts
   SET auth_type = 'interactive', key_id = NULL, updated_at = unixepoch()
 WHERE auth_type = 'key'
   AND key_id IN (SELECT id FROM key_references WHERE storage_mode = 'ssh-agent');

-- Agent hosts (including identity-backed hosts stored as 'agent') become interactive.
UPDATE hosts
   SET auth_type = 'interactive', updated_at = unixepoch()
 WHERE auth_type = 'agent';

-- Tombstone then delete ssh-agent key references so sync peers converge.
INSERT OR IGNORE INTO tombstones (object_type, object_id)
  SELECT 'key_reference', id FROM key_references WHERE storage_mode = 'ssh-agent';
DELETE FROM key_references WHERE storage_mode = 'ssh-agent';
