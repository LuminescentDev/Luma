import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createdTerminals, Terminal } from "../../test/xtermMock";
import { setInvoke } from "../../test/tauriMock";
import {
  createAgentSignalTracker,
  parseOsc9,
  parseOsc777,
  parseOsc99,
} from "./agentSignals";
import { useAgentInboxStore } from "../../stores/agentInboxStore";
import { terminalManager } from "./terminalManager";

/*
 * Detection of agent state from what the terminal already sees — notification
 * sequences, bells and the rendered screen — for agents with no luma-hook
 * installed on the machine they run on. The inbox's own collation rules are
 * covered in agentInboxStore.test.ts.
 */

/** A screen showing Claude Code mid-turn. */
const BUSY_SCREEN = [
  "> refactor the parser",
  "",
  "✳ Herding… (12s · ↑ 1.4k tokens · esc to interrupt)",
];

/** The same session parked at its prompt. */
const IDLE_SCREEN = [
  "> refactor the parser",
  "",
  "  Done. The parser now handles nested groups.",
  "╭──────────────────────────────────────────╮",
  "│ >                                        │",
  "╰──────────────────────────────────────────╯",
  "  ? for shortcuts",
];

/** An approval prompt. */
const APPROVAL_SCREEN = [
  "│ Bash(cargo test)                          │",
  "│ Do you want to proceed?                   │",
  "│ ❯ 1. Yes                                  │",
  "│   2. No, and tell Claude what to do       │",
];

type XtermTerminal = import("@xterm/xterm").Terminal;

function show(term: Terminal, lines: string[]): void {
  term.lines.clear();
  term.rows = lines.length;
  lines.forEach((line, index) => term.setLine(index, line));
}

function terminalShowing(lines: string[]): Terminal {
  const term = new Terminal();
  show(term, lines);
  return term;
}

function trackerFor(term: Terminal, backendId: string | null = "backend-1") {
  return createAgentSignalTracker({
    term: term as unknown as XtermTerminal,
    backendId,
  });
}

/** Drive one scan: output arrived, then long enough elapsed for the scan. */
function scanAfterOutput(tracker: { onOutput(): void }): void {
  tracker.onOutput();
  vi.advanceTimersByTime(1000);
}

const items = () => useAgentInboxStore.getState().items;

describe("notification sequence parsing", () => {
  it("reads an iTerm2 OSC 9 body", () => {
    expect(parseOsc9("Build finished")).toEqual({ body: "Build finished" });
  });

  it("ignores ConEmu progress and cwd reports on OSC 9", () => {
    expect(parseOsc9("4;1;50")).toBeNull();
    expect(parseOsc9("9;C:\\src")).toBeNull();
  });

  it("reads an urxvt OSC 777 title and body", () => {
    expect(parseOsc777("notify;Claude Code;Waiting for input")).toEqual({
      title: "Claude Code",
      body: "Waiting for input",
    });
  });

  it("ignores OSC 777 subcommands other than notify", () => {
    expect(parseOsc777("precmd;something")).toBeNull();
  });

  it("reads a kitty OSC 99 title and body chunk", () => {
    expect(parseOsc99("i=1:d=0:p=title;Claude Code")).toEqual({
      title: "Claude Code",
    });
    expect(parseOsc99("i=1:p=body;Needs approval")).toEqual({
      body: "Needs approval",
    });
  });

  it("decodes base64 OSC 99 payloads", () => {
    expect(parseOsc99(`i=1:e=1:p=body;${btoa("Needs approval")}`)).toEqual({
      body: "Needs approval",
    });
  });
});

describe("agent signal tracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAgentInboxStore.setState({
      items: [],
      unreadCount: 0,
      hookSessions: new Set(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a turn handed back when the busy indicator disappears", () => {
    const term = terminalShowing(BUSY_SCREEN);
    const tracker = trackerFor(term);

    scanAfterOutput(tracker);
    expect(items()[0]?.state).toBe("tool-started");

    show(term, IDLE_SCREEN);
    scanAfterOutput(tracker);

    expect(items()[0]?.state).toBe("waiting-for-input");
    expect(items()[0]?.agent).toBe("claude-code");
    expect(items()[0]?.unread).toBe(true);
  });

  it("reports an approval prompt with the question", () => {
    const tracker = trackerFor(terminalShowing(APPROVAL_SCREEN));

    scanAfterOutput(tracker);

    expect(items()[0]?.state).toBe("needs-approval");
    expect(items()[0]?.detail).toBe("Do you want to proceed?");
  });

  it("logs without an unread badge for the terminal being watched", () => {
    const term = terminalShowing(BUSY_SCREEN);
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    term.textarea = textarea;
    const tracker = trackerFor(term);

    scanAfterOutput(tracker);
    show(term, IDLE_SCREEN);
    scanAfterOutput(tracker);

    expect(items()[0]?.state).toBe("waiting-for-input");
    expect(items()[0]?.unread).toBe(false);
    expect(useAgentInboxStore.getState().unreadCount).toBe(0);
    textarea.remove();
  });

  it("stays silent on an idle screen it has never seen work on", () => {
    const tracker = trackerFor(terminalShowing(IDLE_SCREEN));
    scanAfterOutput(tracker);
    expect(items()).toHaveLength(0);
  });

  it("stays silent on a screen it does not recognise", () => {
    const tracker = trackerFor(
      terminalShowing(["$ ls -la", "total 4", "drwxr-xr-x  2 user user"]),
    );
    scanAfterOutput(tracker);
    expect(items()).toHaveLength(0);
  });

  it("does not repeat an event while the screen stays in one state", () => {
    const tracker = trackerFor(terminalShowing(BUSY_SCREEN));
    scanAfterOutput(tracker);
    scanAfterOutput(tracker);
    scanAfterOutput(tracker);
    expect(items()).toHaveLength(1);
    expect(items()[0]?.history).toHaveLength(1);
  });

  it("scans during sustained output rather than only after it stops", () => {
    const term = terminalShowing(IDLE_SCREEN);
    const tracker = trackerFor(term);
    scanAfterOutput(tracker);
    expect(items()).toHaveLength(0);

    show(term, BUSY_SCREEN);
    // A working agent redraws continuously, so output never goes quiet for
    // long enough to trigger the debounce on its own.
    for (let tick = 0; tick < 15; tick += 1) {
      tracker.onOutput();
      vi.advanceTimersByTime(100);
    }

    expect(items()[0]?.state).toBe("tool-started");
  });

  it("forgets what it saw when the session respawns", () => {
    const term = terminalShowing(BUSY_SCREEN);
    const tracker = trackerFor(term);
    scanAfterOutput(tracker);

    tracker.reset();
    show(term, IDLE_SCREEN);
    scanAfterOutput(tracker);

    // With no observed busy phase to leave, an idle screen says nothing.
    expect(items()).toHaveLength(1);
    expect(items()[0]?.state).toBe("tool-started");
  });

  it("surfaces a notification sequence", () => {
    const tracker = trackerFor(terminalShowing(IDLE_SCREEN));
    tracker.onNotification(777, "notify;Claude Code;Waiting for input");

    expect(items()[0]?.state).toBe("notification");
    expect(items()[0]?.title).toBe("Claude Code");
    expect(items()[0]?.detail).toBe("Waiting for input");
    expect(items()[0]?.unread).toBe(true);
  });

  it("surfaces a bell, but not one that answers a keystroke", () => {
    const tracker = trackerFor(terminalShowing(IDLE_SCREEN));

    tracker.onUserInput();
    tracker.onBell();
    expect(items()).toHaveLength(0);

    vi.advanceTimersByTime(5000);
    tracker.onBell();
    expect(items()[0]?.title).toBe("Terminal bell");
  });

  it("coalesces a burst of bells into one item", () => {
    const tracker = trackerFor(terminalShowing(IDLE_SCREEN));
    tracker.onBell();
    tracker.onBell();
    tracker.onBell();
    expect(items()).toHaveLength(1);
    expect(items()[0]?.history).toHaveLength(1);
  });

  it("emits nothing before the session has a backend id", () => {
    const tracker = trackerFor(terminalShowing(BUSY_SCREEN), null);
    scanAfterOutput(tracker);
    expect(items()).toHaveLength(0);
  });

  it("stops scanning once disposed", () => {
    const tracker = trackerFor(terminalShowing(BUSY_SCREEN));
    tracker.onOutput();
    tracker.dispose();
    vi.advanceTimersByTime(1000);
    expect(items()).toHaveLength(0);
  });
});

describe("terminal manager wiring", () => {
  beforeEach(() => {
    useAgentInboxStore.setState({
      items: [],
      unreadCount: 0,
      hookSessions: new Set(),
    });
    setInvoke((cmd) => {
      if (cmd === "pty_spawn") return { sessionId: "backend", shellName: "bash" };
      if (cmd === "pty_kill") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
  });

  it("routes a live session's notifications and bells into the inbox", async () => {
    const startIndex = createdTerminals.length;
    await terminalManager.createSession(
      "wiring-1",
      { kind: "local", ref: { kind: "shell", id: "bash" } },
      {
        onTitle: () => {},
        onExit: () => {},
        onSearchRequested: () => {},
        onSshAuthenticated: () => {},
        onSshPrompt: () => {},
        onSshProgress: () => {},
        onRemoteOs: () => {},
      },
    );
    const term = createdTerminals[startIndex];

    term.emitOsc(9, "Build finished");
    expect(items()[0]).toMatchObject({
      // The BACKEND session id, which is what the inbox keys and resolves by.
      terminalSessionId: "backend",
      state: "notification",
      title: "Build finished",
    });

    term.emitBell();
    expect(items()).toHaveLength(1);
    expect(items()[0]?.title).toBe("Terminal bell");

    terminalManager.dispose("wiring-1");
  });
});
