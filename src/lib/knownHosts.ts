import { invoke } from "@tauri-apps/api/core";

/*
 * Typed wrappers for the known-hosts backend commands. These read and edit
 * Luma's OpenSSH-format known_hosts file (the trust store consulted by the SSH
 * host-key preflight). No secrets are involved — only public host-key
 * fingerprints and the host patterns they were recorded for.
 */

export type KnownHostsEntry = {
  /** 1-based PHYSICAL line number in the file. Line numbers shift after any
   * removal, so the list must be refetched after `knownHostsRemove`. */
  lineNumber: number;
  /** Plain host list (e.g. "example.com,192.0.2.1") or "Hashed: |1|..." when
   * the hostnames are hashed. */
  hosts: string;
  keyType: string;
  /** Always "SHA256:<base64-no-padding>". */
  fingerprint: string;
  /** "revoked" / "cert-authority" marker when present, else null. */
  marker: string | null;
};

/** List every parseable known-hosts entry. Returns an empty array when the file
 * is missing; malformed and comment lines are omitted by the backend. */
export function knownHostsList(): Promise<KnownHostsEntry[]> {
  return invoke<KnownHostsEntry[]>("known_hosts_list");
}

/** Remove the entry at the given 1-based physical line. The caller MUST refetch
 * the list afterwards — remaining line numbers shift. Rejects with
 * invalid-input (bad/missing line), host-key-file-invalid, or io. */
export function knownHostsRemove(lineNumber: number): Promise<void> {
  return invoke<void>("known_hosts_remove", { lineNumber });
}

const HASHED_PREFIX = "Hashed: ";

/** Whether an entry's hosts field is a hashed host list (opaque). */
export function isHashedHosts(hosts: string): boolean {
  return hosts.startsWith(HASHED_PREFIX);
}

/** The display value for the hosts field: the hash body for hashed entries, or
 * the plain host list otherwise. */
export function hostsDisplay(hosts: string): string {
  return isHashedHosts(hosts) ? hosts.slice(HASHED_PREFIX.length) : hosts;
}
