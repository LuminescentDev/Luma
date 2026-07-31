import { open } from "@tauri-apps/plugin-dialog";
import { terminalAttachUpload } from "../../lib/sftp";
import { escapePosixShellArg } from "../../lib/shellEscape";
import { parseLumaError } from "../../lib/hosts";
import { useSessionStore } from "../../stores/sessionStore";
import { terminalManager } from "./terminalManager";
import type { TerminalSession } from "../../types";

/*
 * "Attach file" flow shared by the desktop pane menu, the mobile accessory bar
 * and the voice composer: pick a local file, upload it to the host's private
 * staging directory (~/.luma/attachments) over SFTP, then use the shell-escaped
 * remote path. The path is only ever typed — never executed. Progress and
 * failures surface through the session's dismissible transport notice.
 */

/** Attachments need an SSH-backed session (mosh sessions are stored with
 * type "ssh" and a hostId too — SFTP connects separately by hostId). */
export function canAttachFile(session: TerminalSession | undefined): boolean {
  return session?.type === "ssh" && !!session.hostId;
}

/** Show the OS file picker. Returns null when the user cancels. */
export async function pickLocalFile(): Promise<string | null> {
  const picked = await open({ multiple: false, directory: false });
  return typeof picked === "string" ? picked : null;
}

/**
 * Upload one local file to the session's host and return the shell-escaped
 * remote path, WITHOUT touching the terminal. Callers decide where the path
 * goes — straight to the prompt, or into a composer draft for review.
 *
 * Drives the session's transport notice for progress and failure, then rethrows
 * so a caller with its own error surface can react as well.
 */
export async function uploadAttachment(
  session: TerminalSession,
  localPath: string,
): Promise<string> {
  const hostId = session.hostId;
  if (!hostId) throw new Error("Session is not attached to a host");

  const { setTransportNotice } = useSessionStore.getState();
  setTransportNotice(session.id, "Uploading attachment…");
  try {
    const { remotePath } = await terminalAttachUpload(hostId, localPath);
    setTransportNotice(session.id, undefined);
    return escapePosixShellArg(remotePath);
  } catch (error) {
    setTransportNotice(
      session.id,
      `Attachment upload failed: ${parseLumaError(error).message}`,
    );
    throw error;
  }
}

export async function attachFileToSession(session: TerminalSession): Promise<void> {
  if (!session.hostId) return;
  const picked = await pickLocalFile();
  if (picked === null) return;

  try {
    const escapedPath = await uploadAttachment(session, picked);
    // Insert the escaped path plus a trailing space at the cursor (paste-style,
    // no newline, never executed).
    terminalManager.insertText(session.id, `${escapedPath} `);
  } catch {
    // uploadAttachment already surfaced the failure on the transport notice.
  }
}
