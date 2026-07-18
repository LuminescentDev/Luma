import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { queryClient } from "./queryClient";
import type { Host } from "./hosts";

/*
 * SSH session spawn wrapper. Mirrors spawnPty in src/lib/terminal.ts: the
 * frontend only ever sends a hostId (never hostnames, paths, or args). Once
 * spawned, SSH sessions reuse pty_write / pty_resize / pty_kill via the
 * returned sessionId.
 */

/** Remote OS ids reported by the backend `ssh-remote-os` event. Exactly one of
 * these fixed values is emitted per authenticated session. */
export type SshRemoteOsId =
  | "ubuntu" | "debian" | "fedora" | "rhel" | "centos" | "rocky" | "almalinux"
  | "arch" | "manjaro" | "alpine" | "opensuse" | "suse" | "mint" | "kali"
  | "gentoo" | "void" | "nixos" | "amazon" | "oracle" | "raspbian"
  | "freebsd" | "macos" | "windows" | "linux" | "unknown";

/** Payload of the backend `ssh-remote-os` event (emitted to the `main` window).
 * `sessionId` is the BACKEND session id (the value ssh_spawn returns), not the
 * frontend/React session id. */
export type SshRemoteOsEvent = {
  sessionId: string;
  hostId: string;
  osId: SshRemoteOsId;
  prettyName: string | null;
};

function updateCachedHostOs(payload: SshRemoteOsEvent): void {
  for (const key of [["hosts"], ["recent-hosts"]] as const) {
    queryClient.setQueryData<Host[]>(key, (hosts) =>
      hosts?.map((host) =>
        host.id === payload.hostId
          ? { ...host, osId: payload.osId, osPrettyName: payload.prettyName }
          : host,
      ),
    );
  }
}

/** Connection failure categories reported on the SSH exit channel. */
export type SshExitCategory =
  | "host-key-changed"
  | "host-key-rejected"
  | "auth-failed"
  | "dns-failed"
  | "host-unreachable"
  | "timeout"
  | "ssh-error";

export type SshExitPayload = {
  code: number | null;
  errorCategory: string | null;
  errorMessage: string | null;
};

export type SshSpawnResult = { sessionId: string; title: string };

/*
 * In-app host-key trust preflight. Because OpenSSH now runs with
 * StrictHostKeyChecking=yes against a Luma-managed known_hosts file, it never
 * prints the interactive "Are you sure you want to continue connecting?" prompt.
 * Unknown/changed keys must be resolved by these two commands BEFORE ssh_spawn.
 * The frontend still only ever sends a hostId.
 */

/** A single host key observed on the wire (or previously trusted). The
 * fingerprint is always "SHA256:<base64-no-padding>". */
export type HostKeyFingerprint = { keyType: string; fingerprint: string };

export type SshHostKeyStatusKind = "known" | "unknown" | "changed";

export type SshHostKeyStatus = {
  /** `known` → safe to spawn. `unknown` → require explicit user acceptance of
   * `scannedKeys`. `changed` → blocking; never auto-trust. */
  status: SshHostKeyStatusKind;
  /** Fingerprints observed on the network right now — what the user must verify
   * out-of-band before trusting. */
  scannedKeys: HostKeyFingerprint[];
  /** Previously trusted fingerprints; populated for the `changed` status so the
   * UI can show old-vs-new for comparison. */
  knownKeys: HostKeyFingerprint[];
};

/** Error categories the host-key status/trust commands may return (serialized
 * as { category, message } like every other Luma error). `host-key-scan-required`
 * means the retained scan expired (>120s) or the host/port changed — re-run
 * status and re-show the NEW fingerprints. `host-key-changed` from trust means a
 * differing entry exists and nothing was written. */
export type SshHostKeyErrorCategory =
  | "invalid-input"
  | "database"
  | "io"
  | "ssh-unavailable"
  | "dns-failed"
  | "host-unreachable"
  | "timeout"
  | "host-key-scan-failed"
  | "host-key-file-invalid"
  | "host-key-scan-required"
  | "host-key-changed";

/** Scan the server's current host keys and compare them to Luma's known_hosts.
 * On `unknown` the backend retains the exact scan for 120s so a following
 * sshHostKeyTrust matches what the user saw. */
export function sshHostKeyStatus(hostId: string): Promise<SshHostKeyStatus> {
  return invoke<SshHostKeyStatus>("ssh_host_key_status", {
    request: { hostId },
  });
}

/** Trust the backend-retained scan for this host (writes it to Luma's
 * known_hosts). Success returns `{ status: "known", ... }`. Never replaces a
 * differing key — see the `host-key-changed` error category. */
export function sshHostKeyTrust(hostId: string): Promise<SshHostKeyStatus> {
  return invoke<SshHostKeyStatus>("ssh_host_key_trust", {
    request: { hostId },
  });
}

export async function spawnSsh(
  request: { hostId: string; cols: number; rows: number },
  onData: (data: Uint8Array | string) => void,
  onExit: (payload: SshExitPayload) => void,
  onRemoteOs?: (osId: SshRemoteOsId, prettyName: string | null) => void,
): Promise<SshSpawnResult> {
  const dataChannel = new Channel<ArrayBuffer | number[] | string>();
  dataChannel.onmessage = (message) => {
    if (message instanceof ArrayBuffer) onData(new Uint8Array(message));
    else if (Array.isArray(message)) onData(new Uint8Array(message));
    else onData(message);
  };
  const exitChannel = new Channel<SshExitPayload>();

  /*
   * Remote OS detection. The backend emits `ssh-remote-os` (to the `main`
   * window) keyed by the BACKEND session id — the value ssh_spawn RETURNS, not
   * the frontend session id — at most once per authenticated session.
   *
   * Two races to handle:
   *  1. listener-before-spawn: register the listener and await it BEFORE
   *     invoking ssh_spawn, so a fast-auth event fired the instant the backend
   *     authenticates can't slip through before we're subscribed.
   *  2. event-before-resolve: the event can arrive before ssh_spawn's promise
   *     resolves, so before we know our backend id we can't tell whether an
   *     event is ours. We buffer every early event, then once ssh_spawn returns
   *     the backend id we replay the buffer and filter by exact sessionId
   *     match. Concurrent SSH spawns each keep their own listener, so an event
   *     we discard here (another session's) is still matched by that session's
   *     listener.
   */
  let backendId: string | null = null;
  let delivered = false;
  let stopped = false;
  let unlisten: (() => void) | undefined;
  const buffer: SshRemoteOsEvent[] = [];

  const cleanup = () => {
    stopped = true;
    unlisten?.();
    unlisten = undefined;
  };

  const deliver = (payload: SshRemoteOsEvent) => {
    if (delivered || backendId === null) return;
    if (payload.sessionId !== backendId) return;
    delivered = true;
    updateCachedHostOs(payload);
    onRemoteOs?.(payload.osId, payload.prettyName);
    // At most one event per session; release the listener once delivered.
    cleanup();
  };

  // Always release the listener when the session ends — sessions that never
  // authenticate emit nothing, so the listener would otherwise leak.
  exitChannel.onmessage = (payload) => {
    cleanup();
    onExit(payload);
  };

  if (onRemoteOs) {
    const un = await getCurrentWindow().listen<SshRemoteOsEvent>(
      "ssh-remote-os",
      (event) => {
        if (backendId === null) buffer.push(event.payload);
        else deliver(event.payload);
      },
    );
    // cleanup() may have run while listen() was pending (unlikely here since we
    // await before invoking, but keep the guard robust).
    if (stopped) un();
    else unlisten = un;
  }

  try {
    const result = await invoke<SshSpawnResult>("ssh_spawn", {
      request: {
        hostId: request.hostId,
        cols: request.cols,
        rows: request.rows,
      },
      onData: dataChannel,
      onExit: exitChannel,
    });
    backendId = result.sessionId;
    for (const payload of buffer.splice(0)) deliver(payload);
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}
