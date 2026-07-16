import { Channel, invoke } from "@tauri-apps/api/core";

export type DetectedShell = {
  id: string;
  name: string;
  path: string;
  args: string[];
};

export type TerminalProfile = {
  id: string;
  name: string;
  shellPath: string;
  args: string[];
  workingDirectory: string | null;
  environment: Record<string, string> | null;
};

export type ProfileInput = {
  name: string;
  shellPath: string;
  args: string[];
  workingDirectory?: string | null;
  environment?: Record<string, string> | null;
};

/** Reference to what a new terminal should run. */
export type ShellRef =
  | { kind: "shell"; id: string }
  | { kind: "profile"; id: string };

export function serializeShellRef(ref: ShellRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function parseShellRef(value: unknown): ShellRef | undefined {
  if (typeof value !== "string") return undefined;
  const [kind, ...rest] = value.split(":");
  const id = rest.join(":");
  if ((kind === "shell" || kind === "profile") && id) return { kind, id };
  return undefined;
}

export type SpawnResult = { sessionId: string; shellName: string };

export function spawnPty(
  options: { cols: number; rows: number; ref?: ShellRef },
  onData: (data: Uint8Array | string) => void,
  onExit: (code: number | null) => void,
): Promise<SpawnResult> {
  const dataChannel = new Channel<ArrayBuffer | number[] | string>();
  dataChannel.onmessage = (message) => {
    if (message instanceof ArrayBuffer) onData(new Uint8Array(message));
    else if (Array.isArray(message)) onData(new Uint8Array(message));
    else onData(message);
  };
  const exitChannel = new Channel<number | null>();
  exitChannel.onmessage = onExit;

  return invoke<SpawnResult>("pty_spawn", {
    request: {
      cols: options.cols,
      rows: options.rows,
      shellId: options.ref?.kind === "shell" ? options.ref.id : undefined,
      profileId: options.ref?.kind === "profile" ? options.ref.id : undefined,
    },
    onData: dataChannel,
    onExit: exitChannel,
  });
}

export function writePty(sessionId: string, data: string): Promise<void> {
  return invoke<void>("pty_write", { sessionId, data });
}

export function resizePty(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>("pty_resize", { sessionId, cols, rows });
}

export function killPty(sessionId: string): Promise<void> {
  return invoke<void>("pty_kill", { sessionId });
}

export function detectShells(): Promise<DetectedShell[]> {
  return invoke<DetectedShell[]>("shells_detect");
}

export function listProfiles(): Promise<TerminalProfile[]> {
  return invoke<TerminalProfile[]>("profiles_list");
}

export function createProfile(input: ProfileInput): Promise<TerminalProfile> {
  return invoke<TerminalProfile>("profile_create", { input });
}

export function updateProfile(id: string, input: ProfileInput): Promise<TerminalProfile> {
  return invoke<TerminalProfile>("profile_update", { id, input });
}

export function deleteProfile(id: string): Promise<void> {
  return invoke<void>("profile_delete", { id });
}
