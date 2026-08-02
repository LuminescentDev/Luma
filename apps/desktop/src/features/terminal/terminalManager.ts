import {
  Terminal,
  type IBufferCell,
  type IDecoration,
  type IMarker,
  type ITheme,
} from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";

import {
  DEFAULT_KEYMAP,
  hasRequiredModifier,
  keymapChords,
  matchesChord,
  parseChord,
  type Chord,
} from "../../lib/keymap";

import {
  killPty,
  resizePty,
  spawnPty,
  writePty,
  type ShellRef,
} from "../../lib/terminal";
import {
  spawnMosh,
  spawnSsh,
  sshDisconnect,
  sshResize,
  sshWrite,
  type SshExitPayload,
  type SshRemoteOsId,
} from "../../lib/ssh";
import {
  killSerial,
  spawnSerial,
  writeSerial,
  type SerialConfig,
} from "../../lib/serial";
import { recordCommandHistory } from "../../lib/completions";
import type { MultiplexerAttach } from "../../lib/multiplexer";
import {
  createAgentSignalTracker,
  type AgentSignalTracker,
} from "./agentSignals";
import {
  applyInput,
  promptsForSecret,
  EMPTY_INPUT_BUFFER,
  type InputBufferState,
} from "./inputBuffer";
import { completionSuffix, MAX_SUGGESTIONS, type Suggestion } from "./completions";

/** What a managed session should launch. Local shells resolve a ShellRef;
 * SSH and Mosh sessions send only a hostId (the backend owns the connection
 * details); serial sessions carry their full port config (the backend has no
 * host record). A Mosh session's backend is a local mosh-client PTY, so its
 * I/O rides the local PTY commands, not the embedded-SSH ones.
 */
export type SpawnDescriptor =
  | { kind: "local"; ref: ShellRef | undefined }
  | { kind: "ssh"; hostId: string; multiplexer?: MultiplexerAttach }
  | { kind: "mosh"; hostId: string }
  | { kind: "serial"; config: SerialConfig };

/** SSH sessions use the embedded-SSH commands on every platform; local shells
 * continue through the desktop PTY commands. */
function usesEmbeddedSshIo(descriptor: SpawnDescriptor): boolean {
  return descriptor.kind === "ssh";
}

/** Write keyboard input to the backend command for this session type. */
function writeBackend(
  descriptor: SpawnDescriptor,
  backendId: string,
  data: string,
): Promise<void> {
  if (descriptor.kind === "serial") return writeSerial(backendId, data);
  if (usesEmbeddedSshIo(descriptor)) return sshWrite(backendId, data);
  return writePty(backendId, data);
}

/** Resize a backend session, routing embedded-SSH-on-mobile to ssh_resize and
 * everything else (local + desktop ssh) to the shared PTY command. Serial has no
 * resize command and is never passed here. */
function resizeBackend(
  descriptor: SpawnDescriptor,
  backendId: string,
  cols: number,
  rows: number,
): Promise<void> {
  if (usesEmbeddedSshIo(descriptor)) return sshResize(backendId, cols, rows);
  return resizePty(backendId, cols, rows);
}

/** Kill a backend session, routing serial sessions to the serial command and
 * embedded-SSH-on-mobile to ssh_disconnect. */
function killBackend(
  descriptor: SpawnDescriptor,
  backendId: string,
): Promise<void> {
  if (descriptor.kind === "serial") return killSerial(backendId);
  if (usesEmbeddedSshIo(descriptor)) return sshDisconnect(backendId);
  return killPty(backendId);
}

/** Normalized exit info delivered to the session store. `errorCategory` is only
 * populated for SSH failures; local shells report a plain exit code. */
export type SessionExit = {
  code: number | null;
  errorCategory?: string | null;
  errorMessage?: string | null;
};

/** Normalized spawn result across local and SSH backends. */
export type ManagedSpawnResult = { sessionId: string; title: string };

/** Message of the sentinel error thrown by spawnBackend when a spawn attempt is
 * abandoned: the session was disposed mid-spawn, or a newer restart superseded
 * this attempt. Callers (the session store) treat it as a non-error — the
 * winning attempt (or disposal) owns the session's final state. */
export const SPAWN_ABANDONED = "luma:spawn-abandoned";

/** Whether a rejection is the abandoned-spawn sentinel (see SPAWN_ABANDONED). */
export function isSpawnAbandoned(error: unknown): boolean {
  return error instanceof Error && error.message === SPAWN_ABANDONED;
}

/*
 * Owns every xterm.js instance and its backend PTY session, entirely outside
 * React. React components only mount/unmount host elements and read session
 * metadata from the session store; terminal bytes never touch React state.
 */

export const DARK_THEME: ITheme = {
  background: "#0b0e14",
  foreground: "#e6eaf2",
  cursor: "#4cc9f0",
  cursorAccent: "#0b0e14",
  selectionBackground: "rgba(76, 201, 240, 0.30)",
  black: "#1c2230",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#4cc9f0",
  white: "#cdd6e4",
  brightBlack: "#566072",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

export const LIGHT_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1c2433",
  cursor: "#0e7ea8",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(14, 126, 168, 0.20)",
  black: "#1c2433",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#1d4ed8",
  magenta: "#7e22ce",
  cyan: "#0e7ea8",
  white: "#94a3b8",
  brightBlack: "#475569",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#2563eb",
  brightMagenta: "#9333ea",
  brightCyan: "#0891b2",
  brightWhite: "#e2e8f0",
};

/** The built-in monospace stack used when the user has not chosen a custom font
 * family. Exported so the settings UI can show it as the placeholder / reset. */
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"Luma Cascadia Mono NF", "Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", monospace';

const BUNDLED_TERMINAL_FONT = "Luma Cascadia Mono NF";

/**
 * xterm measures its grid when it is opened. A webfont can still be loading at
 * that instant, especially in mobile WebViews, so refit after the bundled font
 * becomes available rather than leaving fallback-font cell metrics in place.
 */
const bundledTerminalFontReady =
  typeof document !== "undefined" && document.fonts
    ? document.fonts.load(`14px "${BUNDLED_TERMINAL_FONT}"`).then(() => undefined)
    : Promise.resolve();

/*
 * Shell integration (OSC 133 prompt marks + OSC 7 / OSC 1337 cwd reporting).
 * Entirely manager-side: React only reads lightweight metadata via getters
 * (getCwd / getCommandMarks). Prompt-start lines are tracked with xterm markers
 * (auto-disposed on scrollback trim); failed commands get a cheap gutter
 * decoration. Sessions that never emit these sequences simply have no marks and
 * every prompt-jump / copy-output action becomes a no-op.
 */

/** One command cycle bounded by OSC 133 markers. */
type CommandMark = {
  /** Marker at the prompt-start line (OSC 133;A). */
  prompt: IMarker;
  /** Marker at the command-output-start line (OSC 133;C), once reported. */
  output: IMarker | null;
  /** Marker at the command-finished line (OSC 133;D), once reported. */
  end: IMarker | null;
  /** Exit code from OSC 133;D, or null until the command finishes. */
  exitCode: number | null;
  /** Gutter decoration for a failed (nonzero-exit) command. */
  decoration: IDecoration | null;
};

/** Lightweight metadata copy of a command mark handed to React (never markers). */
export type CommandMarkInfo = {
  line: number;
  exitCode: number | null;
  failed: boolean;
};

/*
 * Local terminal autocomplete (opt-in — see SETTING_KEYS.terminalAutocomplete).
 *
 * The manager tracks the CURRENT INPUT LINE per session by folding the bytes
 * the user types through ./inputBuffer, entirely outside React. That buffer is a
 * short string of metadata, not terminal output: no terminal bytes cross into
 * React here either. The overlay component subscribes for `{ buffer,
 * suggestions, selectedIndex }`, computes suggestions from local sources, and
 * pushes the ranked list back in.
 *
 * Ownership split: the manager owns the buffer, the open/selected state and
 * every key that must not reach the shell; React owns only rendering and the
 * asynchronous fetching.
 */

/** Where a session's typed input is currently going, as far as OSC 133 shell
 * integration can tell. "output" means a command is running, so keystrokes
 * belong to that program (a pager, an editor, a password prompt) rather than to
 * a prompt line. */
type PromptPhase = "unknown" | "prompt" | "output";

type AutocompleteSession = {
  input: InputBufferState;
  suggestions: Suggestion[];
  selectedIndex: number;
  /** Set by Escape; suppresses the overlay until the line is next emptied. */
  dismissed: boolean;
  phase: PromptPhase;
  /** True when the command just submitted is one that typically asks for a
   * credential, so the NEXT submitted line must not be recorded. */
  awaitingSecretPrompt: boolean;
  /** Bumped on every buffer change so the overlay knows to recompute. */
  revision: number;
};

/** The lightweight snapshot handed to the overlay component. */
export type AutocompleteView = {
  /** The feature's global setting. False keeps the overlay component inert, so
   * a disabled feature costs nothing at all. */
  enabled: boolean;
  buffer: string;
  desynced: boolean;
  /** Whether the overlay should be on screen (and therefore whether it owns
   * Up/Down/Tab/Escape). */
  open: boolean;
  suggestions: Suggestion[];
  selectedIndex: number;
  revision: number;
};

/** What the source layer needs to fetch suggestions for a session. */
export type AutocompleteContext = {
  scopeKey: string;
  hostId: string | null;
  cwd: string | null;
};

/** Off by default; flipped from the persisted setting via
 * terminalManager.setAutocompleteEnabled. */
let autocompleteEnabled = false;
const autocompleteSubscribers = new Map<string, Set<(view: AutocompleteView) => void>>();

function newAutocompleteSession(): AutocompleteSession {
  return {
    input: EMPTY_INPUT_BUFFER,
    suggestions: [],
    selectedIndex: 0,
    dismissed: false,
    phase: "unknown",
    awaitingSecretPrompt: false,
    revision: 0,
  };
}

/** The history partition for a session. Serial consoles return null: they are
 * not a shell this feature models, so nothing is recorded or suggested. */
function autocompleteScope(descriptor: SpawnDescriptor): string | null {
  if (descriptor.kind === "ssh" || descriptor.kind === "mosh") {
    return `host:${descriptor.hostId}`;
  }
  if (descriptor.kind === "local") {
    const ref = descriptor.ref;
    return ref ? `local:${ref.kind}:${ref.id}` : "local:default";
  }
  return null;
}

/** The host to run remote completion probes against, or null when the session
 * has no SSH host (local shells and serial consoles complete from history and
 * snippets only). */
function autocompleteHostId(descriptor: SpawnDescriptor): string | null {
  return descriptor.kind === "ssh" || descriptor.kind === "mosh" ? descriptor.hostId : null;
}

function isAutocompleteOpen(session: ManagedSession): boolean {
  const state = session.autocomplete;
  return (
    autocompleteEnabled &&
    !state.dismissed &&
    !state.input.desynced &&
    state.phase !== "output" &&
    state.suggestions.length > 0
  );
}

function autocompleteView(session: ManagedSession): AutocompleteView {
  const state = session.autocomplete;
  const open = isAutocompleteOpen(session);
  return {
    enabled: autocompleteEnabled,
    buffer: state.input.text,
    desynced: state.input.desynced || state.phase === "output",
    open,
    // Never publish rows while closed, so a click cannot land on a stale list.
    suggestions: open ? state.suggestions : [],
    selectedIndex: state.selectedIndex,
    revision: state.revision,
  };
}

function notifyAutocomplete(session: ManagedSession): void {
  const subscribers = autocompleteSubscribers.get(session.id);
  if (!subscribers?.size) return;
  const view = autocompleteView(session);
  for (const subscriber of subscribers) subscriber(view);
}

/** Begin a fresh, trusted input line (prompt mark, restart, or teardown). */
function resetAutocompleteLine(session: ManagedSession): void {
  const state = session.autocomplete;
  state.input = EMPTY_INPUT_BUFFER;
  state.suggestions = [];
  state.selectedIndex = 0;
  state.dismissed = false;
  state.revision += 1;
  notifyAutocomplete(session);
}

/** Declare the line unknown. Cheap and always safe — the overlay hides until
 * the next reset rather than risking a wrong completion. */
function desyncAutocomplete(session: ManagedSession): void {
  const state = session.autocomplete;
  if (state.input.desynced && state.suggestions.length === 0) return;
  state.input = { text: "", desynced: true };
  state.suggestions = [];
  state.selectedIndex = 0;
  state.revision += 1;
  notifyAutocomplete(session);
}

/**
 * Persist one submitted command line, unless anything suggests it might be a
 * secret rather than a command.
 *
 * Three independent gates, because we reconstruct the line from keystrokes and
 * therefore cannot see echo suppression: the OSC 133 phase (a line typed while
 * a command is running is not history), the credential-prompt heuristic (the
 * line after `sudo` may be its password), and the backend's own filter for
 * leading spaces and secret-looking text.
 */
function recordSubmittedCommand(session: ManagedSession, command: string): void {
  const state = session.autocomplete;
  const followsCredentialPrompt = state.awaitingSecretPrompt;
  state.awaitingSecretPrompt = promptsForSecret(command);
  if (state.phase === "output" || followsCredentialPrompt) return;
  const scope = autocompleteScope(session.descriptor);
  if (!scope) return;
  // Commands are user data: recorded only while the feature is on, and never
  // written to the log.
  void recordCommandHistory(scope, command).catch(() => {});
}

/**
 * Fold a chunk of typed bytes into a session's input buffer.
 *
 * Called from every path that delivers user keystrokes to a backend session,
 * including broadcast fan-out (peers receive the identical bytes, so their
 * reconstruction stays identical too). Deliberately NOT called for SSH
 * credential replies or injected collaboration input.
 */
function observeAutocompleteInput(session: ManagedSession, data: string): void {
  if (!autocompleteEnabled || session.display || !data) return;
  const state = session.autocomplete;
  const before = state.input;
  const { state: next, submitted } = applyInput(before, data);
  state.input = next;
  for (const command of submitted) recordSubmittedCommand(session, command);

  const changed =
    submitted.length > 0 ||
    next.text !== before.text ||
    next.desynced !== before.desynced;
  if (!changed) return;
  // Any change invalidates the current list; clearing it here means a stale row
  // can never be accepted against a line it no longer matches.
  state.suggestions = [];
  state.selectedIndex = 0;
  // An emptied line (Enter, Ctrl+C, Ctrl+U, or backspacing it away) lifts an
  // earlier Escape, so dismissing is scoped to the line it was aimed at.
  if (next.text === "" && !next.desynced) state.dismissed = false;
  state.revision += 1;
  notifyAutocomplete(session);
}

function moveAutocompleteSelection(session: ManagedSession, delta: number): void {
  const state = session.autocomplete;
  const count = state.suggestions.length;
  if (count === 0) return;
  state.selectedIndex = (state.selectedIndex + delta + count) % count;
  notifyAutocomplete(session);
}

/**
 * Accept the selected row by writing ONLY the text missing from the current
 * line — never a rewrite, never a newline. Returns false (and writes nothing)
 * whenever the completion is not an exact continuation of what is typed, so the
 * caller can pass the key through to the shell untouched.
 */
function acceptAutocomplete(session: ManagedSession): boolean {
  if (!isAutocompleteOpen(session)) return false;
  // A one-shot mobile modifier would transform the suffix's first character.
  if (session.pendingModifier) return false;
  const state = session.autocomplete;
  const suggestion = state.suggestions[state.selectedIndex];
  if (!suggestion) return false;
  const suffix = completionSuffix(state.input.text, suggestion);
  if (suffix === null) return false;
  // Through the normal typed-input path: the shell echoes it exactly as if it
  // had been typed, and the reconstruction above stays in sync.
  routeUserInput(session, suffix);
  return true;
}

function dismissAutocompleteSession(session: ManagedSession): void {
  const state = session.autocomplete;
  state.dismissed = true;
  state.selectedIndex = 0;
  notifyAutocomplete(session);
}

// Bound the retained marks so a long-lived session can't grow unbounded. xterm
// disposes markers when their line is trimmed from scrollback; we also drop the
// oldest here once the cap is exceeded.
const MAX_COMMAND_MARKS = 500;
const outputSubscribers = new Map<string, Set<(data: Uint8Array) => void>>();

// Failed-command gutter bar color (works on both themes; matches the danger red).
const FAILED_COMMAND_COLOR = "#f87171";

/** Parsed chords currently bound to global app actions. The terminal's custom
 * key handler swallows these so they bubble to the window handler in Layout.
 * Seeded from defaults so pass-through is correct before the keymap store loads;
 * refreshed via terminalManager.setAppChords when the keymap changes. */
let appChords: Chord[] = keymapChords(DEFAULT_KEYMAP)
  .map(parseChord)
  .filter((chord): chord is Chord => chord !== null && hasRequiredModifier(chord));

type SessionCallbacks = {
  onTitle: (title: string) => void;
  onExit: (exit: SessionExit) => void;
  onSearchRequested: () => void;
  onSshAuthenticated: () => void;
  /* Credential prompts come from the embedded engine's structured data-stream
   * marker. Host-key trust is handled by the pre-spawn backend preflight. */
  onSshPrompt: (prompt: {
    type: "credential";
    label: string;
    target?: string;
    secret?: boolean;
  }) => void;
  onSshProgress: (stage: "starting" | "network" | "host-key" | "authentication" | "ready") => void;
  /** Detected remote OS for an authenticated SSH session (drives the tab distro
   * logo). Metadata only — never terminal bytes. */
  onRemoteOs: (osId: SshRemoteOsId, prettyName: string | null) => void;
};

const SSH_PROMPT_MARKER = "__LUMA_SSH_PROMPT__";

type EmbeddedSshPrompt = {
  label: string;
  target: string;
  secret: boolean;
};

function latestEmbeddedSshPrompt(transcript: string): {
  prompt: EmbeddedSshPrompt;
  signature: string;
} | null {
  const markerIndex = transcript.lastIndexOf(SSH_PROMPT_MARKER);
  if (markerIndex < 0) return null;

  const payloadStart = markerIndex + SSH_PROMPT_MARKER.length;
  const carriageReturn = transcript.indexOf("\r", payloadStart);
  const newline = transcript.indexOf("\n", payloadStart);
  const lineEnd = [carriageReturn, newline]
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(lineEnd)) return null;

  const payload = transcript.slice(payloadStart, lineEnd).trim();
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.label !== "string" ||
      typeof record.target !== "string" ||
      typeof record.secret !== "boolean"
    ) {
      return null;
    }
    return {
      prompt: {
        label: record.label,
        target: record.target,
        secret: record.secret,
      },
      signature: `embedded-credential:${payload}`,
    };
  } catch {
    // A marker split across data chunks stays in the rolling transcript and is
    // parsed after its terminating newline arrives.
    return null;
  }
}

type ManagedSession = {
  /** This session's stable id (the store's session id). Kept on the session so
   * broadcast fan-out can skip the originating pane without an O(n) reverse
   * lookup. */
  id: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  backendId: string | null;
  descriptor: SpawnDescriptor;
  callbacks: SessionCallbacks;
  /** When this session belongs to a broadcast group, the SHARED set of every
   * member's session id (including this one). All members reference the same Set
   * instance so the group can be resized/disbanded in one place. Null when the
   * session is not broadcasting. Group membership is metadata pushed from React
   * via setBroadcastGroup/clearBroadcastGroup; the fan-out itself (bytes) happens
   * entirely in this manager and never touches React. */
  broadcastPeers: Set<string> | null;
  pendingInput: string[];
  /** Input is sent through one ordered IPC lane per session. Tauri invokes are
   * asynchronous, so firing one per key without backpressure can build a large
   * set of concurrent writes during key repeat. Data arriving while a write is
   * in flight is joined into the next write. */
  queuedInput: string[];
  writeInFlight: boolean;
  exited: boolean;
  /** Monotonic token identifying the current spawn attempt. Bumped on every
   * spawnBackend() call (initial open + each restart). Exit events and spawn
   * completions are matched against the generation that produced them so a
   * stale attempt's exit can never reset a newer attempt, and a late-resolving
   * invoke from a superseded attempt is discarded. */
  spawnGeneration: number;
  disposed: boolean;
  sshTranscript: string;
  lastPromptSignature: string;
  sshStage: "starting" | "network" | "host-key" | "authentication" | "ready";
  sshFinalizing: boolean;
  resizeTimer: ReturnType<typeof window.setTimeout> | null;
  /** OSC 133 command marks (prompt/output/finished markers + exit codes),
   * oldest first. Disposed markers (scrollback trim) are filtered lazily. */
  marks: CommandMark[];
  /** Last working directory reported via OSC 7 / OSC 1337, or null. */
  lastReportedCwd: string | null;
  /** Derives agent-inbox events from notification sequences, bells and the
   * rendered screen, for agents that have no luma-hook installed. Created once
   * the session exists (it observes the session's own state). */
  agentSignals: AgentSignalTracker | null;
  /** Reconstructed input line + overlay state for the autocomplete feature.
   * Metadata only (a short string and a handful of suggestion strings); the
   * byte stream never enters it. */
  autocomplete: AutocompleteSession;
  /** A one-shot sticky modifier armed from the mobile accessory bar (Ctrl/Alt).
   * The NEXT user-typed chunk is transformed into the matching control/meta
   * sequence and the modifier releases. Null when no modifier is armed. Metadata
   * only — the transform runs on the byte path but never crosses into React. */
  pendingModifier: "ctrl" | "alt" | null;
  /** Notified (once) when an armed pendingModifier is consumed by typed input, so
   * the accessory bar can drop its visual "sticky" highlight. */
  onModifierConsumed: (() => void) | null;
  /** Collaboration output tap. When set, every chunk of backend output (the same
   * bytes written into xterm) is ALSO handed to this observer so the collab
   * client can encrypt + broadcast it to a room. Bytes flow manager → tap
   * directly and never cross into React state. Null when the session is not
   * being shared. */
  outputTap: ((data: Uint8Array) => void) | null;
  /** A display-only session has no backend PTY: it renders decrypted remote
   * output (viewer/controller of a shared terminal) and forwards local typing to
   * `onInput` instead of a PTY. */
  display: boolean;
  /** For a display session, where locally-typed input is delivered (the collab
   * client encrypts it as terminal.input for the owner). Null for viewers with no
   * control lease and for normal backend sessions. */
  onInput: ((data: string) => void) | null;
};

// Split-pane and window drags can produce dozens of xterm sizes per second.
// Sending every intermediate size makes remote prompt themes redraw repeatedly
// and asynchronous IPC calls can arrive out of order. Keep xterm responsive,
// but notify the backing PTY only after the layout has briefly settled.
const BACKEND_RESIZE_DEBOUNCE_MS = 100;

// How much of a source session's buffer a preview mirror is seeded with. A
// preview card shows a dozen or so rows, so this only needs to cover the visible
// grid plus a little slack for re-wrapping at the card's narrower width.
const PREVIEW_SEED_LINES = 60;

type ManagerConfig = {
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  defaultShell?: ShellRef;
  theme: "dark" | "light";
};

const sessions = new Map<string, ManagedSession>();
// A pane can mount before its asynchronous backend/session setup has created
// the xterm instance. Remember that host so createSession can complete the
// initial attachment instead of requiring a tab/view switch to remount it.
const pendingHosts = new Map<string, HTMLElement>();

let config: ManagerConfig = {
  fontSize: 14,
  fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  scrollback: 5000,
  defaultShell: undefined,
  theme: "dark",
};

/** An explicit color-scheme override selected in Appearance settings, or null to
 * follow the app light/dark mode (see applyTerminalStyle / currentTheme). This is
 * device-local styling state — never terminal bytes and never React state. */
let schemeOverride: ITheme | null = null;

function isMac(): boolean {
  return navigator.userAgent.includes("Mac");
}

/** The theme every terminal should currently use: an explicit scheme override
 * when one is selected, otherwise Luma's light/dark default for the app mode. */
function currentTheme(): ITheme {
  if (schemeOverride) return schemeOverride;
  return config.theme === "light" ? LIGHT_THEME : DARK_THEME;
}

/**
 * Give back one row when the grid the fit addon chose renders taller than the
 * space it had to fill, which clips the bottom line.
 *
 * The addon divides the available height by a cell height it derives from the
 * CURRENT grid (`round(deviceCellHeight * rows / dpr) / rows`), so that figure
 * carries a rounding error that shrinks as rows grow. At fractional DPRs the
 * error can understate the true cell height enough that the chosen row count
 * renders a few pixels past the container — xterm sizes .xterm-screen from its
 * own exact math, and the overflow lands on the last line.
 *
 * Comparing the rendered height against the container after the fact catches
 * that regardless of how the addon arrived at the number.
 */
function dropOverflowingRow(session: ManagedSession): void {
  const element = session.term.element;
  const parent = element?.parentElement;
  const screen = element?.querySelector<HTMLElement>(".xterm-screen");
  if (!element || !parent || !screen) return;
  // Padding lives on the host (the pane reserves pl-2 pt-1.5), not on the
  // padding-less .xterm element. clientHeight includes that padding, so subtract
  // the host's own padding to get the content box the grid actually fills;
  // reading the .xterm element's padding here would always be 0 and leave the
  // reserved space counted as available, clipping the last row.
  const style = window.getComputedStyle(parent);
  const available =
    parent.clientHeight -
    (parseFloat(style.paddingTop) || 0) -
    (parseFloat(style.paddingBottom) || 0);
  const rendered = screen.getBoundingClientRect().height;
  // Sub-pixel slack: a fraction of a pixel is not a visibly clipped row, and
  // getBoundingClientRect is itself fractional.
  if (rendered - available <= 0.5 || session.term.rows <= 1) return;
  session.term.resize(session.term.cols, session.term.rows - 1);
}

/** SGR parameters reproducing a buffer cell's colors and attributes, as the
 * body of a single `ESC [ ... m`, or "" for a cell with default styling. Used
 * to serialize a scrollback buffer for replay into another window. */
function cellStyle(cell: IBufferCell): string {
  if (cell.isAttributeDefault()) return "";
  const params: number[] = [];
  if (cell.isBold()) params.push(1);
  if (cell.isDim()) params.push(2);
  if (cell.isItalic()) params.push(3);
  if (cell.isUnderline()) params.push(4);
  if (cell.isBlink()) params.push(5);
  if (cell.isInverse()) params.push(7);
  if (cell.isInvisible()) params.push(8);
  if (cell.isStrikethrough()) params.push(9);
  if (cell.isOverline()) params.push(53);
  if (cell.isFgRGB()) {
    const rgb = cell.getFgColor();
    params.push(38, 2, (rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
  } else if (cell.isFgPalette()) {
    params.push(38, 5, cell.getFgColor());
  }
  if (cell.isBgRGB()) {
    const rgb = cell.getBgColor();
    params.push(48, 2, (rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
  } else if (cell.isBgPalette()) {
    params.push(48, 5, cell.getBgColor());
  }
  return params.length > 0 ? `\x1b[${params.join(";")}m` : "";
}

function pumpInput(session: ManagedSession): void {
  if (
    session.writeInFlight ||
    !session.backendId ||
    session.queuedInput.length === 0 ||
    session.disposed ||
    session.exited
  ) {
    return;
  }

  const backendId = session.backendId;
  const data = session.queuedInput.join("");
  session.queuedInput.length = 0;
  session.writeInFlight = true;
  void writeBackend(session.descriptor, backendId, data)
    .catch(() => {
      // Exit/spawn handling owns user-visible backend errors. A failed write
      // must still release this lane so later input cannot deadlock.
    })
    .finally(() => {
      session.writeInFlight = false;
      pumpInput(session);
    });
}

function enqueueInput(session: ManagedSession, data: string): void {
  if (!data || session.disposed || session.exited) return;
  if (!session.backendId) {
    session.pendingInput.push(data);
    return;
  }
  session.queuedInput.push(data);
  pumpInput(session);
}

/**
 * Route user input (keystrokes / paste) from the focused terminal: send it to
 * this session, and — when the session is broadcasting — fan the SAME bytes out
 * to every other group member through each member's own coalescing lane. Only
 * the focused pane ever produces onData, so this reliably originates from the
 * pane the user is typing into; the originating pane receives the data exactly
 * once (peers are the group minus self). xterm has already turned a paste into a
 * single onData payload (bracketed-paste wrapper included), so a paste applies
 * once here and then fans out as one write per peer.
 */
/** Apply a one-shot sticky modifier (from the mobile accessory bar) to the first
 * character of a typed chunk, returning the transformed data. Ctrl maps a letter
 * to its control code (a→\x01 … z→\x1a, plus the common @[\]^_ range); Alt/Meta
 * prefixes ESC. Non-mappable keys under Ctrl pass through unchanged. */
export function applyModifier(mod: "ctrl" | "alt", data: string): string {
  if (!data) return data;
  const first = data[0];
  const rest = data.slice(1);
  if (mod === "alt") return `\x1b${data}`;
  const code = first.toUpperCase().charCodeAt(0);
  // Ctrl+@ (0) .. Ctrl+_ (31): letters A-Z and the @ [ \ ] ^ _ block.
  if (code >= 64 && code <= 95) {
    return `${String.fromCharCode(code - 64)}${rest}`;
  }
  return data;
}

function routeUserInput(session: ManagedSession, data: string): void {
  // Display-only (shared-terminal viewer/controller) sessions have no backend
  // PTY: forward typed input to the collab client, which encrypts it as a
  // terminal.input event for the owner (only when this member holds control —
  // onInput is null for viewers without a lease, making them read-only).
  if (session.display) {
    session.onInput?.(data);
    return;
  }
  // Consume a one-shot Ctrl/Alt armed from the mobile accessory bar. It applies
  // to the first character of the next typed chunk, then releases.
  if (session.pendingModifier && data) {
    data = applyModifier(session.pendingModifier, data);
    session.pendingModifier = null;
    const notify = session.onModifierConsumed;
    session.onModifierConsumed = null;
    notify?.();
  }
  // Track the input line for the autocomplete overlay before the bytes leave.
  // This reads the same chunk the backend receives; it does not intercept,
  // rewrite or delay it.
  observeAutocompleteInput(session, data);
  session.agentSignals?.onUserInput();
  enqueueInput(session, data);
  const peers = session.broadcastPeers;
  if (!peers) return;
  for (const peerId of peers) {
    if (peerId === session.id) continue;
    const peer = sessions.get(peerId);
    if (!peer) continue;
    // Peers receive identical bytes, so their reconstruction stays identical.
    observeAutocompleteInput(peer, data);
    enqueueInput(peer, data);
  }
}

/** Detach a session from its broadcast group, disbanding the group when fewer
 * than two members would remain (a lone broadcaster is meaningless). Shared with
 * dispose() and clearBroadcastGroup so membership never leaks past teardown. */
function detachFromBroadcast(session: ManagedSession): void {
  const group = session.broadcastPeers;
  session.broadcastPeers = null;
  if (!group) return;
  group.delete(session.id);
  if (group.size < 2) {
    for (const remainingId of group) {
      const remaining = sessions.get(remainingId);
      if (remaining) remaining.broadcastPeers = null;
    }
    group.clear();
  }
}

async function loadWebgl(term: Terminal): Promise<void> {
  try {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    const addon = new WebglAddon();
    addon.onContextLoss(() => addon.dispose());
    term.loadAddon(addon);
  } catch {
    // Canvas renderer fallback is fine.
  }
}

function installKeyHandlers(session: ManagedSession): void {
  const { term } = session;
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const mod = isMac() ? event.metaKey : event.ctrlKey;

    // Autocomplete overlay navigation. These keys are consumed ONLY while the
    // overlay is genuinely open with rows to choose from; the moment it closes
    // (Escape, a keystroke that empties the list, the setting turned off) they
    // go straight back to the shell with their normal meaning. Tab in
    // particular is only swallowed when a row is actually accepted, so shell
    // completion keeps working everywhere else.
    if (
      isAutocompleteOpen(session) &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      if (event.key === "ArrowDown") {
        moveAutocompleteSelection(session, 1);
        return false;
      }
      if (event.key === "ArrowUp") {
        moveAutocompleteSelection(session, -1);
        return false;
      }
      if (event.key === "Escape") {
        // Closes the overlay and sends nothing to the shell.
        dismissAutocompleteSession(session);
        return false;
      }
      if (event.key === "Tab" && !event.shiftKey && acceptAutocomplete(session)) {
        return false;
      }
    }

    // Copy on plain Ctrl+C only when text is selected (Windows Terminal
    // behavior); otherwise let it through as SIGINT.
    if (event.ctrlKey && !event.shiftKey && event.code === "KeyC" && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (mod && event.shiftKey && event.code === "KeyC") {
      const selection = term.getSelection();
      if (selection) void navigator.clipboard.writeText(selection);
      return false;
    }
    if (mod && event.shiftKey && event.code === "KeyV") {
      void navigator.clipboard.readText().then((text) => {
        if (text) term.paste(text);
      });
      return false;
    }
    if (mod && event.shiftKey && event.code === "KeyF") {
      session.callbacks.onSearchRequested();
      return false;
    }
    // App-level chords (new tab, split, close pane, command palette, prompt
    // jumps, …) must not reach the shell. The set is derived from the keymap
    // registry (see setAppChords) so rebinding an action keeps this pass-through
    // correct. Returning false lets the event bubble to the global window
    // handler in Layout without inserting anything at the prompt.
    if (appChords.some((chord) => matchesChord(chord, event))) {
      return false;
    }
    // Workspace tab switching, handled by the global window handler in Layout.
    // These universal tab-cycle accelerators are fixed (not rebindable).
    if (event.ctrlKey && event.code === "Tab") {
      return false;
    }
    if (mod && (event.code === "PageUp" || event.code === "PageDown")) {
      return false;
    }
    return true;
  });
}

/** Register OSC parser handlers for shell integration. Handlers only touch the
 * manager-side session state; they never route terminal bytes through React. */
function registerShellIntegration(session: ManagedSession): void {
  const { term } = session;
  // OSC 133: prompt/command marks (A prompt start, B command start, C output
  // start, D;<exit> command finished).
  term.parser.registerOscHandler(133, (data) => {
    handleOsc133(session, data);
    return true;
  });
  // OSC 7: file://host/path current-directory reporting.
  term.parser.registerOscHandler(7, (data) => {
    const cwd = parseOsc7(data);
    if (cwd) session.lastReportedCwd = cwd;
    return true;
  });
  // OSC 1337: iTerm2-style "CurrentDir=<path>" (and other subcommands we ignore).
  term.parser.registerOscHandler(1337, (data) => {
    const cwd = parseOsc1337(data);
    if (cwd) session.lastReportedCwd = cwd;
    return true;
  });
  // Desktop-notification sequences: OSC 9 (iTerm2), OSC 99 (kitty), OSC 777
  // (urxvt). Agents and long-running commands emit these already, so they feed
  // the agent inbox without anything being installed on the host.
  for (const ident of [9, 99, 777]) {
    term.parser.registerOscHandler(ident, (data) => {
      session.agentSignals?.onNotification(ident, data);
      return true;
    });
  }
}

function handleOsc133(session: ManagedSession, data: string): void {
  const { term } = session;
  const semi = data.indexOf(";");
  const kind = (semi === -1 ? data : data.slice(0, semi)).trim();

  // Shell integration is the only trustworthy signal for WHERE typed input is
  // going, so the autocomplete input tracker is driven off it: a prompt mark
  // starts a fresh, trusted line, and an output mark means keystrokes now
  // belong to a running program — a pager, an editor, or a password prompt —
  // and must neither be completed nor recorded.
  if (kind === "A" || kind === "B") {
    session.autocomplete.phase = "prompt";
    session.autocomplete.awaitingSecretPrompt = false;
    resetAutocompleteLine(session);
  } else if (kind === "C") {
    session.autocomplete.phase = "output";
    desyncAutocomplete(session);
  }

  switch (kind) {
    case "A": {
      // Prompt start: begin a new command mark at the current line.
      const marker = term.registerMarker(0);
      if (!marker) return;
      pruneMarks(session);
      session.marks.push({ prompt: marker, output: null, end: null, exitCode: null, decoration: null });
      capMarks(session);
      break;
    }
    case "C": {
      // Command output start: attach an output marker to the current cycle. Some
      // shells emit C without a preceding A — start a mark in that case.
      const marker = term.registerMarker(0);
      if (!marker) return;
      const current = lastLiveMark(session);
      if (current && !current.output) {
        current.output = marker;
      } else {
        pruneMarks(session);
        session.marks.push({ prompt: marker, output: marker, end: null, exitCode: null, decoration: null });
        capMarks(session);
      }
      break;
    }
    case "D": {
      // Command finished: record the exit code and (for failures) a gutter mark.
      const current = lastLiveMark(session);
      if (!current) break;
      const rawCode = semi === -1 ? "" : data.slice(semi + 1).trim();
      const code = rawCode === "" ? NaN : Number.parseInt(rawCode, 10);
      current.exitCode = Number.isFinite(code) ? code : null;
      const endMarker = term.registerMarker(0);
      if (endMarker) current.end = endMarker;
      if (Number.isFinite(code) && code !== 0) addFailureDecoration(session, current);
      break;
    }
    // "B" (command start) needs no state for the features we expose.
    default:
      break;
  }
}

/** Parse an OSC 7 payload (`file://host/path`) into a directory path. Handles the
 * Windows drive form (`file://host/C:/Users/me`) and POSIX (`file://host/home/me`). */
export function parseOsc7(data: string): string | null {
  if (!data.startsWith("file://")) return null;
  const rest = data.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  let path = rest.slice(slash); // keep the leading slash
  try {
    path = decodeURIComponent(path);
  } catch {
    // Leave percent-encoding intact rather than dropping the report.
  }
  // Windows: "/C:/Users/me" -> "C:/Users/me".
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return path || null;
}

/** Parse an OSC 1337 payload, returning the path when it is a `CurrentDir=`. */
export function parseOsc1337(data: string): string | null {
  const match = /^CurrentDir=(.*)$/s.exec(data);
  if (!match) return null;
  return match[1] || null;
}

/** The most recent mark whose prompt marker is still live. */
function lastLiveMark(session: ManagedSession): CommandMark | null {
  for (let i = session.marks.length - 1; i >= 0; i--) {
    if (!session.marks[i].prompt.isDisposed) return session.marks[i];
  }
  return null;
}

/** Drop marks whose prompt marker was disposed by a scrollback trim, releasing
 * any decoration they carried. */
function pruneMarks(session: ManagedSession): void {
  session.marks = session.marks.filter((mark) => {
    if (!mark.prompt.isDisposed) return true;
    mark.decoration?.dispose();
    return false;
  });
}

/** Enforce MAX_COMMAND_MARKS by dropping the oldest marks. */
function capMarks(session: ManagedSession): void {
  const excess = session.marks.length - MAX_COMMAND_MARKS;
  if (excess <= 0) return;
  const dropped = session.marks.splice(0, excess);
  for (const mark of dropped) mark.decoration?.dispose();
}

/** Add a cheap red gutter bar on the command's start line for a nonzero exit. */
function addFailureDecoration(session: ManagedSession, mark: CommandMark): void {
  if (mark.decoration || mark.prompt.isDisposed) return;
  const decoration = session.term.registerDecoration({
    marker: mark.prompt,
    x: 0,
    width: 1,
    overviewRulerOptions: { color: FAILED_COMMAND_COLOR, position: "left" },
  });
  if (!decoration) return;
  mark.decoration = decoration;
  decoration.onRender((element) => {
    element.style.width = "3px";
    element.style.marginLeft = "-1px";
    element.style.backgroundColor = FAILED_COMMAND_COLOR;
    element.style.borderRadius = "1px";
    element.style.pointerEvents = "none";
  });
}

/** Dispose every mark's markers/decorations and reset the list (restart/reset). */
function clearMarks(session: ManagedSession): void {
  for (const mark of session.marks) {
    mark.decoration?.dispose();
    mark.prompt.dispose();
    mark.output?.dispose();
    mark.end?.dispose();
  }
  session.marks = [];
}

/** Extract the buffer text of the last completed command's output (between its
 * OSC 133;C marker and its OSC 133;D marker, falling back to the next prompt or
 * the buffer end), or null when there is no captured output. */
function lastCommandOutput(session: ManagedSession): string | null {
  pruneMarks(session);
  let index = -1;
  for (let i = session.marks.length - 1; i >= 0; i--) {
    const output = session.marks[i].output;
    if (output && !output.isDisposed) {
      index = i;
      break;
    }
  }
  if (index === -1) return null;
  const mark = session.marks[index];
  const buffer = session.term.buffer.active;
  const start = mark.output!.line;
  let end: number;
  if (mark.end && !mark.end.isDisposed) {
    end = mark.end.line;
  } else {
    end = buffer.baseY + session.term.rows;
    for (let i = index + 1; i < session.marks.length; i++) {
      const next = session.marks[i].prompt;
      if (!next.isDisposed && next.line > start) {
        end = next.line;
        break;
      }
    }
  }
  const lines: string[] = [];
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    if (line) lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;
  return lines.join("\n");
}

async function spawnBackend(sessionId: string): Promise<ManagedSpawnResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("unknown session");
  const { term, descriptor } = session;
  // Claim this attempt. Any exit/completion tagged with an older generation
  // belongs to a superseded spawn (restart race) and is ignored below.
  const generation = ++session.spawnGeneration;
  session.exited = false;
  session.backendId = null;
  // A restart is a different agent process on a different backend id; whatever
  // the previous one had on screen says nothing about this one.
  session.agentSignals?.reset();

  /* A backend exit can arrive BEFORE its spawn invoke resolves (a command that
   * exits instantly, or an SSH connection that closes during auth). Route every
   * exit through here so the ordering rules hold for local, SSH, and serial:
   *  - Exits from a superseded attempt (generation moved on) are dropped.
   *  - Exits after disposal are dropped (nothing to report to).
   *  - Otherwise mark the session exited exactly once. When the invoke later
   *    resolves it checks session.exited and refuses to resurrect the session. */
  const handleExit = (exit: SessionExit) => {
    if (session.spawnGeneration !== generation || session.disposed) return;
    if (session.exited) return;
    session.exited = true;
    session.backendId = null;
    session.queuedInput.length = 0;
    session.pendingInput.length = 0;
    session.callbacks.onExit(exit);
  };

  if (descriptor.kind === "ssh") {
    session.sshTranscript = "";
    session.lastPromptSignature = "";
    session.sshStage = "starting";
    session.sshFinalizing = false;
  }

  const handleData = (data: Uint8Array | string) => {
    term.write(data);
    // Metadata only: the tracker re-reads the rendered screen from xterm once
    // output settles. No bytes are handed to it.
    session.agentSignals?.onOutput();
    // Collaboration tap: hand the SAME bytes to the room broadcaster (if this
    // session is being shared) before any SSH transcript scraping. Bytes go
    // manager → tap directly; they never enter React state.
    if (session.outputTap) {
      const bytes =
        typeof data === "string" ? new TextEncoder().encode(data) : data;
      session.outputTap(bytes);
    }
    const subscribers = outputSubscribers.get(session.id);
    if (subscribers?.size) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      for (const subscriber of subscribers) subscriber(bytes);
    }
    if (descriptor.kind !== "ssh") return;
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    session.sshTranscript = (session.sshTranscript + text).slice(-16_384);
    const readableTranscript = session.sshTranscript
      // Matching terminal control characters (ESC/BEL) is intentional here: this
      // strips OSC and CSI escape sequences from the transcript before scanning it.
      // oxlint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      // oxlint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const reportStage = (stage: ManagedSession["sshStage"]) => {
      if (session.sshStage === stage) return;
      session.sshStage = stage;
      session.callbacks.onSshProgress(stage);
    };
    if (/__LUMA_SSH_AUTHENTICATED__/.test(readableTranscript)) reportStage("authentication");
    if (!session.sshFinalizing && /__LUMA_SSH_AUTHENTICATED__/.test(readableTranscript)) {
      session.sshFinalizing = true;
      // Keep the overlay visible until the local authentication marker settles,
      // then reveal a clean terminal and ask the remote shell to redraw.
      window.setTimeout(() => {
        if (session.disposed || session.exited) return;
        session.sshTranscript = "";
        session.lastPromptSignature = "";
        term.clear();
        enqueueInput(session, "\r");
        session.callbacks.onSshAuthenticated();
      }, 750);
      return;
    }
    const embeddedPrompt = latestEmbeddedSshPrompt(readableTranscript);
    if (embeddedPrompt && embeddedPrompt.signature !== session.lastPromptSignature) {
      session.lastPromptSignature = embeddedPrompt.signature;
      session.callbacks.onSshPrompt({
        type: "credential",
        ...embeddedPrompt.prompt,
      });
    }
  };

  let result: ManagedSpawnResult;
  if (descriptor.kind === "serial") {
    const spawned = await spawnSerial(
      descriptor.config,
      // Serial bytes flow straight into xterm.js, never through React state.
      handleData,
      // Serial reports null on a clean disconnect; the store maps null/0 to
      // the "disconnected" state (no error category).
      (code) => handleExit({ code }),
    );
    result = { sessionId: spawned.sessionId, title: spawned.portName };
  } else if (descriptor.kind === "ssh") {
    const spawned = await spawnSsh(
      {
        hostId: descriptor.hostId,
        cols: term.cols,
        rows: term.rows,
        multiplexer: descriptor.multiplexer,
      },
      handleData,
      (payload: SshExitPayload) =>
        handleExit({
          code: payload.code,
          errorCategory: payload.errorCategory,
          errorMessage: payload.errorMessage,
        }),
      (osId, prettyName) => session.callbacks.onRemoteOs(osId, prettyName),
    );
    result = { sessionId: spawned.sessionId, title: spawned.title };
  } else if (descriptor.kind === "mosh") {
    // Authentication completes during the backend bootstrap (before the invoke
    // resolves), so there is no SSH transcript scraping for Mosh sessions.
    const spawned = await spawnMosh(
      { hostId: descriptor.hostId, cols: term.cols, rows: term.rows },
      handleData,
      (payload: SshExitPayload) =>
        handleExit({
          code: payload.code,
          errorCategory: payload.errorCategory,
          errorMessage: payload.errorMessage,
        }),
    );
    result = { sessionId: spawned.sessionId, title: spawned.title };
  } else {
    const spawned = await spawnPty(
      { cols: term.cols, rows: term.rows, ref: descriptor.ref },
      handleData,
      (code) => handleExit({ code }),
    );
    result = { sessionId: spawned.sessionId, title: spawned.shellName };
  }

  if (session.disposed) {
    // Session was closed while the backend was spawning.
    void killBackend(descriptor, result.sessionId).catch(() => {});
    throw new Error(SPAWN_ABANDONED);
  }
  if (session.spawnGeneration !== generation) {
    // A newer spawn (restart) superseded this attempt while it was in flight.
    // The newer attempt owns the session; kill the backend we just orphaned.
    void killBackend(descriptor, result.sessionId).catch(() => {});
    throw new Error(SPAWN_ABANDONED);
  }
  if (session.exited) {
    // The backend already exited before this invoke resolved. Its exit was
    // reported by handleExit; do NOT install the (now-dead) backend id, reset
    // the exited flag, or flush pendingInput into a session that is gone.
    return result;
  }
  session.backendId = result.sessionId;
  session.queuedInput.push(...session.pendingInput.splice(0));
  pumpInput(session);
  return result;
}

export const terminalManager = {
  configure(partial: Partial<ManagerConfig>): void {
    const previous = config;
    config = { ...config, ...partial };
    for (const session of sessions.values()) {
      if (partial.fontSize !== undefined && partial.fontSize !== previous.fontSize) {
        session.term.options.fontSize = partial.fontSize;
        this.fitSession(sessionIdOf(session));
      }
      if (partial.scrollback !== undefined && partial.scrollback !== previous.scrollback) {
        session.term.options.scrollback = partial.scrollback;
      }
      if (partial.theme !== undefined && partial.theme !== previous.theme) {
        session.term.options.theme = currentTheme();
      }
    }
  },

  /**
   * Apply Appearance styling (color scheme + font) to every live session and to
   * the config new sessions inherit. Each key is optional so a single setting can
   * be changed in isolation:
   *  - `scheme`: an explicit xterm theme to override the light/dark default, or
   *    null to follow the app mode (AUTO). Presence of the key is what matters —
   *    passing `scheme: null` clears an override; omitting it leaves it untouched.
   *  - `fontFamily`: a CSS font stack; empty/whitespace falls back to the default.
   *  - `fontSize`: point size (already validated/clamped by the caller).
   * Terminal bytes never pass through here; only xterm render options change.
   */
  applyTerminalStyle(style: {
    scheme?: ITheme | null;
    fontFamily?: string;
    fontSize?: number;
  }): void {
    const schemeChanged = Object.prototype.hasOwnProperty.call(style, "scheme");
    if (schemeChanged) schemeOverride = style.scheme ?? null;
    if (style.fontFamily !== undefined) {
      config.fontFamily = style.fontFamily.trim() || DEFAULT_TERMINAL_FONT_FAMILY;
    }
    if (style.fontSize !== undefined) config.fontSize = style.fontSize;
    for (const session of sessions.values()) {
      if (schemeChanged) session.term.options.theme = currentTheme();
      if (style.fontFamily !== undefined) {
        session.term.options.fontFamily = config.fontFamily;
      }
      if (style.fontSize !== undefined) session.term.options.fontSize = config.fontSize;
      // Font changes alter cell metrics, so the grid must be refit; a scheme-only
      // change does not, but refitting is cheap and safe.
      if (style.fontFamily !== undefined || style.fontSize !== undefined) {
        this.fitSession(session.id);
      }
    }
  },

  defaultShellRef(): ShellRef | undefined {
    return config.defaultShell;
  },

  /** Replace the set of global app chords the terminal's custom key handler
   * swallows (so they bubble to the window handler in Layout). Called by the
   * keymap store on load and after every rebind. Unbindable chords (missing a
   * required modifier) are ignored so terminal typing is never shadowed. */
  setAppChords(chords: string[]): void {
    appChords = chords
      .map(parseChord)
      .filter((chord): chord is Chord => chord !== null && hasRequiredModifier(chord));
  },

  /** The current BACKEND session id (what pty_spawn / ssh_spawn returned) for a
   * managed session, or null when it has not spawned, has exited, or is unknown.
   * This is the id the session-logging commands expect — never the store's
   * session id. It changes on every restart, so callers must not cache it. */
  getBackendId(sessionId: string): string | null {
    return sessions.get(sessionId)?.backendId ?? null;
  },

  /** Current grid size of a session's terminal, or null when unknown. */
  getDimensions(sessionId: string): { cols: number; rows: number } | null {
    const term = sessions.get(sessionId)?.term;
    return term ? { cols: term.cols, rows: term.rows } : null;
  },

  /** Resize a session's xterm grid directly (a backend session's onResize
   * handler then propagates the size to its PTY). Used by detached windows:
   * the display copy fits to the new window and the real session mirrors that
   * size here, so the shell redraws for the grid actually on screen. */
  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    const session = sessions.get(sessionId);
    if (!session || session.disposed || cols < 1 || rows < 1) return;
    if (session.term.cols === cols && session.term.rows === rows) return;
    session.term.resize(cols, rows);
  },

  /** The session's scrollback + viewport as replayable text, WITH the SGR
   * escapes needed to reproduce its colors and styling. `translateToString`
   * alone returns bare characters, which is why a replayed buffer used to
   * arrive completely uncolored. */
  getBufferText(sessionId: string): string {
    const buffer = sessions.get(sessionId)?.term.buffer.active;
    if (!buffer) return "";
    const cell = buffer.getNullCell();
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (!line) {
        lines.push("");
        continue;
      }
      let text = "";
      let style = "";
      let pendingBlanks = "";
      for (let column = 0; column < line.length; column += 1) {
        if (!line.getCell(column, cell)) break;
        // Width 0 means this cell is the tail of a preceding wide glyph; its
        // characters already came through with that glyph.
        if (cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        const nextStyle = cellStyle(cell);
        // Trailing run of unstyled blanks is dropped, matching the old
        // trimRight behaviour, but only once the line is known to end.
        if (chars === " " && nextStyle === "") {
          pendingBlanks += chars;
          continue;
        }
        if (pendingBlanks !== "") {
          // Close the open run before the gap: these blanks carry no styling,
          // so emitting them under a live background colour would paint it.
          if (style !== "") {
            text += "\x1b[0m";
            style = "";
          }
          text += pendingBlanks;
          pendingBlanks = "";
        }
        if (nextStyle !== style) {
          // SGR attributes are cumulative, so a switch out of a non-default
          // style needs a reset first or the previous run's bold/colour leaks.
          text += style === "" ? nextStyle : `\x1b[0m${nextStyle}`;
          style = nextStyle;
        }
        text += chars;
      }
      lines.push(style === "" ? text : `${text}\x1b[0m`);
    }
    // Drop the empty viewport rows below the last content. Replaying them into
    // another terminal would push the cursor to the bottom of a full screen of
    // blanks, leaving a large gap before the shell's next redraw.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\r\n");
  },

  /** The last working directory this session reported via OSC 7 / OSC 1337, or
   * null when the shell has never reported one (no shell integration). */
  getCwd(sessionId: string): string | null {
    return sessions.get(sessionId)?.lastReportedCwd ?? null;
  },

  /** Lightweight metadata for this session's live command marks (oldest first).
   * Metadata only — markers/decorations never cross into React. */
  getCommandMarks(sessionId: string): CommandMarkInfo[] {
    const session = sessions.get(sessionId);
    if (!session) return [];
    pruneMarks(session);
    return session.marks
      .filter((mark) => !mark.prompt.isDisposed)
      .map((mark) => ({
        line: mark.prompt.line,
        exitCode: mark.exitCode,
        failed: mark.exitCode !== null && mark.exitCode !== 0,
      }));
  },

  /**
   * Turn the autocomplete overlay on or off globally (persisted setting; off by
   * default). Turning it off immediately hides every overlay and stops the
   * manager observing input, so no command is recorded while it is disabled.
   */
  setAutocompleteEnabled(enabled: boolean): void {
    if (autocompleteEnabled === enabled) return;
    autocompleteEnabled = enabled;
    for (const session of sessions.values()) {
      session.autocomplete = newAutocompleteSession();
      notifyAutocomplete(session);
    }
  },

  /** Whether the autocomplete overlay is enabled. */
  autocompleteEnabled(): boolean {
    return autocompleteEnabled;
  },

  /** What the suggestion sources need in order to complete for this session, or
   * null when the session cannot be completed for (unknown, display-only, or a
   * serial console). */
  autocompleteContext(sessionId: string): AutocompleteContext | null {
    const session = sessions.get(sessionId);
    if (!session || session.display) return null;
    const scopeKey = autocompleteScope(session.descriptor);
    if (!scopeKey) return null;
    return {
      scopeKey,
      hostId: autocompleteHostId(session.descriptor),
      cwd: session.lastReportedCwd,
    };
  },

  /** Observe a session's input buffer and overlay state. The payload is small
   * metadata (the typed line and the ranked suggestion strings) — terminal
   * output never flows through it. */
  subscribeAutocomplete(
    sessionId: string,
    subscriber: (view: AutocompleteView) => void,
  ): () => void {
    const subscribers = autocompleteSubscribers.get(sessionId) ?? new Set();
    subscribers.add(subscriber);
    autocompleteSubscribers.set(sessionId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) autocompleteSubscribers.delete(sessionId);
    };
  },

  /** Current overlay snapshot for a session. */
  autocompleteState(sessionId: string): AutocompleteView {
    const session = sessions.get(sessionId);
    if (!session) {
      return {
        enabled: autocompleteEnabled,
        buffer: "",
        desynced: false,
        open: false,
        suggestions: [],
        selectedIndex: 0,
        revision: 0,
      };
    }
    return autocompleteView(session);
  },

  /**
   * Publish a freshly computed suggestion list. `buffer` is the line the list
   * was computed FOR: a result that raced a keystroke is dropped, because a
   * list built for a different line could complete into the wrong text.
   */
  setAutocompleteSuggestions(
    sessionId: string,
    buffer: string,
    suggestions: Suggestion[],
  ): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    const state = session.autocomplete;
    if (state.input.desynced || state.input.text !== buffer) return;
    state.suggestions = suggestions.slice(0, MAX_SUGGESTIONS);
    state.selectedIndex = 0;
    notifyAutocomplete(session);
  },

  /** Accept a suggestion row by index (an overlay click), writing only the
   * missing suffix. Returns whether anything was written. */
  acceptAutocompleteSuggestion(sessionId: string, index: number): boolean {
    const session = sessions.get(sessionId);
    if (!session || !isAutocompleteOpen(session)) return false;
    if (index < 0 || index >= session.autocomplete.suggestions.length) return false;
    session.autocomplete.selectedIndex = index;
    const accepted = acceptAutocomplete(session);
    session.term.focus();
    return accepted;
  },

  /** Close the overlay for the current line (Escape, or clicking away). */
  dismissAutocomplete(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) dismissAutocompleteSession(session);
  },

  /** Whether this session has any live prompt marks (drives enabled state of the
   * prompt-jump / copy-output affordances). */
  hasCommandMarks(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;
    pruneMarks(session);
    return session.marks.some((mark) => !mark.prompt.isDisposed);
  },

  /** Scroll the viewport to the previous/next prompt-start mark relative to the
   * current viewport top. No-op when there are no (live) marks. */
  jumpToPrompt(sessionId: string, direction: "previous" | "next"): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    pruneMarks(session);
    const lines = session.marks
      .filter((mark) => !mark.prompt.isDisposed)
      .map((mark) => mark.prompt.line)
      .sort((a, b) => a - b);
    if (lines.length === 0) return;
    const reference = session.term.buffer.active.viewportY;
    let target: number | undefined;
    if (direction === "previous") {
      for (const line of lines) if (line < reference) target = line;
    } else {
      target = lines.find((line) => line > reference);
    }
    if (target === undefined) return;
    session.term.scrollToLine(target);
  },

  /** Copy the last completed command's output (OSC 133 C..D range) to the
   * clipboard. Returns whether any output was captured (false becomes a no-op
   * for the palette/context-menu entries on sessions without shell integration). */
  copyLastCommandOutput(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;
    const text = lastCommandOutput(session);
    if (text === null) return false;
    void navigator.clipboard?.writeText(text);
    return true;
  },

  /** Copy this session's last reported working directory to the clipboard.
   * Returns whether a cwd was available. */
  copyCwd(sessionId: string): boolean {
    const cwd = sessions.get(sessionId)?.lastReportedCwd ?? null;
    if (!cwd) return false;
    void navigator.clipboard?.writeText(cwd);
    return true;
  },

  async createSession(
    sessionId: string,
    descriptor: SpawnDescriptor,
    callbacks: SessionCallbacks,
  ): Promise<ManagedSpawnResult> {
    // Resolve the configured default shell for local sessions launched without
    // an explicit ref (the + button / Ctrl+Shift+T).
    const resolved: SpawnDescriptor =
      descriptor.kind === "local"
        ? { kind: "local", ref: descriptor.ref ?? config.defaultShell }
        : descriptor;
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: config.fontFamily,
      fontSize: config.fontSize,
      scrollback: config.scrollback,
      theme: currentTheme(),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void openUrl(uri);
      }),
    );

    const session: ManagedSession = {
      id: sessionId,
      term,
      fit,
      search,
      backendId: null,
      descriptor: resolved,
      callbacks,
      broadcastPeers: null,
      pendingInput: [],
      queuedInput: [],
      writeInFlight: false,
      exited: false,
      spawnGeneration: 0,
      disposed: false,
      sshTranscript: "",
      lastPromptSignature: "",
      sshStage: "starting",
      sshFinalizing: false,
      resizeTimer: null,
      marks: [],
      lastReportedCwd: null,
      agentSignals: null,
      autocomplete: newAutocompleteSession(),
      pendingModifier: null,
      onModifierConsumed: null,
      outputTap: null,
      display: false,
      onInput: null,
    };
    sessions.set(sessionId, session);

    session.agentSignals = createAgentSignalTracker(session);
    installKeyHandlers(session);
    registerShellIntegration(session);
    term.onBell(() => {
      session.agentSignals?.onBell();
    });
    term.onTitleChange((title) => {
      if (title.trim()) callbacks.onTitle(title);
    });
    term.onData((data) => {
      routeUserInput(session, data);
    });
    term.onResize(({ cols, rows }) => {
      // Serial has no cols/rows: fit the local xterm but never resize the
      // backend (there is deliberately no serial resize command).
      if (session.backendId && session.descriptor.kind !== "serial") {
        if (session.resizeTimer !== null) window.clearTimeout(session.resizeTimer);
        session.resizeTimer = window.setTimeout(() => {
          session.resizeTimer = null;
          if (session.disposed || session.exited || !session.backendId) return;
          void resizeBackend(session.descriptor, session.backendId, cols, rows);
        }, BACKEND_RESIZE_DEBOUNCE_MS);
      }
    });

    const pendingHost = pendingHosts.get(sessionId);
    if (pendingHost) {
      pendingHosts.delete(sessionId);
      this.attach(sessionId, pendingHost);
    }

    try {
      return await spawnBackend(sessionId);
    } catch (error) {
      // An abandoned attempt (disposal / superseding restart) must not touch the
      // shared `exited` flag: it now belongs to the disposal or the newer spawn.
      if (!isSpawnAbandoned(error) && !session.disposed) session.exited = true;
      throw error;
    }
  },

  /** Replace a session's spawn descriptor before a restart. Used by the store's
   * Mosh auto-fallback: a failed "mosh" attempt is retried as plain "ssh" on the
   * SAME managed session so the pane and xterm instance are preserved. Metadata
   * only — never terminal bytes. */
  setDescriptor(sessionId: string, descriptor: SpawnDescriptor): void {
    const session = sessions.get(sessionId);
    if (session) session.descriptor = descriptor;
  },

  /**
   * Mount the terminal into a host element (tab activation).
   *
   * `focus: false` is for a surface that must not take focus when it appears —
   * a preview mirror, which would otherwise pull focus off the screen it sits on
   * (and, on mobile, could raise the soft keyboard). `accelerated: false` keeps
   * it off the WebGL renderer; see the call site below.
   */
  attach(
    sessionId: string,
    host: HTMLElement,
    options: { focus?: boolean; accelerated?: boolean } = {},
  ): void {
    const takeFocus = options.focus !== false;
    const session = sessions.get(sessionId);
    if (!session) {
      pendingHosts.set(sessionId, host);
      return;
    }
    pendingHosts.delete(sessionId);
    // A freshly created terminal renders on open(); an already-opened one is
    // being re-attached after a tab switch and needs an explicit repaint below.
    const existing = session.term.element;
    const reattaching = existing !== undefined;
    if (!existing) {
      session.term.open(host);
      // Prefer the same renderer on every platform. loadWebgl catches
      // initialization failures and disposes itself on context loss, leaving
      // xterm's built-in renderer as the automatic fallback.
      //
      // Previews opt out: a webview allows only a handful of live WebGL
      // contexts, and spending them on decorative miniatures risks evicting the
      // context of the terminal the user is actually working in.
      if (options.accelerated !== false) void loadWebgl(session.term);

      void bundledTerminalFontReady.then(() => {
        if (session.disposed || !session.term.element?.isConnected) return;
        this.fitSession(sessionId);
        session.term.refresh(0, session.term.rows - 1);
      });
    } else {
      host.appendChild(existing);
    }
    // fit() must run before spawnBackend reads term.cols/rows. Without this
    // synchronous fit a shell can print its first prompt into xterm's default
    // 80-column grid, leaving right-aligned prompt segments stranded near the
    // middle even after a later resize.
    this.fitSession(sessionId);
    requestAnimationFrame(() => {
      this.fitSession(sessionId);
      if (takeFocus) session.term.focus();
      // Re-appending a terminal element detaches and reconnects its canvases;
      // under the WebGL renderer the drawing buffer is cleared on detach, so an
      // idle session (no new output) would stay blank until it next writes.
      // fit() only refreshes when dimensions change, so force a full-viewport
      // repaint of the preserved buffer whenever we re-attach.
      if (reattaching) {
        session.term.refresh(0, session.term.rows - 1);
      }
      // Creating a tab and dropping one into a split both rebuild flex
      // geometry. The first frame can still reflect the old allocation, so
      // fit again once the new tree has completed a full layout cycle.
      requestAnimationFrame(() => this.fitSession(sessionId));
    });
  },

  /** Unmount from the DOM without destroying the terminal (tab switch). */
  detach(sessionId: string): void {
    pendingHosts.delete(sessionId);
    const session = sessions.get(sessionId);
    session?.term.element?.remove();
  },

  fitSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session?.term.element?.isConnected) return;
    try {
      session.fit.fit();
      dropOverflowingRow(session);
    } catch {
      // Ignore fit errors during teardown.
    }
  },

  focus(sessionId: string): void {
    sessions.get(sessionId)?.term.focus();
  },

  /** Whether the terminal currently has a text selection (drives the enabled
   * state of the right-click "Copy" action). */
  hasSelection(sessionId: string): boolean {
    return sessions.get(sessionId)?.term.hasSelection() ?? false;
  },

  /** Copy the current selection to the clipboard, mirroring the Ctrl+Shift+C
   * key handler. Terminal bytes never pass through React. */
  copySelection(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    const selection = session.term.getSelection();
    if (selection) void navigator.clipboard.writeText(selection);
    session.term.focus();
  },

  /** Paste clipboard text into the terminal, mirroring the Ctrl+Shift+V key
   * handler (bracketed-paste aware via xterm's paste path). */
  paste(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    void navigator.clipboard.readText().then((text) => {
      if (text) session.term.paste(text);
    });
    session.term.focus();
  },

  /** Select the entire terminal buffer. */
  selectAll(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.term.selectAll();
    session.term.focus();
  },

  /** Clear the terminal viewport (keeps the current prompt line). */
  clear(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.term.clear();
    session.term.focus();
  },

  /** Insert text at the prompt (snippet "Insert"). Uses xterm's paste path so
   * bracketed-paste-aware shells receive it as a single edit, not execution. */
  insertText(sessionId: string, text: string): void {
    const session = sessions.get(sessionId);
    if (!session || session.exited) return;
    session.term.paste(text);
    session.term.focus();
  },

  /** Send raw input to the backend PTY (snippet "Run" appends a carriage
   * return). Mirrors the onData path so pre-spawn input is queued. */
  sendInput(sessionId: string, data: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    observeAutocompleteInput(session, data);
    enqueueInput(session, data);
    session.term.focus();
  },

  /** Arm a one-shot sticky modifier (mobile accessory bar). The next character
   * the user types is sent as the matching Ctrl/Alt sequence, then the modifier
   * releases. Arming the same modifier again, or passing null, clears it.
   * `onConsumed` fires when typed input consumes the modifier so the bar can drop
   * its highlight. */
  setPendingModifier(
    sessionId: string,
    modifier: "ctrl" | "alt" | null,
    onConsumed?: () => void,
  ): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.pendingModifier = modifier;
    session.onModifierConsumed = modifier ? (onConsumed ?? null) : null;
  },

  /** Which one-shot modifier is currently armed for a session, or null. */
  pendingModifier(sessionId: string): "ctrl" | "alt" | null {
    return sessions.get(sessionId)?.pendingModifier ?? null;
  },

  /** Send a key/sequence from the mobile accessory row, applying any armed
   * one-shot modifier to it first (e.g. Ctrl then a tapped "c"). Explicit escape
   * sequences (arrows, Esc, Tab) are passed through with the modifier applied to
   * their first byte, matching how a hardware modifier would combine. */
  sendAccessoryKey(sessionId: string, data: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    let out = data;
    if (session.pendingModifier) {
      out = applyModifier(session.pendingModifier, data);
      session.pendingModifier = null;
      const notify = session.onModifierConsumed;
      session.onModifierConsumed = null;
      notify?.();
    }
    observeAutocompleteInput(session, out);
    enqueueInput(session, out);
    session.term.focus();
  },

  /** Reply to an interactive SSH CREDENTIAL prompt (password / private-key
   * passphrase) by writing it to the PTY. Host-key trust is NOT handled here —
   * it goes through the store's backend preflight before spawn. */
  answerSshPrompt(sessionId: string, value: string): void {
    const session = sessions.get(sessionId);
    if (!session || session.descriptor.kind !== "ssh") return;
    session.lastPromptSignature = "";
    session.sshTranscript = "";
    // Deliberately NOT observed: this is a password or key passphrase, and the
    // input tracker would see it as a line being submitted. Reset instead, so
    // nothing of it can reach the history table.
    resetAutocompleteLine(session);
    enqueueInput(session, `${value}\r`);
  },

  /**
   * Restart a session's backend, keeping the same xterm instance. By default the
   * terminal is fully reset (cleared scrollback + marks) — this is the manual
   * "Reconnect/Restart" path. Pass `{ preserveBuffer: true }` for auto-reconnect:
   * the existing scrollback is kept and a dim separator line is written so the
   * user sees continuity across the reconnect, and `reconnectAttempt` labels that
   * separator (e.g. "— reconnecting (attempt 2) —").
   */
  async restart(
    sessionId: string,
    options: { preserveBuffer?: boolean; reconnectAttempt?: number } = {},
  ): Promise<ManagedSpawnResult> {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("unknown session");
    if (session.resizeTimer !== null) {
      window.clearTimeout(session.resizeTimer);
      session.resizeTimer = null;
    }
    if (session.backendId) {
      const old = session.backendId;
      session.backendId = null;
      await killBackend(session.descriptor, old).catch(() => {});
    }
    session.queuedInput.length = 0;
    session.pendingInput.length = 0;
    session.lastReportedCwd = null;
    // A new backend means a new shell: nothing about the old input line, or the
    // shell-integration phase we inferred for it, still holds.
    session.autocomplete = newAutocompleteSession();
    notifyAutocomplete(session);
    if (options.preserveBuffer) {
      // Keep scrollback + marks; write a dim separator so the reconnect reads as
      // a continuation of the same pane rather than a wiped terminal.
      const label =
        options.reconnectAttempt && options.reconnectAttempt > 0
          ? `— reconnecting (attempt ${options.reconnectAttempt}) —`
          : "— reconnecting —";
      session.term.write(`\r\n\x1b[2m${label}\x1b[0m\r\n`);
    } else {
      clearMarks(session);
      session.term.reset();
    }
    return spawnBackend(sessionId);
  },

  findNext(sessionId: string, query: string, incremental = false): void {
    sessions.get(sessionId)?.search.findNext(query, { incremental });
  },

  findPrevious(sessionId: string, query: string): void {
    sessions.get(sessionId)?.search.findPrevious(query);
  },

  clearSearch(sessionId: string): void {
    sessions.get(sessionId)?.search.clearDecorations();
  },

  /**
   * Define (or redefine) the broadcast group for a tab: every listed session
   * that exists becomes a member, and input typed into any one of them fans out
   * to the others (see routeUserInput). React is the single source of truth for
   * membership — it recomputes the member list on toggle, per-pane exclude,
   * split, and close, then pushes it here. Passing fewer than two live members
   * disbands the group. Callers pass the COMPLETE desired membership; any session
   * dropped from a previously larger group is detached automatically.
   */
  setBroadcastGroup(sessionIds: string[]): void {
    const members = sessionIds.filter((id) => sessions.has(id));
    // Detach everything currently linked to this group (via any member's shared
    // peer set) first, so members removed from the new list stop broadcasting.
    for (const id of sessionIds) {
      const existing = sessions.get(id)?.broadcastPeers;
      if (!existing) continue;
      for (const peerId of existing) {
        const peer = sessions.get(peerId);
        if (peer) peer.broadcastPeers = null;
      }
    }
    if (members.length < 2) return;
    const group = new Set(members);
    for (const id of members) {
      sessions.get(id)!.broadcastPeers = group;
    }
  },

  /** Remove a single session from its broadcast group (per-pane opt-out or
   * teardown), disbanding the group when it would drop below two members. */
  clearBroadcastGroup(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) detachFromBroadcast(session);
  },

  /** Whether a managed session (backend or display-only) exists for this id. */
  isKnown(sessionId: string): boolean {
    return sessions.has(sessionId);
  },

  /**
   * Install a collaboration output tap on a live backend session: every chunk of
   * output bytes written into xterm is also delivered to `tap` so the collab
   * client can encrypt + broadcast it. No-op for a display-only session (it has
   * no backend output to tap). Bytes flow manager → tap directly and never enter
   * React state.
   */
  setOutputTap(sessionId: string, tap: (data: Uint8Array) => void): void {
    const session = sessions.get(sessionId);
    if (!session || session.display) return;
    session.outputTap = tap;
  },

  /** Remove a session's collaboration output tap (stop sharing). */
  clearOutputTap(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) session.outputTap = null;
  },

  subscribeOutput(sessionId: string, subscriber: (data: Uint8Array) => void): () => void {
    const subscribers = outputSubscribers.get(sessionId) ?? new Set();
    subscribers.add(subscriber);
    outputSubscribers.set(sessionId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) outputSubscribers.delete(sessionId);
    };
  },

  /**
   * Inject remote controller input into a shared backend session's PTY. Mirrors
   * the local typing path (coalesced write lane) but never steals focus, so the
   * owner keeps typing while a controller's keystrokes are applied. The PTY's
   * echo flows back through the normal output tap to every room member.
   */
  injectInput(sessionId: string, data: string): void {
    const session = sessions.get(sessionId);
    if (!session || session.display) return;
    // A remote controller edits the same line from somewhere we cannot model
    // (their cursor, their history recall), so stop trusting the buffer.
    desyncAutocomplete(session);
    enqueueInput(session, data);
  },

  /**
   * Create a display-only terminal for a shared-terminal viewer/controller. It
   * has NO backend PTY: it renders decrypted remote output written via
   * `writeOutput` and forwards locally-typed input to `onInput` (the collab
   * client encrypts it as terminal.input; pass a no-op or leave input unhandled
   * for a read-only viewer). Attach/detach/fit/dispose reuse the normal manager
   * plumbing.
   */
  createDisplaySession(
    sessionId: string,
    options: {
      onInput?: (data: string) => void;
      /** Notified when this display terminal's grid is refit (window resize).
       * Detached windows forward this to the real session so the backend PTY
       * matches the grid actually on screen. */
      onResize?: (cols: number, rows: number) => void;
    } = {},
  ): void {
    if (sessions.has(sessionId)) return;
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: false,
      disableStdin: options.onInput === undefined,
      fontFamily: config.fontFamily,
      fontSize: config.fontSize,
      scrollback: config.scrollback,
      theme: currentTheme(),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void openUrl(uri);
      }),
    );

    const session: ManagedSession = {
      id: sessionId,
      term,
      fit,
      search,
      backendId: null,
      descriptor: { kind: "local", ref: undefined },
      callbacks: {
        onTitle: () => {},
        onExit: () => {},
        onSearchRequested: () => {},
        onSshAuthenticated: () => {},
        onSshPrompt: () => {},
        onSshProgress: () => {},
          onRemoteOs: () => {},
      },
      broadcastPeers: null,
      pendingInput: [],
      queuedInput: [],
      writeInFlight: false,
      exited: false,
      spawnGeneration: 0,
      disposed: false,
      sshTranscript: "",
      lastPromptSignature: "",
      sshStage: "starting",
      sshFinalizing: false,
      resizeTimer: null,
      marks: [],
      lastReportedCwd: null,
      agentSignals: null,
      autocomplete: newAutocompleteSession(),
      pendingModifier: null,
      onModifierConsumed: null,
      outputTap: null,
      display: true,
      onInput: options.onInput ?? null,
    };
    sessions.set(sessionId, session);

    term.onData((data) => routeUserInput(session, data));
    if (options.onResize) {
      const onResize = options.onResize;
      term.onResize(({ cols, rows }) => {
        if (session.resizeTimer !== null) window.clearTimeout(session.resizeTimer);
        session.resizeTimer = window.setTimeout(() => {
          session.resizeTimer = null;
          if (!session.disposed) onResize(cols, rows);
        }, BACKEND_RESIZE_DEBOUNCE_MS);
      });
    }

    const pendingHost = pendingHosts.get(sessionId);
    if (pendingHost) {
      pendingHosts.delete(sessionId);
      this.attach(sessionId, pendingHost);
    }
  },

  /**
   * Mirror a live session into a second, read-only terminal so another surface
   * can show what it is doing — the mobile Connections list previews each open
   * session this way.
   *
   * The mirror is a display session with no backend: it is seeded with the tail
   * of the source's buffer and then fed the very same output bytes the source
   * receives. Both halves run inside the manager, so a preview never puts
   * terminal bytes on a React path; the caller only attaches a host element.
   *
   * Fidelity is deliberately limited to what a small card can honestly show:
   * the mirror fits its own container, so it re-wraps rather than reproducing
   * the source's grid, and a full-screen TUI (which addresses absolute cursor
   * positions in the source's geometry) will look approximate. Line-oriented
   * shell output — the case a preview is for — matches.
   *
   * @param previewId Id for the mirror; must not collide with a real session.
   * @param sourceId The live session to mirror.
   * @returns a teardown that stops mirroring and disposes the mirror. Safe to
   * call when the source does not exist: nothing is created and teardown no-ops.
   */
  mirrorSession(
    previewId: string,
    sourceId: string,
    options: { lines?: number } = {},
  ): () => void {
    if (!sessions.has(sourceId) || sessions.has(previewId)) return () => {};
    // No onInput: createDisplaySession then sets disableStdin, so the mirror is
    // read-only and cannot send anything to the source's PTY.
    this.createDisplaySession(previewId);
    // Each serialized line closes its own SGR state, so slicing to a tail keeps
    // colors intact and spares the mirror a full scrollback replay.
    const seed = this.getBufferText(sourceId);
    const lines = options.lines ?? PREVIEW_SEED_LINES;
    const tail = seed.split("\r\n").slice(-lines).join("\r\n");
    this.writeOutput(previewId, tail);
    const unsubscribe = this.subscribeOutput(sourceId, (bytes) =>
      this.writeOutput(previewId, bytes),
    );
    return () => {
      unsubscribe();
      this.dispose(previewId);
    };
  },

  /** Clear a display-only session's screen and scrollback, so a buffer snapshot
   * can be (re)applied without stacking on whatever it already showed. */
  resetOutput(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session || !session.display) return;
    session.term.reset();
    session.term.clear();
  },

  /** Write decrypted remote output bytes into a display-only session's xterm.
   * No-op for a backend session (its output comes from the PTY). */
  writeOutput(sessionId: string, data: Uint8Array | string): void {
    const session = sessions.get(sessionId);
    if (!session || !session.display) return;
    session.term.write(data);
  },

  /** Update a display session's control-input handler: pass a function when this
   * member gains the control lease, or null to make the viewer read-only. */
  setDisplayInput(sessionId: string, onInput: ((data: string) => void) | null): void {
    const session = sessions.get(sessionId);
    if (!session || !session.display) return;
    session.onInput = onInput;
    session.term.options.disableStdin = onInput === null;
  },

  dispose(sessionId: string): void {
    pendingHosts.delete(sessionId);
    const session = sessions.get(sessionId);
    if (!session) return;
    // Leave any broadcast group before teardown so a disposed session can never
    // be a fan-out target and a two-pane group collapses cleanly to none.
    detachFromBroadcast(session);
    session.disposed = true;
    session.queuedInput.length = 0;
    session.pendingInput.length = 0;
    session.agentSignals?.dispose();
    clearMarks(session);
    if (session.resizeTimer !== null) {
      window.clearTimeout(session.resizeTimer);
      session.resizeTimer = null;
    }
    if (session.backendId) {
      void killBackend(session.descriptor, session.backendId).catch(() => {});
      session.backendId = null;
    }
    session.term.dispose();
    sessions.delete(sessionId);
    outputSubscribers.delete(sessionId);
    autocompleteSubscribers.delete(sessionId);
  },
};

function sessionIdOf(target: ManagedSession): string {
  for (const [id, session] of sessions) {
    if (session === target) return id;
  }
  return "";
}
