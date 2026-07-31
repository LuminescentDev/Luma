import { invoke } from "@tauri-apps/api/core";

/*
 * Typed invoke wrapper for remote multiplexer (tmux / zellij) workspace
 * discovery, plus the small helpers the dialog and the session title share.
 *
 * Attaching is NOT a command of its own: a normal SSH session is spawned with a
 * `multiplexer` request attached (see spawnSsh), and the backend builds the
 * `tmux attach` / `zellij attach` invocation from the validated session name.
 * The frontend never sends a command string.
 */

export type MultiplexerKind = "tmux" | "zellij";

export type MultiplexerWindow = {
  index: number;
  name: string;
  panes: number;
  active: boolean;
};

export type MultiplexerSession = {
  kind: MultiplexerKind;
  name: string;
  /** tmux only, and only when the window listing covered this session. */
  windows: MultiplexerWindow[] | null;
  windowCount: number | null;
  attached: boolean;
  /** Unix SECONDS (tmux only) — multiply before passing to relativeTime. */
  activityTs: number | null;
  createdTs: number | null;
};

export type MultiplexerDiscovery = {
  tmuxAvailable: boolean;
  zellijAvailable: boolean;
  sessions: MultiplexerSession[];
};

/** What a spawn needs in order to land inside a workspace. */
export type MultiplexerAttach = {
  multiplexer: MultiplexerKind;
  sessionName: string;
  /** Create the workspace instead of attaching to an existing one. */
  create?: boolean;
};

export function listMultiplexerSessions(
  hostId: string,
): Promise<MultiplexerDiscovery> {
  return invoke<MultiplexerDiscovery>("multiplexer_list", { hostId });
}

/** Longest name the backend accepts; mirrored here so the dialog can disable
 * the create button instead of round-tripping to an error. */
export const MAX_WORKSPACE_NAME_LENGTH = 128;

const FORBIDDEN_NAME_CHARACTERS = /['"`$\\;&|<>(){}[\]*?!#~=%]/;

/**
 * Client-side mirror of the backend's `validate_session_name`. Advisory only —
 * the backend re-validates every name it is given — but it keeps the dialog
 * from offering a name that can only fail.
 */
export function isValidWorkspaceName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_WORKSPACE_NAME_LENGTH) return false;
  if (name !== name.trim() || name.startsWith("-")) return false;
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return !FORBIDDEN_NAME_CHARACTERS.test(name);
}

/** Terminal-title suffix marking the workspace a session was attached to. */
export function multiplexerTitleSuffix(attach: MultiplexerAttach): string {
  return ` — ${attach.multiplexer}:${attach.sessionName}`;
}

/** Append the workspace suffix to a session title, without doubling it up when
 * the title already carries one (restart / restore paths reuse the title). */
export function withMultiplexerTitle(
  title: string,
  attach: MultiplexerAttach | undefined,
): string {
  if (!attach) return title;
  const suffix = multiplexerTitleSuffix(attach);
  return title.endsWith(suffix) ? title : `${title}${suffix}`;
}

/** Inverse of withMultiplexerTitle: the plain host title, for panes that are
 * derived from an attached session but do not themselves attach (splits). */
export function withoutMultiplexerTitle(
  title: string,
  attach: MultiplexerAttach | undefined,
): string {
  if (!attach) return title;
  const suffix = multiplexerTitleSuffix(attach);
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

/** Human label for a multiplexer, used in headings and notices. */
export function multiplexerLabel(kind: MultiplexerKind): string {
  return kind === "tmux" ? "tmux" : "Zellij";
}
