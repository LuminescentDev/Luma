/*
 * Reconstruction of the CURRENT INPUT LINE from the bytes the user types.
 *
 * The autocomplete overlay needs to know what is on the prompt line, and the
 * terminal screen buffer is deliberately not consulted for it: reconstructing a
 * command line from rendered cells is unreliable across prompts, wrapping and
 * redraws. Instead this module models the small set of edits it can model
 * exactly (printable characters, backspace, line kill, submit) and declares
 * itself DESYNCED the moment anything else happens — cursor movement, history
 * recall, shell tab-completion, kill/yank, or any escape sequence.
 *
 * Being conservative is the whole point. A desynced buffer only costs a missing
 * suggestion; a confidently wrong one corrupts the user's command line.
 *
 * Pure functions only — no terminal, no React, no I/O.
 */

export type InputBufferState = {
  /** The reconstructed line. Meaningless while `desynced` is true. */
  text: string;
  /** True once an edit this module cannot model has been observed. Cleared only
   * by a reset (Enter, Ctrl+C, Ctrl+U, or a shell-integration prompt mark). */
  desynced: boolean;
};

export const EMPTY_INPUT_BUFFER: InputBufferState = { text: "", desynced: false };

/** One modelled edit derived from a chunk of typed bytes. */
export type InputEvent =
  | { kind: "insert"; text: string }
  | { kind: "backspace" }
  /** The line was discarded without being run (Ctrl+C, Ctrl+U). */
  | { kind: "reset" }
  /** The line was submitted (Enter). */
  | { kind: "submit" }
  /** Something happened that we cannot model; the line is no longer known. */
  | { kind: "desync" };

/** Ctrl+C — abandon the line. */
const CTRL_C = "\u0003";
/** Ctrl+U — unix-line-discard; with the cursor at the end it clears the line. */
const CTRL_U = "\u0015";
/** Ctrl+H. */
const BACKSPACE = "\u0008";
/** 0x7f — what most terminals actually send for the Backspace key. */
const DELETE = "\u007f";
const ESCAPE = "\u001b";

/**
 * Split a chunk of typed input into modelled edits.
 *
 * Notable classifications, all chosen so a wrong reconstruction is impossible
 * rather than merely unlikely:
 *  - ESC starts an escape sequence (arrows, Home/End, function keys, bracketed
 *    paste). We never try to interpret it and desync, discarding the rest of the
 *    chunk since it belongs to that sequence.
 *  - Tab (0x09) is shell completion: the shell rewrites the line itself, so we
 *    cannot know the result. Desync. (When the overlay is open and a row is
 *    selected the key never reaches here — the overlay consumes it.)
 *  - Ctrl+L (0x0c) is `clear-screen`: every mainstream shell REDRAWS the current
 *    line rather than clearing it. Resetting to empty (as a naive reading would)
 *    would leave us believing the line is empty while it still holds text, which
 *    is exactly the corruption this module exists to prevent — so it desyncs.
 *  - Ctrl+A/E, Ctrl+W, Ctrl+K, Ctrl+D and every other control byte move the
 *    cursor or edit somewhere other than the end. Desync.
 */
export function parseInputEvents(data: string): InputEvent[] {
  const events: InputEvent[] = [];
  let index = 0;
  while (index < data.length) {
    const char = data[index];

    if (char === "\r" || char === "\n") {
      events.push({ kind: "submit" });
      // A pasted CRLF is one submission, not two.
      index += char === "\r" && data[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (char === DELETE || char === BACKSPACE) {
      events.push({ kind: "backspace" });
      index += 1;
      continue;
    }
    if (char === CTRL_C || char === CTRL_U) {
      events.push({ kind: "reset" });
      index += 1;
      continue;
    }
    if (char === ESCAPE) {
      events.push({ kind: "desync" });
      break;
    }
    // Any remaining C0 control byte is an edit we do not model.
    if (char < " ") {
      events.push({ kind: "desync" });
      index += 1;
      continue;
    }

    // A run of printable characters (typing, or a plain paste).
    let end = index;
    while (end < data.length && data[end] >= " " && data[end] !== DELETE) end += 1;
    events.push({ kind: "insert", text: data.slice(index, end) });
    index = end;
  }
  return events;
}

/** Apply one modelled edit. `submit` is handled by {@link applyInput}, which
 * needs to report the completed line before clearing it. */
export function applyInputEvent(
  state: InputBufferState,
  event: InputBufferEventWithoutSubmit,
): InputBufferState {
  switch (event.kind) {
    case "insert":
      // While desynced the text is meaningless; keep it empty rather than
      // accumulating a line that does not match the terminal.
      return state.desynced ? state : { text: state.text + event.text, desynced: false };
    case "backspace":
      return state.desynced ? state : { text: state.text.slice(0, -1), desynced: false };
    case "reset":
      return EMPTY_INPUT_BUFFER;
    case "desync":
      return state.desynced ? state : { text: "", desynced: true };
  }
}

type InputBufferEventWithoutSubmit = Exclude<InputEvent, { kind: "submit" }>;

/**
 * Fold a chunk of typed bytes into the buffer.
 *
 * Returns the new state plus every line that was SUBMITTED and is safe to treat
 * as a real, completely-known command: desynced lines and blank lines are
 * omitted, because history must never record a guess.
 */
export function applyInput(
  state: InputBufferState,
  data: string,
): { state: InputBufferState; submitted: string[] } {
  let next = state;
  const submitted: string[] = [];
  for (const event of parseInputEvents(data)) {
    if (event.kind === "submit") {
      if (!next.desynced && next.text.trim() !== "") submitted.push(next.text);
      next = EMPTY_INPUT_BUFFER;
      continue;
    }
    next = applyInputEvent(next, event);
  }
  return { state: next, submitted };
}

/*
 * Password-prompt heuristic.
 *
 * We reconstruct the line from keystrokes, so a password typed at a `sudo`
 * prompt looks exactly like a command being submitted. Shells with OSC 133
 * integration tell us we are inside command OUTPUT and the buffer desyncs, but
 * plain shells do not — so the command that PRECEDED the line is used as the
 * signal: if it is one of the well-known credential-prompting commands, the
 * next submitted line is dropped instead of recorded.
 *
 * Combined with the secret-substring filter this is defence in depth, not a
 * guarantee; that is why the whole feature is opt-in.
 */
const CREDENTIAL_PROMPT_COMMANDS = new Set([
  "doas",
  "gpg",
  "kinit",
  "mongo",
  "mongosh",
  "mysql",
  "mysqldump",
  "openssl",
  "passwd",
  "psql",
  "redis-cli",
  "scp",
  "sftp",
  "smbclient",
  "ssh",
  "ssh-add",
  "ssh-copy-id",
  "su",
  "sudo",
  "vault",
]);

/** Whether running `command` is likely to prompt for a credential, meaning the
 * NEXT submitted line may be a secret rather than a command. */
export function promptsForSecret(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const name = tokens[0]?.split("/").pop() ?? "";
  if (CREDENTIAL_PROMPT_COMMANDS.has(name)) return true;
  // `ansible-playbook -K`, `docker login`, `npm login`, …
  if (tokens.includes("-K") || tokens.includes("--ask-become-pass")) return true;
  return tokens.length > 1 && tokens[1] === "login";
}
