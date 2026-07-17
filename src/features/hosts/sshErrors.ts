/*
 * Maps SSH failure categories (from ssh_spawn exit payloads and pre-spawn
 * command rejections) to readable, actionable messages. host-key-changed is
 * treated specially by the UI (a blocking warning), so it is only used as a
 * short label here.
 */

const MESSAGES: Record<string, string> = {
  "host-key-changed":
    "The host key changed since you last connected. This can mean the server was reinstalled — or that the connection is being intercepted. Verify the server before reconnecting.",
  "host-key-rejected":
    "The host key was rejected, so the server could not be verified. Confirm the fingerprint out-of-band before trusting it.",
  "auth-failed":
    "Authentication failed. Check the username, key reference, or that your SSH agent has the right key loaded.",
  "dns-failed":
    "The hostname could not be resolved (DNS lookup failed). Check the address for typos and your network.",
  "host-unreachable":
    "The host is unreachable. Check the address, port, and your network connection.",
  timeout: "The connection timed out before it could be established.",
  "ssh-error": "SSH exited with an error. See the terminal output above for details.",
  "ssh-unavailable":
    "The OpenSSH client was not found on this system. Install OpenSSH, then try again.",
  "key-unavailable":
    "The private key file is missing. Update the key reference to point to a valid key file.",
  "host-key-scan-failed":
    "Luma could not scan the server's host key. The host may be unreachable, or OpenSSH could not read the key. Check the address and port, then try again.",
  "host-key-file-invalid":
    "Luma's managed known_hosts file could not be read. It may be corrupted or contain an invalid entry. Fix or remove it, then try again.",
  "host-key-scan-required":
    "The scanned host key expired before it was accepted (or the host or port changed). Luma re-scanned the server — verify the newly shown fingerprints before trusting them.",
};

/** A short human label for a category (used in tabs / compact spots). */
export function sshCategoryLabel(category: string): string {
  switch (category) {
    case "host-key-changed":
      return "Host key changed";
    case "host-key-rejected":
      return "Host key rejected";
    case "auth-failed":
      return "Authentication failed";
    case "dns-failed":
      return "DNS lookup failed";
    case "host-unreachable":
      return "Host unreachable";
    case "timeout":
      return "Connection timed out";
    case "ssh-unavailable":
      return "SSH unavailable";
    case "key-unavailable":
      return "Key unavailable";
    case "host-key-scan-failed":
      return "Host key scan failed";
    case "host-key-file-invalid":
      return "Host key file invalid";
    case "host-key-scan-required":
      return "Host key rescan required";
    default:
      return "Connection failed";
  }
}

/** A full readable message for an SSH failure. Falls back to the backend's own
 * message (e.g. for invalid-input) when the category is not one we describe. */
export function describeSshError(
  category: string | null | undefined,
  fallback?: string | null,
): string {
  if (category && MESSAGES[category]) return MESSAGES[category];
  return fallback ?? "The SSH connection failed.";
}
