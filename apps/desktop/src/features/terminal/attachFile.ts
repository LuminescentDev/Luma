import { open } from "@tauri-apps/plugin-dialog";
import { terminalAttachUpload } from "../../lib/sftp";
import { escapePosixShellArg } from "../../lib/shellEscape";
import { parseLumaError } from "../../lib/hosts";
import { useSessionStore } from "../../stores/sessionStore";
import { terminalManager } from "./terminalManager";
import type { TerminalSession } from "../../types";

/*
 * "Attach file" flow shared by the desktop pane menu and the mobile accessory
 * bar: pick a local file, upload it to the host's private staging directory
 * (~/.luma/attachments) over SFTP, then insert the shell-escaped remote path
 * at the terminal cursor. The path is only typed — never executed. Progress
 * and failures surface through the session's dismissible transport notice.
 */

/** Attachments need an SSH-backed session (mosh sessions are stored with
 * type "ssh" and a hostId too — SFTP connects separately by hostId). */
export function canAttachFile(session: TerminalSession | undefined): boolean {
  return session?.type === "ssh" && !!session.hostId;
}

export async function attachFileToSession(session: TerminalSession): Promise<void> {
  const hostId = session.hostId;
  if (!hostId) return;
  const picked = await open({ multiple: false, directory: false });
  if (typeof picked !== "string") return;

  const { setTransportNotice } = useSessionStore.getState();
  setTransportNotice(session.id, "Uploading attachment…");
  try {
    const { remotePath } = await terminalAttachUpload(hostId, picked);
    // Insert the escaped path plus a trailing space at the cursor (paste-style,
    // no newline, never executed).
    terminalManager.insertText(session.id, `${escapePosixShellArg(remotePath)} `);
    setTransportNotice(session.id, undefined);
  } catch (error) {
    setTransportNotice(
      session.id,
      `Attachment upload failed: ${parseLumaError(error).message}`,
    );
  }
}
