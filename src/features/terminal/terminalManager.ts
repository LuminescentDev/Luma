import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";

import {
  killPty,
  resizePty,
  spawnPty,
  writePty,
  type ShellRef,
} from "../../lib/terminal";
import { spawnSsh, type SshExitPayload, type SshRemoteOsId } from "../../lib/ssh";
import {
  killSerial,
  spawnSerial,
  writeSerial,
  type SerialConfig,
} from "../../lib/serial";

/** What a managed session should launch. Local shells resolve a ShellRef;
 * SSH sessions send only a hostId (the backend owns the connection details);
 * serial sessions carry their full port config (the backend has no host record).
 */
export type SpawnDescriptor =
  | { kind: "local"; ref: ShellRef | undefined }
  | { kind: "ssh"; hostId: string }
  | { kind: "serial"; config: SerialConfig };

/** Write keyboard input to a backend session, routing serial sessions to the
 * serial command and everything else (local + ssh) to the shared PTY command. */
function writeBackend(
  descriptor: SpawnDescriptor,
  backendId: string,
  data: string,
): Promise<void> {
  return descriptor.kind === "serial"
    ? writeSerial(backendId, data)
    : writePty(backendId, data);
}

/** Kill a backend session, routing serial sessions to the serial command. */
function killBackend(
  descriptor: SpawnDescriptor,
  backendId: string,
): Promise<void> {
  return descriptor.kind === "serial"
    ? killSerial(backendId)
    : killPty(backendId);
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

const DARK_THEME: ITheme = {
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

const LIGHT_THEME: ITheme = {
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

const FONT_FAMILY =
  '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", monospace';

type SessionCallbacks = {
  onTitle: (title: string) => void;
  onExit: (exit: SessionExit) => void;
  onSearchRequested: () => void;
  onSshAuthenticated: () => void;
  /* Only the interactive credential prompt (password / private-key passphrase)
   * is scraped from the PTY. Host-key trust is handled by an explicit backend
   * preflight in the session store BEFORE spawn (StrictHostKeyChecking=yes means
   * OpenSSH never prints an interactive host-key prompt), so there is no
   * "host-key" variant here. */
  onSshPrompt: (prompt: { type: "credential"; label: string }) => void;
  onSshProgress: (stage: "starting" | "network" | "host-key" | "authentication" | "ready") => void;
  onSshIssue: (message: string) => void;
  /** Detected remote OS for an authenticated SSH session (drives the tab distro
   * logo). Metadata only — never terminal bytes. */
  onRemoteOs: (osId: SshRemoteOsId, prettyName: string | null) => void;
};

type ManagedSession = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  backendId: string | null;
  descriptor: SpawnDescriptor;
  callbacks: SessionCallbacks;
  pendingInput: string[];
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
  sshIssueReported: boolean;
  sshFinalizing: boolean;
  resizeTimer: ReturnType<typeof window.setTimeout> | null;
};

// Split-pane and window drags can produce dozens of xterm sizes per second.
// Sending every intermediate size makes remote prompt themes redraw repeatedly
// and asynchronous IPC calls can arrive out of order. Keep xterm responsive,
// but notify the backing PTY only after the layout has briefly settled.
const BACKEND_RESIZE_DEBOUNCE_MS = 100;

type ManagerConfig = {
  fontSize: number;
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
  scrollback: 5000,
  defaultShell: undefined,
  theme: "dark",
};

function isMac(): boolean {
  return navigator.userAgent.includes("Mac");
}

function currentTheme(): ITheme {
  return config.theme === "light" ? LIGHT_THEME : DARK_THEME;
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
    // App-level chords (new tab, split, close pane, command palette) must not
    // reach the shell. Returning false lets the event bubble to the global
    // window handler in Layout without inserting anything at the prompt.
    if (
      mod &&
      event.shiftKey &&
      ["KeyT", "KeyD", "KeyE", "KeyW", "KeyP"].includes(event.code)
    ) {
      return false;
    }
    // Workspace tab switching, handled by the global window handler in Layout.
    if (event.ctrlKey && event.code === "Tab") {
      return false;
    }
    if (mod && (event.code === "PageUp" || event.code === "PageDown")) {
      return false;
    }
    return true;
  });
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
    session.callbacks.onExit(exit);
  };

  if (descriptor.kind === "ssh") {
    session.sshTranscript = "";
    session.lastPromptSignature = "";
    session.sshStage = "starting";
    session.sshIssueReported = false;
    session.sshFinalizing = false;
  }

  const handleData = (data: Uint8Array | string) => {
    term.write(data);
    if (descriptor.kind !== "ssh") return;
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    session.sshTranscript = (session.sshTranscript + text).slice(-16_384);
    const readableTranscript = session.sshTranscript
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
    const reportStage = (stage: ManagedSession["sshStage"]) => {
      if (session.sshStage === stage) return;
      session.sshStage = stage;
      session.callbacks.onSshProgress(stage);
    };
    if (/__LUMA_SSH_AUTHENTICATED__/.test(readableTranscript)) reportStage("authentication");
    if (!session.sshIssueReported && /Load key [^\r\n]+: invalid format/i.test(readableTranscript)) {
      session.sshIssueReported = true;
      session.callbacks.onSshIssue("The selected identity's private key is not in a format OpenSSH can read. Re-save it as an OpenSSH or PEM private key.");
    }
    if (!session.sshFinalizing && /__LUMA_SSH_AUTHENTICATED__/.test(readableTranscript)) {
      session.sshFinalizing = true;
      // Keep the overlay visible until the local authentication marker settles,
      // then reveal a clean terminal and ask the remote shell to redraw.
      window.setTimeout(() => {
        if (session.disposed || session.exited) return;
        session.sshTranscript = "";
        session.lastPromptSignature = "";
        term.clear();
        if (session.backendId) void writePty(session.backendId, "\r");
        else session.pendingInput.push("\r");
        session.callbacks.onSshAuthenticated();
      }, 750);
      return;
    }
    // Host-key trust is resolved by the store's backend preflight before spawn;
    // OpenSSH (StrictHostKeyChecking=yes) never prints an interactive host-key
    // prompt here, so we only scrape interactive credential prompts.
    const credentialMatches = [...readableTranscript.matchAll(/(?:Enter passphrase for key '[^']+'|password):\s*/gi)];
    const credentialMatch = credentialMatches[credentialMatches.length - 1];
    if (credentialMatch) {
      const label = credentialMatch[0].toLowerCase().includes("passphrase") ? "Private key passphrase" : "Password";
      const signature = `credential:${credentialMatch[0]}`;
      if (signature !== session.lastPromptSignature) {
        session.lastPromptSignature = signature;
        session.callbacks.onSshPrompt({ type: "credential", label });
      }
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
      { hostId: descriptor.hostId, cols: term.cols, rows: term.rows },
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
  for (const chunk of session.pendingInput.splice(0)) {
    void writeBackend(descriptor, result.sessionId, chunk);
  }
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

  defaultShellRef(): ShellRef | undefined {
    return config.defaultShell;
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
      fontFamily: FONT_FAMILY,
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
      term,
      fit,
      search,
      backendId: null,
      descriptor: resolved,
      callbacks,
      pendingInput: [],
      exited: false,
      spawnGeneration: 0,
      disposed: false,
      sshTranscript: "",
      lastPromptSignature: "",
      sshStage: "starting",
      sshIssueReported: false,
      sshFinalizing: false,
      resizeTimer: null,
    };
    sessions.set(sessionId, session);

    installKeyHandlers(session);
    term.onTitleChange((title) => {
      if (title.trim()) callbacks.onTitle(title);
    });
    term.onData((data) => {
      if (session.backendId) void writeBackend(session.descriptor, session.backendId, data);
      else if (!session.exited) session.pendingInput.push(data);
    });
    term.onResize(({ cols, rows }) => {
      // Serial has no cols/rows: fit the local xterm but never resize the
      // backend (there is deliberately no serial resize command).
      if (session.backendId && session.descriptor.kind !== "serial") {
        if (session.resizeTimer !== null) window.clearTimeout(session.resizeTimer);
        session.resizeTimer = window.setTimeout(() => {
          session.resizeTimer = null;
          if (session.disposed || session.exited || !session.backendId) return;
          void resizePty(session.backendId, cols, rows);
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

  /** Mount the terminal into a host element (tab activation). */
  attach(sessionId: string, host: HTMLElement): void {
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
      void loadWebgl(session.term);
    } else {
      host.appendChild(existing);
    }
    requestAnimationFrame(() => {
      this.fitSession(sessionId);
      session.term.focus();
      // Re-appending a terminal element detaches and reconnects its canvases;
      // under the WebGL renderer the drawing buffer is cleared on detach, so an
      // idle session (no new output) would stay blank until it next writes.
      // fit() only refreshes when dimensions change, so force a full-viewport
      // repaint of the preserved buffer whenever we re-attach.
      if (reattaching) {
        session.term.refresh(0, session.term.rows - 1);
      }
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
    if (session.backendId) void writeBackend(session.descriptor, session.backendId, data);
    else if (!session.exited) session.pendingInput.push(data);
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
    if (session.backendId) void writePty(session.backendId, `${value}\r`);
    else session.pendingInput.push(`${value}\r`);
  },

  async restart(sessionId: string): Promise<ManagedSpawnResult> {
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
    session.term.reset();
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

  dispose(sessionId: string): void {
    pendingHosts.delete(sessionId);
    const session = sessions.get(sessionId);
    if (!session) return;
    session.disposed = true;
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
  },
};

function sessionIdOf(target: ManagedSession): string {
  for (const [id, session] of sessions) {
    if (session === target) return id;
  }
  return "";
}
