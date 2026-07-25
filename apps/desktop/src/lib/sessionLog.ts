import { invoke } from "@tauri-apps/api/core";

/*
 * Typed wrappers for per-session logging. IMPORTANT: every `sessionId` here is
 * the BACKEND session id — the value pty_spawn / ssh_spawn return, which
 * terminalManager tracks as `backendId` — NOT the React/store session id.
 * Callers must resolve it via terminalManager.getBackendId first. Serial
 * sessions are not supported by the backend and must not reach these commands.
 */

export type SessionLogMode = "raw" | "asciicast";

export type SessionLogStatus = {
  active: boolean;
  mode: SessionLogMode | null;
  path: string | null;
  bytesWritten: number;
};

/** Start logging a session. Returns the resolved absolute log path. Rejects with
 * invalid-input ("unknown terminal session", "session logging is already
 * active", path validation) or pty (write failures). */
export function sessionLogStart(
  sessionId: string,
  mode: SessionLogMode,
  path?: string | null,
): Promise<string> {
  return invoke<string>("session_log_start", { sessionId, mode, path });
}

/** Stop logging a session. Rejects invalid-input "session logging is not active"
 * when nothing is being logged. */
export function sessionLogStop(sessionId: string): Promise<void> {
  return invoke<void>("session_log_stop", { sessionId });
}

/** Current logging status for a session. */
export function sessionLogStatus(sessionId: string): Promise<SessionLogStatus> {
  return invoke<SessionLogStatus>("session_log_status", { sessionId });
}
