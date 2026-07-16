import { Channel, invoke } from "@tauri-apps/api/core";

/*
 * SSH session spawn wrapper. Mirrors spawnPty in src/lib/terminal.ts: the
 * frontend only ever sends a hostId (never hostnames, paths, or args). Once
 * spawned, SSH sessions reuse pty_write / pty_resize / pty_kill via the
 * returned sessionId.
 */

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

export function spawnSsh(
  request: { hostId: string; cols: number; rows: number },
  onData: (data: Uint8Array | string) => void,
  onExit: (payload: SshExitPayload) => void,
): Promise<SshSpawnResult> {
  const dataChannel = new Channel<ArrayBuffer | number[] | string>();
  dataChannel.onmessage = (message) => {
    if (message instanceof ArrayBuffer) onData(new Uint8Array(message));
    else if (Array.isArray(message)) onData(new Uint8Array(message));
    else onData(message);
  };
  const exitChannel = new Channel<SshExitPayload>();
  exitChannel.onmessage = onExit;

  return invoke<SshSpawnResult>("ssh_spawn", {
    request: {
      hostId: request.hostId,
      cols: request.cols,
      rows: request.rows,
    },
    onData: dataChannel,
    onExit: exitChannel,
  });
}
