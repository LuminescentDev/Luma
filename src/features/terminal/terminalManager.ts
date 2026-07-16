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
  type SpawnResult,
} from "../../lib/terminal";

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
  onExit: (code: number | null) => void;
  onSearchRequested: () => void;
};

type ManagedSession = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  backendId: string | null;
  ref: ShellRef | undefined;
  callbacks: SessionCallbacks;
  pendingInput: string[];
  exited: boolean;
  disposed: boolean;
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
    return true;
  });
}

async function spawnBackend(sessionId: string): Promise<SpawnResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("unknown session");
  const { term } = session;

  const result = await spawnPty(
    { cols: term.cols, rows: term.rows, ref: session.ref },
    (data) => term.write(data),
    (code) => {
      session.exited = true;
      session.backendId = null;
      session.callbacks.onExit(code);
    },
  );
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
    ref: ShellRef | undefined,
    callbacks: SessionCallbacks,
  ): Promise<SpawnResult> {
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
      ref: ref ?? config.defaultShell,
      callbacks,
      pendingInput: [],
      exited: false,
      disposed: false,
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

  async restart(sessionId: string): Promise<SpawnResult> {
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
