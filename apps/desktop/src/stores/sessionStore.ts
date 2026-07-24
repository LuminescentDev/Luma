import { create } from "zustand";
import type {
  PaneNode,
  RestoreDescriptor,
  SplitDirection,
  TerminalSession,
  WorkspaceTab,
} from "../types";
import type { ShellRef } from "../lib/terminal";
import type { SerialConfig } from "../lib/serial";
import {
  sshHostKeyStatus,
  sshHostKeyTrust,
  type SshHostKeyStatus,
} from "../lib/ssh";
import { parseLumaError } from "../lib/hosts";
import {
  terminalManager,
  isSpawnAbandoned,
  type SessionExit,
  type SpawnDescriptor,
} from "../features/terminal/terminalManager";
import { planReconnect } from "../features/terminal/reconnect";
import type {
  SnapshotPaneNode,
  WorkspaceSnapshot,
} from "../features/terminal/sessionSnapshot";
import {
  collectLeaves,
  findLeaf,
  findLeafBySession,
  makeLeaf,
  removeLeaf,
  setLeafSession,
  setSplitSizes,
  splitLeaf,
} from "../features/terminal/paneTree";
import { useUiStore } from "./uiStore";
import { useSessionLogStore } from "./sessionLogStore";

/*
 * Session METADATA and split-pane LAYOUT only. Terminal byte streams and
 * xterm.js instances live in terminalManager, entirely outside React.
 *
 * A tab owns a split tree; each leaf pane hosts exactly one session. Splitting
 * spawns a new session (duplicating the source pane's SSH host, or a default
 * local shell). `activeSessionId` always mirrors the active tab's focused pane
 * so the search bar and workspace keep targeting the right terminal.
 */
type SessionState = {
  sessions: TerminalSession[];
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  /** The session in the active tab's focused pane (null when no tabs exist). */
  activeSessionId: string | null;

  openLocalSession: (ref?: ShellRef, title?: string) => Promise<void>;
  openSshSession: (
    hostId: string,
    title?: string,
    hostname?: string,
    ephemeral?: boolean,
    tabColor?: string | null,
  ) => Promise<void>;
  openSerialSession: (config: SerialConfig, title?: string) => Promise<void>;
  /** Restart a session's backend. `reconnect` marks an auto-reconnect attempt:
   * it preserves the terminal buffer and keeps the reconnect attempt counter,
   * whereas a manual restart clears the terminal and resets the counter. */
  restartSession: (
    id: string,
    options?: { reconnect?: boolean },
  ) => Promise<void>;
  /** Trigger the pending SSH reconnect immediately (cancels the backoff timer). */
  retryReconnectNow: (id: string) => void;
  /** Abandon the SSH reconnect run and leave the session in its failed state. */
  stopReconnect: (id: string) => void;
  /** Record the latest measured latency (ms) for a connected SSH session, or
   * null when the last probe failed. Called by the latency monitor. */
  setLatency: (id: string, latencyMs: number | null) => void;
  /** Clear the ephemeral flag on every session bound to a host that was just
   * saved via quick-connect, so the "Save host…" affordance disappears. */
  markHostSaved: (hostId: string) => void;
  /** Accept the host keys shown in an SSH session's host-key preflight prompt.
   * Resolves the awaiting preflight so it trusts the scan and proceeds to spawn.
   * No-op if the session is not currently awaiting a host-key decision. */
  trustHostKey: (id: string) => void;
  /** Close the pane hosting this session, collapsing its split (and its tab
   * when it was the last pane). */
  closeSession: (id: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  focusPane: (tabId: string, paneId: string) => void;
  /** Focus the pane hosting this session (used by the command palette). */
  focusSession: (id: string) => void;
  splitActivePane: (direction: SplitDirection) => Promise<void>;
  /** Split the active pane and spawn the given descriptor (an ad-hoc different
   * connection) instead of duplicating the source pane. SSH descriptors still
   * run the host-key preflight and surface per-pane errors identically. */
  splitActivePaneWith: (
    direction: SplitDirection,
    restore: RestoreDescriptor,
  ) => Promise<void>;
  /** Graft the source tab's entire pane tree into the target tab as a new split,
   * producing one grouped tab. Session and leaf pane ids are preserved so xterm
   * instances re-attach; the source tab is removed. No-op on unknown/identical
   * ids. */
  mergeTabs: (
    sourceTabId: string,
    targetTabId: string,
    direction?: SplitDirection,
    placement?: "before" | "after",
    targetPaneId?: string,
  ) => void;
  /** Open ONE new grouped tab reproducing a saved template layout, spawning
   * every leaf via the restore path with fresh session/pane ids. */
  openTemplate: (root: SnapshotPaneNode) => void;
  /** Rebuild the workspace from a persisted snapshot: recreate every tab's
   * pane-tree layout with fresh ids and re-spawn each pane's descriptor. */
  restoreFromSnapshot: (snapshot: WorkspaceSnapshot) => void;
  closeActivePane: () => void;
  /** Swap the active pane's session with the next pane in the tab. */
  moveActivePaneToNext: () => void;
  resizeSplit: (tabId: string, splitId: string, sizes: number[]) => void;
  /** Toggle broadcast input for a tab (fan keystrokes from the focused pane out
   * to every non-excluded pane). Clears any per-pane exclusions on toggle and
   * pushes the resulting membership to terminalManager. */
  toggleBroadcast: (tabId: string) => void;
  /** Toggle broadcast for the active tab (command palette / keyboard shortcut).
   * No-op unless the active tab has at least two panes. */
  toggleActiveBroadcast: () => void;
  /** Include/exclude a single pane's session from its tab's broadcast group. */
  setPaneBroadcast: (tabId: string, sessionId: string, enabled: boolean) => void;
};

/** The session ids that should currently receive broadcast for a tab: every
 * pane's session minus the excluded ones, but only when broadcast is enabled and
 * the tab actually has more than one pane. Empty when broadcast is off. */
function broadcastMembers(tab: WorkspaceTab): string[] {
  if (!tab.broadcastEnabled) return [];
  const leaves = collectLeaves(tab.root);
  if (leaves.length < 2) return [];
  const excluded = new Set(tab.broadcastExcluded ?? []);
  return leaves.map((leaf) => leaf.sessionId).filter((id) => !excluded.has(id));
}

/** Push a tab's current broadcast membership into terminalManager. Called after
 * any change that can affect membership (toggle, exclude, split, close). Bytes
 * never touch React — this only hands the manager the metadata list. */
function syncBroadcast(tab: WorkspaceTab | undefined): void {
  if (!tab) return;
  const members = broadcastMembers(tab);
  // An empty membership means broadcast is off, or has fallen below two eligible
  // panes (toggle off, exclusions, or a tab dropping to one pane). setBroadcastGroup
  // can only detach the old shared peer set by following a listed member's set, so
  // an empty list would leave every pane's broadcastPeers stale and keystrokes would
  // keep fanning out. Explicitly clear each pane in the tab instead — clearBroadcastGroup
  // disbands the group and leaves no session with a lingering peer set.
  if (members.length === 0) {
    for (const leaf of collectLeaves(tab.root)) {
      terminalManager.clearBroadcastGroup(leaf.sessionId);
    }
    return;
  }
  terminalManager.setBroadcastGroup(members);
}

/*
 * SSH auto-reconnect engine. Timers live at module scope (never React state or
 * terminal bytes) keyed by the store's session id, mirroring the host-key waiter
 * map above. `autoReconnectEnabled` is a device-local setting pushed in from the
 * settings load (see setAutoReconnectEnabled, wired in Layout); the engine reads
 * it synchronously when deciding whether to schedule a retry.
 */
let autoReconnectEnabled = true;
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Honor the "Auto-reconnect SSH sessions" setting. Called on settings load and
 * whenever the toggle changes. */
export function setAutoReconnectEnabled(enabled: boolean): void {
  autoReconnectEnabled = enabled;
}

function clearReconnectTimer(id: string): void {
  const timer = reconnectTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    reconnectTimers.delete(id);
  }
}

/** Map a session exit into the metadata patch React should store. SSH failures
 * carry an errorCategory; clean exits (code 0/null, no category) disconnect. */
function exitPatch(exit: SessionExit): Partial<TerminalSession> {
  if (exit.errorCategory) {
    return {
      status: "error",
      errorCategory: exit.errorCategory,
      errorMessage: exit.errorMessage ?? undefined,
      exitCode: exit.code,
    };
  }
  return { status: "disconnected", exitCode: exit.code };
}

function patchSession(
  sessions: TerminalSession[],
  id: string,
  patch: Partial<TerminalSession>,
): TerminalSession[] {
  return sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

/**
 * Handle a session's backend exit: schedule an auto-reconnect when it is a
 * transient SSH failure (and the feature is enabled and attempts remain),
 * otherwise fall through to the normal disconnected/error patch. A reconnect run
 * keeps the terminal buffer and counts attempts; a successful reconnection
 * (onSshAuthenticated) resets the counter.
 */
function handleSessionExit(
  set: SetFn,
  get: () => SessionState,
  id: string,
  exit: SessionExit,
): void {
  // The backend auto-stops session logging on exit; drop our indicator so it
  // never outlives the capture.
  useSessionLogStore.getState().markInactive(id);

  const session = get().sessions.find((s) => s.id === id);
  const isSsh = session?.type === "ssh";
  const previousAttempt = session?.reconnectAttempt ?? 0;
  const plan =
    isSsh && session
      ? planReconnect(exit.errorCategory, autoReconnectEnabled, previousAttempt)
      : null;

  if (plan && session) {
    clearReconnectTimer(id);
    set((state) => ({
      sessions: patchSession(state.sessions, id, {
        status: "error",
        errorCategory: exit.errorCategory,
        errorMessage: exit.errorMessage ?? undefined,
        exitCode: exit.code,
        connectionState: "reconnecting",
        reconnectAttempt: plan.attempt,
        nextRetryAt: Date.now() + plan.delayMs,
        latencyMs: null,
        connectionPrompt: undefined,
      }),
    }));
    const timer = setTimeout(() => {
      reconnectTimers.delete(id);
      if (sessionStillOpen(get, id)) {
        void get().restartSession(id, { reconnect: true });
      }
    }, plan.delayMs);
    reconnectTimers.set(id, timer);
    return;
  }

  // No reconnect: attempts exhausted, non-reconnectable, disabled, or a clean
  // exit. Non-clean SSH exits become "failed" so the UI can distinguish an
  // error from a deliberate disconnect.
  clearReconnectTimer(id);
  set((state) => ({
    sessions: patchSession(state.sessions, id, {
      ...exitPatch(exit),
      connectionState: exit.errorCategory ? "failed" : "disconnected",
      nextRetryAt: null,
      latencyMs: null,
    }),
  }));
}

/*
 * SSH host-key preflight. Before spawning an SSH session we ask the backend
 * whether the host's current keys are known/unknown/changed (see src/lib/ssh.ts).
 * An `unknown` host must be explicitly accepted by the user, so the preflight
 * awaits a decision that the UI resolves via `trustHostKey` (accept) or
 * `closeSession`/`closeTab` (cancel). Decisions live in a plain module-level map
 * — this is control flow, never terminal bytes, and never React state.
 */
type HostKeyDecision = "trust" | "cancel";
const hostKeyWaiters = new Map<string, (decision: HostKeyDecision) => void>();

function waitForHostKeyDecision(id: string): Promise<HostKeyDecision> {
  return new Promise((resolve) => {
    // A stale waiter (session re-preflighted) is cancelled so it can't leak.
    hostKeyWaiters.get(id)?.("cancel");
    hostKeyWaiters.set(id, resolve);
  });
}

function resolveHostKeyDecision(id: string, decision: HostKeyDecision): void {
  const resolve = hostKeyWaiters.get(id);
  if (!resolve) return;
  hostKeyWaiters.delete(id);
  resolve(decision);
}

/** Whether a session is still registered (not closed while the preflight was
 * awaiting the network or the user). */
function sessionStillOpen(get: () => SessionState, id: string): boolean {
  return get().sessions.some((s) => s.id === id);
}

/** Patch a session into the blocking `host-key-changed` error state, stashing the
 * scanned-vs-known fingerprints for the comparison view. Never trusts or spawns. */
function applyHostKeyChanged(
  set: SetFn,
  id: string,
  status: SshHostKeyStatus,
): void {
  set((state) => ({
    sessions: patchSession(state.sessions, id, {
      status: "error",
      errorCategory: "host-key-changed",
      errorMessage: undefined,
      connectionPrompt: undefined,
      connectionIssue: undefined,
      hostKeyScanned: status.scannedKeys,
      hostKeyKnown: status.knownKeys,
    }),
  }));
}

/** Patch a session into an error state from a preflight status/trust failure.
 * Flags it as a preflight error (the terminal never spawned) so the UI shows the
 * prominent centered connection-error card rather than the runtime disconnect
 * banner, and describeSshError explains the category. */
function applyPreflightError(set: SetFn, id: string, error: unknown): void {
  const { category, message } = parseLumaError(error);
  set((state) => ({
    sessions: patchSession(state.sessions, id, {
      status: "error",
      errorCategory: category,
      errorMessage: message,
      connectionPrompt: undefined,
      preflightError: true,
    }),
  }));
}

/**
 * Run the host-key preflight for an SSH session and return whether the caller
 * should proceed to spawn. Loops so that a `host-key-scan-required` trust
 * failure (expired 120s retention, or host/port changed) re-scans and re-shows
 * the NEW fingerprints. Never auto-accepts: an `unknown` host always waits for
 * an explicit user decision, and `changed` is always blocking.
 */
async function runHostKeyPreflight(
  set: SetFn,
  get: () => SessionState,
  id: string,
  hostId: string,
): Promise<boolean> {
  // Carries the "we re-scanned" note into the next iteration's UI, if any.
  let issue: string | undefined;
  for (;;) {
    if (!sessionStillOpen(get, id)) return false;
    set((state) => ({
      sessions: patchSession(state.sessions, id, {
        status: "connecting",
        connectionStage: "host-key",
        connectionPrompt: undefined,
        connectionIssue: issue,
        errorCategory: undefined,
        errorMessage: undefined,
        preflightError: undefined,
      }),
    }));
    issue = undefined;

    let status: SshHostKeyStatus;
    try {
      status = await sshHostKeyStatus(hostId);
    } catch (error) {
      applyPreflightError(set, id, error);
      return false;
    }
    if (!sessionStillOpen(get, id)) return false;

    if (status.status === "known") return true;
    if (status.status === "changed") {
      applyHostKeyChanged(set, id, status);
      return false;
    }

    // unknown: show every scanned key and wait for an explicit decision.
    set((state) => ({
      sessions: patchSession(state.sessions, id, {
        connectionStage: "host-key",
        connectionPrompt: { type: "host-key", keys: status.scannedKeys },
      }),
    }));
    const decision = await waitForHostKeyDecision(id);
    if (decision === "cancel" || !sessionStillOpen(get, id)) return false;

    // Trust and continue: persist the retained scan, then spawn.
    set((state) => ({
      sessions: patchSession(state.sessions, id, {
        connectionStage: "host-key",
        connectionPrompt: undefined,
        connectionIssue: undefined,
      }),
    }));
    try {
      const trusted = await sshHostKeyTrust(hostId);
      if (!sessionStillOpen(get, id)) return false;
      if (trusted.status === "known") return true;
      // Defensive: any non-known success means re-evaluate from scratch.
      continue;
    } catch (error) {
      const { category } = parseLumaError(error);
      if (category === "host-key-scan-required") {
        // Retained scan expired or the target moved — re-scan and re-prompt.
        issue =
          "Luma re-scanned the server because the earlier key scan expired. Verify the fingerprints shown below before continuing.";
        continue;
      }
      if (category === "host-key-changed") {
        applyPreflightError(set, id, error);
        return false;
      }
      applyPreflightError(set, id, error);
      return false;
    }
  }
}

/** Resolve the focused session id for a set of tabs. */
function computeActiveSession(
  tabs: WorkspaceTab[],
  activeTabId: string | null,
): string | null {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) return null;
  return findLeaf(tab.root, tab.activePaneId)?.sessionId ?? null;
}

type SetFn = (
  partial:
    | Partial<SessionState>
    | ((state: SessionState) => Partial<SessionState>),
) => void;

/** Register manager callbacks that write session metadata back into the store. */
function makeCallbacks(set: SetFn, get: () => SessionState, id: string) {
  return {
    onTitle: (title: string) =>
      set((state) => {
        const session = state.sessions.find((candidate) => candidate.id === id);
        // SSH and serial sessions keep a stable, caller-provided title (host name
        // or serial port); only local shells adopt xterm's OSC title.
        return session?.type === "local" ? { sessions: patchSession(state.sessions, id, { title }) } : {};
      }),
    onExit: (exit: SessionExit) => handleSessionExit(set, get, id, exit),
    onSearchRequested: () => useUiStore.getState().setTerminalSearchOpen(true),
    onSshAuthenticated: () => {
      // A successful (re)connection ends any reconnect run and resets its
      // counter, so a later drop starts its backoff schedule from the top.
      clearReconnectTimer(id);
      set((state) => ({ sessions: patchSession(state.sessions, id, { status: "connected", connectionPrompt: undefined, connectionStage: "ready", connectionState: "connected", reconnectAttempt: 0, nextRetryAt: null }) }));
    },
    // Only interactive credential prompts arrive here now; host-key trust is
    // handled by the store's backend preflight before spawn.
    onSshPrompt: (connectionPrompt: { type: "credential"; label: string }) =>
      set((state) => ({ sessions: patchSession(state.sessions, id, { connectionPrompt, connectionStage: "authentication" }) })),
    onSshProgress: (connectionStage: NonNullable<TerminalSession["connectionStage"]>) =>
      set((state) => ({ sessions: patchSession(state.sessions, id, { connectionStage }) })),
    onSshIssue: (connectionIssue: string) =>
      set((state) => ({ sessions: patchSession(state.sessions, id, { connectionIssue }) })),
    onRemoteOs: (osId: string, osPrettyName: string | null) =>
      set((state) => ({ sessions: patchSession(state.sessions, id, { osId, osPrettyName }) })),
  };
}

/** Spawn a managed terminal for an already-registered session, then patch its
 * status to connected/error. */
async function launch(
  set: SetFn,
  get: () => SessionState,
  id: string,
  descriptor: SpawnDescriptor,
  title: string | undefined,
): Promise<void> {
  // SSH sessions must clear the host-key preflight before any spawn. This
  // covers first-open, split-pane duplication, and workspace restore alike —
  // an unknown host on restore prompts, it is never silently auto-trusted.
  if (descriptor.kind === "ssh") {
    const proceed = await runHostKeyPreflight(set, get, id, descriptor.hostId);
    if (!proceed || !sessionStillOpen(get, id)) return;
  }
  try {
    const result = await terminalManager.createSession(
      id,
      descriptor,
      makeCallbacks(set, get, id),
    );
    set((state) => {
      const current = state.sessions.find((s) => s.id === id);
      // A fast backend exit can fire onExit BEFORE createSession resolves, which
      // already moved the session to disconnected/error. Never overwrite that
      // with "connected" — that is exactly the ghost-session race.
      const spawnExited = !!current && current.status !== "connecting";
      return {
        sessions: patchSession(state.sessions, id, {
          // Local and serial sessions are connected the moment the backend spawns;
          // SSH flips to connected later, after authentication completes.
          ...(descriptor.kind !== "ssh" && !spawnExited
            ? { status: "connected" as const }
            : {}),
          title: title ?? result.title,
        }),
      };
    });
  } catch (error) {
    // A superseding restart (or disposal) abandoned this attempt; the winner
    // owns the session's state, so leave it untouched.
    if (isSpawnAbandoned(error)) return;
    const { category, message } = parseLumaError(error);
    set((state) => ({
      sessions: patchSession(state.sessions, id, {
        status: "error",
        errorCategory: category,
        errorMessage: message,
      }),
    }));
  }
}

/** After a close operation, if the last terminal tab is gone and the terminal
 * workspace was the active main view, fall back to the Hosts screen rather than
 * showing the terminal empty state. */
function fallbackToHostsIfEmpty(get: () => SessionState): void {
  if (get().tabs.length === 0 && useUiStore.getState().mainView === "terminal") {
    useUiStore.getState().openSection("hosts");
  }
}

function newTab(sessionId: string): WorkspaceTab {
  const leaf = makeLeaf(sessionId);
  return { id: crypto.randomUUID(), root: leaf, activePaneId: leaf.id };
}

/** Let React commit the new pane host before creating its xterm/backend. This
 * allows terminalManager.attach() to fit the grid before spawn uses its
 * initial cols/rows and the shell draws the first prompt. */
function waitForPaneLayout(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Open a new session (local or SSH) in a fresh tab and connect it. */
async function openInNewTab(
  set: SetFn,
  get: () => SessionState,
  session: TerminalSession,
  descriptor: SpawnDescriptor,
  title: string | undefined,
): Promise<void> {
  const tab = newTab(session.id);
  useUiStore.getState().closeNewTab();
  useUiStore.getState().showTerminal();
  set((state) => ({
    sessions: [...state.sessions, session],
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
    activeSessionId: session.id,
  }));
  await waitForPaneLayout();
  await launch(set, get, session.id, descriptor, title);
}

type PendingLaunch = {
  id: string;
  descriptor: SpawnDescriptor;
  title: string | undefined;
};

/** Build a fresh session + spawn descriptor from a persisted restore
 * descriptor. Mirrors the openLocal/openSsh/openSerial shapes so a restored
 * pane behaves like a normal open. */
function sessionFromRestore(
  id: string,
  restore: RestoreDescriptor,
): { session: TerminalSession; descriptor: SpawnDescriptor; title: string | undefined } {
  if (restore.kind === "ssh") {
    return {
      session: {
        id,
        // Prefer the persisted display strings so the pane shows the right
        // label immediately; fall back to the generic labels for older
        // snapshots that predate these fields.
        title: restore.title ?? "SSH",
        type: "ssh",
        hostId: restore.hostId,
        connectionTarget: restore.connectionTarget ?? restore.title ?? "SSH host",
        status: "connecting",
        connectionStage: "starting",
        tabColor: restore.tabColor ?? null,
        activePaneId: id,
        restore,
      },
      descriptor: { kind: "ssh", hostId: restore.hostId },
      title: undefined,
    };
  }
  if (restore.kind === "serial") {
    return {
      session: {
        id,
        title: restore.config.path,
        type: "serial",
        serialPort: restore.config.path,
        serialBaud: restore.config.baudRate,
        status: "connecting",
        activePaneId: id,
        restore,
      },
      descriptor: { kind: "serial", config: restore.config },
      title: restore.config.path,
    };
  }
  return {
    session: {
      id,
      title: "Terminal",
      type: "local",
      status: "connecting",
      activePaneId: id,
      restore,
    },
    descriptor: { kind: "local", ref: restore.ref },
    title: undefined,
  };
}

/** Recreate a pane tree from its snapshot form, minting fresh pane + session
 * ids and collecting the sessions/launches to register and spawn. */
function buildRestoredNode(
  snap: SnapshotPaneNode,
  sessions: TerminalSession[],
  launches: PendingLaunch[],
): PaneNode {
  if (snap.kind === "leaf") {
    const id = crypto.randomUUID();
    const { session, descriptor, title } = sessionFromRestore(id, snap.restore);
    sessions.push(session);
    launches.push({ id, descriptor, title });
    return makeLeaf(id);
  }
  return {
    kind: "split",
    id: crypto.randomUUID(),
    direction: snap.direction,
    children: snap.children.map((child) =>
      buildRestoredNode(child, sessions, launches),
    ),
    sizes: snap.sizes,
  };
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  tabs: [],
  activeTabId: null,
  activeSessionId: null,

  openLocalSession: async (ref, title) => {
    const id = crypto.randomUUID();
    const session: TerminalSession = {
      id,
      title: title ?? "Terminal",
      type: "local",
      status: "connecting",
      activePaneId: id,
      restore: { kind: "local", ref },
    };
    await openInNewTab(set, get, session, { kind: "local", ref }, title);
  },

  openSshSession: async (hostId, title, hostname, ephemeral, tabColor) => {
    const id = crypto.randomUUID();
    const session: TerminalSession = {
      id,
      title: title ?? "SSH",
      type: "ssh",
      hostId,
      connectionTarget: hostname ?? title ?? "SSH host",
      status: "connecting",
      connectionStage: "starting",
      hostEphemeral: ephemeral === true,
      tabColor: tabColor ?? null,
      activePaneId: id,
      restore: {
        kind: "ssh",
        hostId,
        title: title ?? "SSH",
        connectionTarget: hostname ?? title ?? "SSH host",
        tabColor: tabColor ?? null,
      },
    };
    await openInNewTab(set, get, session, { kind: "ssh", hostId }, title);
  },

  openSerialSession: async (config, title) => {
    const id = crypto.randomUUID();
    const session: TerminalSession = {
      id,
      title: title ?? config.path,
      type: "serial",
      serialPort: config.path,
      serialBaud: config.baudRate,
      status: "connecting",
      activePaneId: id,
      restore: { kind: "serial", config },
    };
    await openInNewTab(set, get, session, { kind: "serial", config }, title);
  },

  restartSession: async (id, options = {}) => {
    const reconnect = options.reconnect === true;
    // A restart mints a new backendId, so any prior logging session is gone.
    useSessionLogStore.getState().markInactive(id);
    // A manual restart cancels any auto-reconnect run in flight and starts the
    // terminal fresh; an auto-reconnect attempt keeps the reconnect metadata.
    if (!reconnect) clearReconnectTimer(id);
    const attempt = get().sessions.find((session) => session.id === id)?.reconnectAttempt;
    set((state) => ({
      sessions: patchSession(state.sessions, id, {
        status: "connecting",
        exitCode: undefined,
        errorMessage: undefined,
        errorCategory: undefined,
        preflightError: undefined,
        connectionPrompt: undefined,
        connectionStage: "starting",
        connectionIssue: undefined,
        hostKeyScanned: undefined,
        hostKeyKnown: undefined,
        latencyMs: null,
        ...(reconnect
          ? { connectionState: "reconnecting" as const, nextRetryAt: null }
          : { connectionState: undefined, reconnectAttempt: 0, nextRetryAt: null }),
      }),
    }));
    // Reconnecting an SSH host re-runs the host-key preflight: a host trusted on
    // first connect resolves instantly to "known", but one that was never
    // trusted (or whose key rotated) still prompts or blocks rather than
    // failing via the exit channel.
    const target = get().sessions.find((session) => session.id === id);
    if (target?.type === "ssh" && target.hostId) {
      const proceed = await runHostKeyPreflight(set, get, id, target.hostId);
      if (!proceed || !sessionStillOpen(get, id)) return;
    }
    try {
      const result = await terminalManager.restart(
        id,
        reconnect ? { preserveBuffer: true, reconnectAttempt: attempt } : {},
      );
      set((state) => {
        const current = state.sessions.find((session) => session.id === id);
        const isSsh = current?.type === "ssh";
        // As in launch(): if the freshly spawned backend already exited, onExit
        // moved the session to disconnected/error — do not resurrect it.
        const spawnExited = !!current && current.status !== "connecting";
        return {
          sessions: patchSession(state.sessions, id, {
            ...(!isSsh && !spawnExited ? { status: "connected" as const } : {}),
            title: result.title,
          }),
        };
      });
    } catch (error) {
      if (isSpawnAbandoned(error)) return;
      const { category, message } = parseLumaError(error);
      set((state) => ({
        sessions: patchSession(state.sessions, id, {
          status: "error",
          errorCategory: category,
          errorMessage: message,
        }),
      }));
    }
  },

  retryReconnectNow: (id) => {
    clearReconnectTimer(id);
    if (sessionStillOpen(get, id)) void get().restartSession(id, { reconnect: true });
  },

  stopReconnect: (id) => {
    clearReconnectTimer(id);
    set((state) => ({
      sessions: patchSession(state.sessions, id, {
        status: "error",
        connectionState: "failed",
        nextRetryAt: null,
      }),
    }));
  },

  setLatency: (id, latencyMs) => {
    set((state) => {
      const session = state.sessions.find((s) => s.id === id);
      if (!session || session.latencyMs === latencyMs) return {};
      return { sessions: patchSession(state.sessions, id, { latencyMs }) };
    });
  },

  markHostSaved: (hostId) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.hostId === hostId && s.hostEphemeral
          ? { ...s, hostEphemeral: false }
          : s,
      ),
    }));
  },

  trustHostKey: (id) => resolveHostKeyDecision(id, "trust"),

  closeSession: (id) => {
    // Cancel an in-flight host-key preflight so its awaiting launch aborts
    // instead of spawning (closing the pane is the "Cancel" action).
    resolveHostKeyDecision(id, "cancel");
    // Stop any pending auto-reconnect so a closed pane never respawns.
    clearReconnectTimer(id);
    // Disposing the backend stops any active logging; clear our indicator too.
    useSessionLogStore.getState().markInactive(id);
    // Remember which tab owned this pane so its broadcast membership can be
    // re-synced after removal (dispose() already detached the closed session).
    const owningTabId = get().tabs.find((t) => findLeafBySession(t.root, id))?.id;
    terminalManager.dispose(id);
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const tabIndex = state.tabs.findIndex((t) => findLeafBySession(t.root, id));
      if (tabIndex < 0) return { sessions };

      const tab = state.tabs[tabIndex];
      const leaves = collectLeaves(tab.root);
      const target = leaves.find((l) => l.sessionId === id)!;
      const newRoot = removeLeaf(tab.root, target.id);

      const tabs = [...state.tabs];
      let activeTabId = state.activeTabId;
      if (newRoot === null) {
        tabs.splice(tabIndex, 1);
        if (activeTabId === tab.id) {
          activeTabId = tabs[Math.min(tabIndex, tabs.length - 1)]?.id ?? null;
        }
      } else {
        let activePaneId = tab.activePaneId;
        if (target.id === tab.activePaneId) {
          const remaining = collectLeaves(newRoot);
          const removedIndex = leaves.findIndex((l) => l.id === target.id);
          activePaneId =
            remaining[Math.min(removedIndex, remaining.length - 1)]?.id ??
            remaining[0].id;
        }
        // Dropping back to a single pane disables broadcast for the tab; drop the
        // closed session from any exclusion set so it can't linger.
        const stillMultiPane = collectLeaves(newRoot).length > 1;
        tabs[tabIndex] = {
          ...tab,
          root: newRoot,
          activePaneId,
          broadcastEnabled: stillMultiPane ? tab.broadcastEnabled : false,
          broadcastExcluded: (tab.broadcastExcluded ?? []).filter((sid) => sid !== id),
        };
      }
      return {
        sessions,
        tabs,
        activeTabId,
        activeSessionId: computeActiveSession(tabs, activeTabId),
      };
    });
    // Re-push the surviving membership (empty when the tab was removed or
    // dropped below two panes) so the manager's group matches the layout.
    syncBroadcast(get().tabs.find((t) => t.id === owningTabId));
    fallbackToHostsIfEmpty(get);
  },

  closeTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const doomed = collectLeaves(tab.root).map((l) => l.sessionId);
    for (const sessionId of doomed) {
      // Abort any pending host-key preflight before disposing the backend.
      resolveHostKeyDecision(sessionId, "cancel");
      // Stop any pending auto-reconnect for the closed sessions.
      clearReconnectTimer(sessionId);
      useSessionLogStore.getState().markInactive(sessionId);
      terminalManager.dispose(sessionId);
    }
    set((state) => {
      const doomedSet = new Set(doomed);
      const sessions = state.sessions.filter((s) => !doomedSet.has(s.id));
      const tabIndex = state.tabs.findIndex((t) => t.id === tabId);
      const tabs = state.tabs.filter((t) => t.id !== tabId);
      let activeTabId = state.activeTabId;
      if (activeTabId === tabId) {
        activeTabId = tabs[Math.min(tabIndex, tabs.length - 1)]?.id ?? null;
      }
      return {
        sessions,
        tabs,
        activeTabId,
        activeSessionId: computeActiveSession(tabs, activeTabId),
      };
    });
    fallbackToHostsIfEmpty(get);
  },

  setActiveTab: (tabId) => {
    useUiStore.getState().setTerminalSearchOpen(false);
    useUiStore.getState().showTerminal();
    set((state) => ({
      activeTabId: tabId,
      activeSessionId: computeActiveSession(state.tabs, tabId),
    }));
    const sessionId = computeActiveSession(get().tabs, tabId);
    if (sessionId) requestAnimationFrame(() => terminalManager.focus(sessionId));
  },

  focusPane: (tabId, paneId) => {
    set((state) => {
      const tabs = state.tabs.map((t) =>
        t.id === tabId ? { ...t, activePaneId: paneId } : t,
      );
      const activeSessionId = computeActiveSession(tabs, tabId);
      if (activeSessionId !== state.activeSessionId) {
        useUiStore.getState().setTerminalSearchOpen(false);
      }
      return { tabs, activeTabId: tabId, activeSessionId };
    });
    const sessionId = computeActiveSession(get().tabs, tabId);
    if (sessionId) terminalManager.focus(sessionId);
  },

  focusSession: (id) => {
    const tab = get().tabs.find((t) => findLeafBySession(t.root, id));
    if (!tab) return;
    const leaf = findLeafBySession(tab.root, id)!;
    get().focusPane(tab.id, leaf.id);
  },

  splitActivePane: async (direction) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return;
    const targetLeaf = findLeaf(tab.root, tab.activePaneId);
    if (!targetLeaf) return;
    const source = state.sessions.find((s) => s.id === targetLeaf.sessionId);

    const id = crypto.randomUUID();
    let descriptor: SpawnDescriptor;
    let session: TerminalSession;
    let title: string | undefined;
    // Duplicate the source pane's SSH host; otherwise open the default shell.
    if (source?.type === "ssh" && source.hostId) {
      descriptor = { kind: "ssh", hostId: source.hostId };
      title = source.title;
      session = {
        id,
        title: source.title,
        type: "ssh",
        hostId: source.hostId,
        connectionTarget: source.connectionTarget,
        status: "connecting",
        connectionStage: "starting",
        tabColor: source.tabColor ?? null,
        activePaneId: id,
        restore: {
          kind: "ssh",
          hostId: source.hostId,
          title: source.title,
          connectionTarget: source.connectionTarget,
          tabColor: source.tabColor ?? null,
        },
      };
    } else {
      descriptor = { kind: "local", ref: undefined };
      title = undefined;
      session = {
        id,
        title: "Terminal",
        type: "local",
        status: "connecting",
        activePaneId: id,
        restore: { kind: "local", ref: undefined },
      };
    }

    const newLeaf = makeLeaf(id);
    const newRoot = splitLeaf(tab.root, tab.activePaneId, direction, newLeaf);
    set((s) => ({
      sessions: [...s.sessions, session],
      tabs: s.tabs.map((t) =>
        t.id === tab.id ? { ...t, root: newRoot, activePaneId: newLeaf.id } : t,
      ),
      activeSessionId: id,
    }));
    await waitForPaneLayout();
    await launch(set, get, id, descriptor, title);
    // A new pane in an already-broadcasting tab joins the group automatically.
    syncBroadcast(get().tabs.find((t) => t.id === tab.id));
  },

  splitActivePaneWith: async (direction, restore) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return;
    const targetLeaf = findLeaf(tab.root, tab.activePaneId);
    if (!targetLeaf) return;

    const id = crypto.randomUUID();
    // Reuse the restore path so an SSH descriptor gets the same preflight and
    // error states as a normal open — the split just hosts a different host.
    const { session, descriptor, title } = sessionFromRestore(id, restore);

    const newLeaf = makeLeaf(id);
    const newRoot = splitLeaf(tab.root, tab.activePaneId, direction, newLeaf);
    set((s) => ({
      sessions: [...s.sessions, session],
      tabs: s.tabs.map((t) =>
        t.id === tab.id ? { ...t, root: newRoot, activePaneId: newLeaf.id } : t,
      ),
      activeSessionId: id,
    }));
    await waitForPaneLayout();
    await launch(set, get, id, descriptor, title);
    // A new pane in an already-broadcasting tab joins the group automatically.
    syncBroadcast(get().tabs.find((t) => t.id === tab.id));
  },

  mergeTabs: (sourceTabId, targetTabId, direction = "row", placement = "after", targetPaneId) => {
    if (sourceTabId === targetTabId) return;
    // Sessions grafted out of the source tab must not keep the source's broadcast
    // group; they re-join only if the target tab itself broadcasts (synced below).
    const movedSessionIds =
      get().tabs.find((t) => t.id === sourceTabId)?.root
        ? collectLeaves(get().tabs.find((t) => t.id === sourceTabId)!.root).map(
            (leaf) => leaf.sessionId,
          )
        : [];
    set((state) => {
      const source = state.tabs.find((t) => t.id === sourceTabId);
      const target = state.tabs.find((t) => t.id === targetTabId);
      if (!source || !target) return {};

      // Focus follows the dragged content: the source tab's previously active
      // leaf id is preserved by the graft (leaf ids are stable), so it stays a
      // valid pane id inside the merged tree.
      const draggedActivePaneId = source.activePaneId;

      let newRoot: PaneNode;
      if (targetPaneId) {
        newRoot = splitLeaf(
          target.root,
          targetPaneId,
          direction,
          source.root,
          placement,
        );
      } else if (target.root.kind === "split" && target.root.direction === direction) {
        // Append the source tree as a sibling of the same-direction split and
        // give every child an equal share (simple + deterministic).
        const children =
          placement === "before"
            ? [source.root, ...target.root.children]
            : [...target.root.children, source.root];
        newRoot = {
          ...target.root,
          children,
          sizes: children.map(() => 100 / children.length),
        };
      } else {
        newRoot = {
          kind: "split",
          id: crypto.randomUUID(),
          direction,
          children:
            placement === "before"
              ? [source.root, target.root]
              : [target.root, source.root],
          sizes: [50, 50],
        };
      }

      const tabs = state.tabs
        .filter((t) => t.id !== sourceTabId)
        .map((t) =>
          t.id === targetTabId
            ? { ...t, root: newRoot, activePaneId: draggedActivePaneId }
            : t,
        );
      return {
        tabs,
        activeTabId: targetTabId,
        activeSessionId: computeActiveSession(tabs, targetTabId),
      };
    });
    useUiStore.getState().showTerminal();
    for (const sid of movedSessionIds) terminalManager.clearBroadcastGroup(sid);
    syncBroadcast(get().tabs.find((t) => t.id === targetTabId));
    const sessionId = get().activeSessionId;
    if (sessionId) requestAnimationFrame(() => terminalManager.focus(sessionId));
  },

  openTemplate: (root) => {
    const newSessions: TerminalSession[] = [];
    const launches: PendingLaunch[] = [];
    const builtRoot = buildRestoredNode(root, newSessions, launches);
    const firstLeaf = collectLeaves(builtRoot)[0];
    if (!firstLeaf) return;

    const tab: WorkspaceTab = {
      id: crypto.randomUUID(),
      root: builtRoot,
      activePaneId: firstLeaf.id,
    };
    useUiStore.getState().closeNewTab();
    useUiStore.getState().showTerminal();
    set((state) => {
      const tabs = [...state.tabs, tab];
      return {
        sessions: [...state.sessions, ...newSessions],
        tabs,
        activeTabId: tab.id,
        activeSessionId: computeActiveSession(tabs, tab.id),
      };
    });

    // Spawn each pane independently: a failed pane is marked errored (existing
    // per-pane error UI) without blocking the rest of the template.
    for (const pending of launches) {
      void launch(set, get, pending.id, pending.descriptor, pending.title);
    }
  },

  restoreFromSnapshot: (snapshot) => {
    const newSessions: TerminalSession[] = [];
    const newTabs: WorkspaceTab[] = [];
    const launches: PendingLaunch[] = [];

    for (const snapTab of snapshot.tabs) {
      const root = buildRestoredNode(snapTab.root, newSessions, launches);
      const firstLeaf = collectLeaves(root)[0];
      if (!firstLeaf) continue;
      newTabs.push({
        id: crypto.randomUUID(),
        root,
        activePaneId: firstLeaf.id,
      });
    }
    if (newTabs.length === 0) return;

    const activeIndex = Math.min(
      Math.max(snapshot.activeTabIndex, 0),
      newTabs.length - 1,
    );
    const activeTab = newTabs[activeIndex];

    useUiStore.getState().showTerminal();
    set((state) => {
      const tabs = [...state.tabs, ...newTabs];
      return {
        sessions: [...state.sessions, ...newSessions],
        tabs,
        activeTabId: activeTab.id,
        activeSessionId: computeActiveSession(tabs, activeTab.id),
      };
    });

    // Spawn each pane independently: launch() marks a failed pane errored
    // (existing error UI) without blocking the rest of the restore.
    for (const pending of launches) {
      void launch(set, get, pending.id, pending.descriptor, pending.title);
    }
  },

  closeActivePane: () => {
    const state = get();
    if (!state.activeSessionId) return;
    get().closeSession(state.activeSessionId);
  },

  moveActivePaneToNext: () => {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (!tab) return {};
      const leaves = collectLeaves(tab.root);
      if (leaves.length < 2) return {};
      const idx = leaves.findIndex((l) => l.id === tab.activePaneId);
      const current = leaves[idx];
      const next = leaves[(idx + 1) % leaves.length];
      let root = setLeafSession(tab.root, current.id, next.sessionId);
      root = setLeafSession(root, next.id, current.sessionId);
      const tabs = state.tabs.map((t) =>
        t.id === tab.id ? { ...t, root, activePaneId: next.id } : t,
      );
      return {
        tabs,
        activeSessionId: computeActiveSession(tabs, state.activeTabId),
      };
    });
    const sessionId = get().activeSessionId;
    if (sessionId) requestAnimationFrame(() => terminalManager.focus(sessionId));
  },

  resizeSplit: (tabId, splitId, sizes) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? { ...t, root: setSplitSizes(t.root, splitId, sizes) }
          : t,
      ),
    }));
  },

  toggleBroadcast: (tabId) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? { ...t, broadcastEnabled: !t.broadcastEnabled, broadcastExcluded: [] }
          : t,
      ),
    }));
    syncBroadcast(get().tabs.find((t) => t.id === tabId));
  },

  toggleActiveBroadcast: () => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    // Broadcast only makes sense across multiple panes; the toggle is hidden in
    // the UI for single-pane tabs, so the shortcut/palette entry match that.
    if (!tab || collectLeaves(tab.root).length < 2) return;
    get().toggleBroadcast(tab.id);
  },

  setPaneBroadcast: (tabId, sessionId, enabled) => {
    set((state) => ({
      tabs: state.tabs.map((t) => {
        if (t.id !== tabId) return t;
        const excluded = new Set(t.broadcastExcluded ?? []);
        if (enabled) excluded.delete(sessionId);
        else excluded.add(sessionId);
        return { ...t, broadcastExcluded: [...excluded] };
      }),
    }));
    syncBroadcast(get().tabs.find((t) => t.id === tabId));
  },
}));
