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
import { spawnSsh, type SshExitPayload } from "../../lib/ssh";

/** What a managed session should launch. Local shells resolve a ShellRef;
 * SSH sessions send only a hostId (the backend owns the connection details). */
export type SpawnDescriptor =
  | { kind: "local"; ref: ShellRef | undefined }
  | { kind: "ssh"; hostId: string };

/** Normalized exit info delivered to the session store. `errorCategory` is only
 * populated for SSH failures; local shells report a plain exit code. */
export type SessionExit = {
  code: number | null;
  errorCategory?: string | null;
  errorMessage?: string | null;
};

/** Normalized spawn result across local and SSH backends. */
export type ManagedSpawnResult = { sessionId: string; title: string };

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
  onSshPrompt: (prompt: { type: "host-key"; host: string; fingerprint: string } | { type: "credential"; label: string }) => void;
  onSshProgress: (stage: "starting" | "network" | "host-key" | "authentication" | "ready") => void;
  onSshIssue: (message: string) => void;
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
  disposed: boolean;
  sshTranscript: string;
  lastPromptSignature: string;
  sshStage: "starting" | "network" | "host-key" | "authentication" | "ready";
  sshIssueReported: boolean;
  sshFinalizing: boolean;
};

type ManagerConfig = {
  fontSize: number;
  scrollback: number;
  defaultShell?: ShellRef;
  theme: "dark" | "light";
};

const sessions = new Map<string, ManagedSession>();

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
    return true;
  });
}

async function spawnBackend(sessionId: string): Promise<ManagedSpawnResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("unknown session");
  const { term, descriptor } = session;
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
    if (/Connecting to .+ port \d+/.test(readableTranscript)) reportStage("network");
    if (/Server host key:/.test(readableTranscript)) reportStage("host-key");
    if (/Authentications that can continue:|Offering public key:/.test(readableTranscript)) reportStage("authentication");
    if (!session.sshIssueReported && /Load key [^\r\n]+: invalid format/i.test(readableTranscript)) {
      session.sshIssueReported = true;
      session.callbacks.onSshIssue("The selected identity's private key is not in a format OpenSSH can read. Re-save it as an OpenSSH or PEM private key.");
    }
    if (!session.sshFinalizing && /Authenticated to .+ \(/.test(readableTranscript)) {
      session.sshFinalizing = true;
      // OpenSSH emits a short tail of verbose negotiation and known_hosts
      // maintenance after authentication. Keep the connection overlay visible
      // until that burst settles, then reveal a clean terminal and ask the
      // remote shell to redraw its prompt.
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
    const hostMatch = readableTranscript.match(/authenticity of host '([^']+)' can't be established[\s\S]*?key fingerprint is ([^\r\n.]+)/i);
    if (/Are you sure you want to continue connecting/.test(readableTranscript) && hostMatch) {
      const signature = `host:${hostMatch[1]}:${hostMatch[2]}`;
      if (signature !== session.lastPromptSignature) {
        session.lastPromptSignature = signature;
        session.callbacks.onSshPrompt({ type: "host-key", host: hostMatch[1], fingerprint: hostMatch[2].trim() });
      }
      return;
    }
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
  if (descriptor.kind === "ssh") {
    const spawned = await spawnSsh(
      { hostId: descriptor.hostId, cols: term.cols, rows: term.rows },
      handleData,
      (payload: SshExitPayload) => {
        session.exited = true;
        session.backendId = null;
        session.callbacks.onExit({
          code: payload.code,
          errorCategory: payload.errorCategory,
          errorMessage: payload.errorMessage,
        });
      },
    );
    result = { sessionId: spawned.sessionId, title: spawned.title };
  } else {
    const spawned = await spawnPty(
      { cols: term.cols, rows: term.rows, ref: descriptor.ref },
      handleData,
      (code) => {
        session.exited = true;
        session.backendId = null;
        session.callbacks.onExit({ code });
      },
    );
    result = { sessionId: spawned.sessionId, title: spawned.shellName };
  }

  if (session.disposed) {
    // Session was closed while the backend was spawning.
    void killPty(result.sessionId);
    throw new Error("session closed");
  }
  session.backendId = result.sessionId;
  session.exited = false;
  for (const chunk of session.pendingInput.splice(0)) {
    void writePty(result.sessionId, chunk);
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
      disposed: false,
      sshTranscript: "",
      lastPromptSignature: "",
      sshStage: "starting",
      sshIssueReported: false,
      sshFinalizing: false,
    };
    sessions.set(sessionId, session);

    installKeyHandlers(session);
    term.onTitleChange((title) => {
      if (title.trim()) callbacks.onTitle(title);
    });
    term.onData((data) => {
      if (session.backendId) void writePty(session.backendId, data);
      else if (!session.exited) session.pendingInput.push(data);
    });
    term.onResize(({ cols, rows }) => {
      if (session.backendId) void resizePty(session.backendId, cols, rows);
    });

    try {
      return await spawnBackend(sessionId);
    } catch (error) {
      if (!session.disposed) session.exited = true;
      throw error;
    }
  },

  /** Mount the terminal into a host element (tab activation). */
  attach(sessionId: string, host: HTMLElement): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (!session.term.element) {
      session.term.open(host);
      void loadWebgl(session.term);
    } else {
      host.appendChild(session.term.element);
    }
    requestAnimationFrame(() => {
      this.fitSession(sessionId);
      session.term.focus();
    });
  },

  /** Unmount from the DOM without destroying the terminal (tab switch). */
  detach(sessionId: string): void {
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
    if (session.backendId) void writePty(session.backendId, data);
    else if (!session.exited) session.pendingInput.push(data);
    session.term.focus();
  },

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
    if (session.backendId) {
      const old = session.backendId;
      session.backendId = null;
      await killPty(old).catch(() => {});
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
    const session = sessions.get(sessionId);
    if (!session) return;
    session.disposed = true;
    if (session.backendId) {
      void killPty(session.backendId).catch(() => {});
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
