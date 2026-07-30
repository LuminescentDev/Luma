/**
 * Agent Inbox contract. The Rust backend emits an `agent-event` window event
 * (to the `main` window) whenever a coding agent running inside a terminal
 * session reaches a notable point — needing approval, waiting for input,
 * finishing a turn, hitting a limit, etc. The frontend collates these into an
 * inbox keyed by (terminal session + agent session).
 *
 * Payload fields arrive camelCase. `ts` is optional unix SECONDS; callers fall
 * back to the local clock when it is absent.
 */
export type AgentEventPayload = {
  /** Luma terminal session id — the same id the session store uses. */
  terminalSessionId: string;
  /** The agent's own session id (distinct from the terminal session). */
  agentSessionId: string;
  /** Agent product id, e.g. "claude-code" | "codex" | "gemini" | "opencode". */
  agent: string;
  /** Event kind — one of AgentEventKind, or any other string (neutral). */
  event: string;
  title?: string;
  detail?: string;
  /** Unix SECONDS. May be absent; fall back to Date.now(). */
  ts?: number;
};

/** The known event vocabulary. Unknown strings are handled as a neutral state. */
export type AgentEventKind =
  | "needs-approval"
  | "waiting-for-input"
  | "tool-started"
  | "tool-finished"
  | "turn-completed"
  | "session-failed"
  | "limit-warning"
  | "session-started"
  | "session-ended";

/**
 * States that demand the user's attention — an item in one of these states is
 * marked unread and highlighted until read.
 */
export const ATTENTION_STATES: ReadonlySet<string> = new Set<AgentEventKind>([
  "needs-approval",
  "waiting-for-input",
  "session-failed",
  "limit-warning",
]);

/** Whether an event kind should mark its item unread/highlighted. */
export function isAttentionState(event: string): boolean {
  return ATTENTION_STATES.has(event);
}

/** The event that retires an item (kept, greyed out). */
export const DONE_STATE: AgentEventKind = "session-ended";

/** Visual tone for an event state, mapped to the app's semantic classes. */
export type AgentStateTone = "danger" | "warning" | "info" | "success" | "neutral";

/** Map an event kind to a display tone. Unknown kinds fall back to neutral. */
export function agentStateTone(event: string): AgentStateTone {
  switch (event) {
    case "session-failed":
      return "danger";
    case "needs-approval":
    case "waiting-for-input":
    case "limit-warning":
      return "warning";
    case "tool-started":
    case "session-started":
      return "info";
    case "tool-finished":
    case "turn-completed":
      return "success";
    default:
      return "neutral";
  }
}

/** Human-readable label for an event kind. Unknown kinds are shown verbatim. */
export function agentStateLabel(event: string): string {
  switch (event) {
    case "needs-approval":
      return "Needs approval";
    case "waiting-for-input":
      return "Waiting for input";
    case "tool-started":
      return "Running tool";
    case "tool-finished":
      return "Tool finished";
    case "turn-completed":
      return "Turn completed";
    case "session-failed":
      return "Session failed";
    case "limit-warning":
      return "Limit warning";
    case "session-started":
      return "Session started";
    case "session-ended":
      return "Session ended";
    default:
      return event;
  }
}

/** Friendly display name for a known agent id; falls back to the raw id. */
export function agentDisplayName(agent: string): string {
  switch (agent) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    case "opencode":
      return "OpenCode";
    default:
      return agent;
  }
}
