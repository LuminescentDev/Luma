import type { Terminal } from "@xterm/xterm";

import { useAgentInboxStore } from "../../stores/agentInboxStore";

/*
 * Zero-configuration agent detection.
 *
 * The OSC 7791 protocol (scripts/luma-hook.md) reports agent state precisely,
 * but it has to be installed and wired up on the machine the agent runs on —
 * which is the remote host for every SSH session. This module derives the same
 * inbox events from what the terminal can already see, with nothing installed
 * anywhere:
 *
 *   1. Notification sequences terminals already standardised — OSC 9 (iTerm2),
 *      OSC 777 (urxvt), OSC 99 (kitty) — plus a plain BEL.
 *   2. The rendered screen. Agent TUIs draw a recognisable busy indicator and
 *      approval prompt, so watching those appear and disappear yields
 *      tool-started / needs-approval / waiting-for-input without the agent
 *      cooperating at all.
 *
 * Both are heuristics and are deliberately conservative: an unrecognised screen
 * produces no event rather than a guess, and a session that emits real hook
 * events ignores everything here (see agentInboxStore.recordEvent).
 *
 * Only short metadata leaves this file. The byte stream is never routed
 * anywhere but xterm.js; the screen is read back from xterm's own buffer.
 */

/** Scan this long after output stops — enough for a TUI to finish redrawing. */
const QUIET_MS = 300;
/** A working agent redraws continuously, so also scan at least this often. */
const MAX_SCAN_INTERVAL_MS = 1000;
/** How many rows of the current screen to match against. */
const SCAN_ROWS = 48;
/** A bell this soon after a keystroke is input feedback, not a notification. */
const BELL_INPUT_GRACE_MS = 2000;
/** Ignore repeat bells inside this window. */
const BELL_COOLDOWN_MS = 3000;

/** Agent-session id for screen-derived events: one inbox item per terminal. */
const SCREEN_AGENT_SESSION = "screen";
/** Agent-session id for notification sequences and bells. */
const NOTIFY_AGENT_SESSION = "notify";
/** Attributed agent before a screen signature identifies one. */
const UNKNOWN_AGENT = "terminal";

/** A parsed desktop-notification escape sequence. */
export type TerminalNotification = {
  title?: string;
  body?: string;
};

/** iTerm2's `OSC 9 ; body`. */
export function parseOsc9(data: string): TerminalNotification | null {
  // ConEmu and Windows Terminal reuse OSC 9 for progress reporting (`9;4;…`)
  // and cwd (`9;9;…`); a leading numeric field is never a notification body.
  if (/^\d+(;|$)/.test(data)) return null;
  const body = data.trim();
  return body ? { body } : null;
}

/** urxvt's `OSC 777 ; notify ; title ; body`. */
export function parseOsc777(data: string): TerminalNotification | null {
  const parts = data.split(";");
  if (parts[0] !== "notify") return null;
  const title = parts[1]?.trim();
  const body = parts.slice(2).join(";").trim();
  if (!title && !body) return null;
  return { title: title || undefined, body: body || undefined };
}

/** kitty's `OSC 99 ; <key=value:…> ; <payload>`. Multi-chunk messages (`d=0`)
 * are not reassembled — each chunk is surfaced as it arrives. */
export function parseOsc99(data: string): TerminalNotification | null {
  const separator = data.indexOf(";");
  if (separator === -1) return null;
  const metadata = data.slice(0, separator);
  let payload = data.slice(separator + 1).trim();
  if (!payload) return null;
  if (/(^|:)e=1(:|$)/.test(metadata)) {
    try {
      payload = atob(payload);
    } catch {
      return null;
    }
  }
  return /(^|:)p=body(:|$)/.test(metadata) ? { body: payload } : { title: payload };
}

/** Patterns that must ALL match for the condition to hold. */
type Matchers = readonly RegExp[];

type AgentSignature = {
  agent: string;
  /** Identifies the agent as the thing on screen. */
  present: Matchers;
  /** The agent is working. */
  busy: Matchers;
  /** The agent is blocked on a permission prompt. The FIRST pattern is also
   * used to pull the question line out of the screen for the inbox detail. */
  approval: Matchers;
  /** Approaching a usage or context limit. */
  limit?: Matchers;
};

/**
 * Screen signatures, one entry per agent.
 *
 * These match rendered TUI text, so they will drift as agents change their
 * interface. Keep them to short, stable fragments, and remember that a
 * signature which stops matching degrades to silence rather than to wrong
 * events. Supporting another agent means appending an entry here; nothing else
 * changes.
 */
export const AGENT_SIGNATURES: readonly AgentSignature[] = [
  {
    agent: "claude-code",
    present: [
      /\? for shortcuts|esc to interrupt|Welcome to Claude Code|tell Claude what to do/i,
    ],
    busy: [/esc to interrupt/i],
    // The option list is drawn inside a box, so the numbered choices carry a
    // border character before them.
    approval: [/\bDo you want to\b/i, /^[\s│┃║|]*(?:❯\s*)?1\.\s+Yes\b/m],
    limit: [
      /context left until auto-compact|approaching (?:your )?(?:usage|rate) limit/i,
    ],
  },
];

function matchesAll(text: string, patterns: Matchers | undefined): boolean {
  if (!patterns?.length) return false;
  return patterns.every((pattern) => pattern.test(text));
}

/** The bottom SCAN_ROWS rows of the current screen, as plain text. */
function viewportText(term: Terminal): string {
  const buffer = term.buffer.active;
  const end = buffer.baseY + term.rows;
  const start = Math.max(0, end - SCAN_ROWS);
  const lines: string[] = [];
  for (let y = start; y < end; y += 1) {
    const line = buffer.getLine(y);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

/** The screen line asking for approval, stripped of box drawing. */
function approvalQuestion(
  text: string,
  signature: AgentSignature,
): string | undefined {
  const question = signature.approval[0];
  const line = text.split("\n").find((candidate) => question.test(candidate));
  const cleaned = line
    ?.replace(/[│┃║|╭╮╰╯─━]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 120) : undefined;
}

/** Whether the user is typing into this terminal right now. */
function hasKeyboardFocus(term: Terminal): boolean {
  if (typeof document === "undefined" || !document.hasFocus()) return false;
  const { textarea } = term;
  return textarea !== undefined && document.activeElement === textarea;
}

/** What the last scan concluded the agent was doing. */
type Phase = "unknown" | "idle" | "busy" | "approval";

/** The session state this module needs. Satisfied by the manager's session. */
export type AgentSignalTarget = {
  readonly term: Terminal;
  /** Backend session id: what the inbox keys items by. Null before spawn. */
  readonly backendId: string | null;
};

export type AgentSignalTracker = {
  /** A chunk of backend output was written to the terminal. */
  onOutput(): void;
  /** The user typed into this session. */
  onUserInput(): void;
  /** The terminal rang the bell. */
  onBell(): void;
  /** A notification OSC (9, 99 or 777) arrived. */
  onNotification(ident: number, data: string): void;
  /** Forget the observed state (the session is respawning). */
  reset(): void;
  dispose(): void;
};

export function createAgentSignalTracker(
  target: AgentSignalTarget,
): AgentSignalTracker {
  let timer: number | null = null;
  let lastScanAt = 0;
  let lastInputAt = 0;
  let lastBellAt = 0;
  let phase: Phase = "unknown";
  let agent = UNKNOWN_AGENT;
  let limitWarned = false;
  let disposed = false;

  const emit = (
    agentSessionId: string,
    event: string,
    extra: { title?: string; detail?: string } = {},
  ): void => {
    const terminalSessionId = target.backendId;
    if (disposed || !terminalSessionId) return;
    useAgentInboxStore.getState().recordEvent({
      terminalSessionId,
      agentSessionId,
      agent,
      event,
      source: "heuristic",
      // The inbox still logs what happened in the terminal you are typing
      // into, but that terminal is showing it to you already — raising an
      // unread badge for it would only manufacture work.
      silent: hasKeyboardFocus(target.term),
      ...extra,
    });
  };

  const scan = (): void => {
    timer = null;
    if (disposed) return;
    lastScanAt = Date.now();

    const text = viewportText(target.term);
    const signature = AGENT_SIGNATURES.find((candidate) =>
      matchesAll(text, candidate.present),
    );
    if (!signature) return;
    agent = signature.agent;

    if (matchesAll(text, signature.limit)) {
      if (!limitWarned) {
        limitWarned = true;
        emit(SCREEN_AGENT_SESSION, "limit-warning");
      }
    } else {
      limitWarned = false;
    }

    const next: Phase = matchesAll(text, signature.approval)
      ? "approval"
      : matchesAll(text, signature.busy)
        ? "busy"
        : "idle";
    if (next === phase) return;
    const previous = phase;
    phase = next;

    if (next === "approval") {
      emit(SCREEN_AGENT_SESSION, "needs-approval", {
        detail: approvalQuestion(text, signature),
      });
    } else if (next === "busy") {
      emit(SCREEN_AGENT_SESSION, "tool-started");
    } else if (previous === "busy" || previous === "approval") {
      // Only handing control back counts. An idle screen on the first scan
      // proves nothing — the agent may have been idle for an hour.
      emit(SCREEN_AGENT_SESSION, "waiting-for-input");
    }
  };

  return {
    onOutput(): void {
      if (disposed) return;
      if (timer !== null) window.clearTimeout(timer);
      // Waiting for silence alone would never catch a working agent: it redraws
      // its spinner continuously and only stops once it is already finished.
      const delay =
        Date.now() - lastScanAt >= MAX_SCAN_INTERVAL_MS ? 0 : QUIET_MS;
      timer = window.setTimeout(scan, delay);
    },

    onUserInput(): void {
      lastInputAt = Date.now();
    },

    onBell(): void {
      const now = Date.now();
      // Shells and editors ring the bell at the user constantly — a rejected
      // key in vim, a completion with no match. A bell that follows typing is
      // feedback about that keystroke, not a call for attention.
      if (now - lastInputAt < BELL_INPUT_GRACE_MS) return;
      if (now - lastBellAt < BELL_COOLDOWN_MS) return;
      lastBellAt = now;
      emit(NOTIFY_AGENT_SESSION, "notification", { title: "Terminal bell" });
    },

    onNotification(ident: number, data: string): void {
      const parsed =
        ident === 9
          ? parseOsc9(data)
          : ident === 777
            ? parseOsc777(data)
            : parseOsc99(data);
      if (!parsed) return;
      emit(NOTIFY_AGENT_SESSION, "notification", {
        title: parsed.title ?? parsed.body,
        detail: parsed.title ? parsed.body : undefined,
      });
    },

    reset(): void {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      phase = "unknown";
      limitWarned = false;
      agent = UNKNOWN_AGENT;
    },

    dispose(): void {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    },
  };
}
