import { create } from "zustand";
import type {
  SplitDirection,
  TerminalSession,
  WorkspaceTab,
} from "../types";
import type { ShellRef } from "../lib/terminal";
import { parseLumaError } from "../lib/hosts";
import {
  terminalManager,
  type SessionExit,
  type SpawnDescriptor,
} from "../features/terminal/terminalManager";
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
  openSshSession: (hostId: string, title?: string) => Promise<void>;
  restartSession: (id: string) => Promise<void>;
  /** Close the pane hosting this session, collapsing its split (and its tab
   * when it was the last pane). */
  closeSession: (id: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  focusPane: (tabId: string, paneId: string) => void;
  /** Focus the pane hosting this session (used by the command palette). */
  focusSession: (id: string) => void;
  splitActivePane: (direction: SplitDirection) => Promise<void>;
  closeActivePane: () => void;
  /** Swap the active pane's session with the next pane in the tab. */
  moveActivePaneToNext: () => void;
  resizeSplit: (tabId: string, splitId: string, sizes: number[]) => void;
};

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
function makeCallbacks(set: SetFn, id: string) {
  return {
    onTitle: (title: string) =>
      set((state) => ({ sessions: patchSession(state.sessions, id, { title }) })),
    onExit: (exit: SessionExit) =>
      set((state) => ({
        sessions: patchSession(state.sessions, id, exitPatch(exit)),
      })),
    onSearchRequested: () => useUiStore.getState().setTerminalSearchOpen(true),
  };
}

/** Spawn a managed terminal for an already-registered session, then patch its
 * status to connected/error. */
async function launch(
  set: SetFn,
  id: string,
  descriptor: SpawnDescriptor,
  title: string | undefined,
): Promise<void> {
  try {
    const result = await terminalManager.createSession(
      id,
      descriptor,
      makeCallbacks(set, id),
    );
    set((state) => ({
      sessions: patchSession(state.sessions, id, {
        status: "connected",
        title: title ?? result.title,
      }),
    }));
  } catch (error) {
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

function newTab(sessionId: string): WorkspaceTab {
  const leaf = makeLeaf(sessionId);
  return { id: crypto.randomUUID(), root: leaf, activePaneId: leaf.id };
}

/** Open a new session (local or SSH) in a fresh tab and connect it. */
async function openInNewTab(
  set: SetFn,
  session: TerminalSession,
  descriptor: SpawnDescriptor,
  title: string | undefined,
): Promise<void> {
  const tab = newTab(session.id);
  useUiStore.getState().openSection("terminal");
  set((state) => ({
    sessions: [...state.sessions, session],
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
    activeSessionId: session.id,
  }));
  await launch(set, session.id, descriptor, title);
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
    };
    await openInNewTab(set, session, { kind: "local", ref }, title);
  },

  openSshSession: async (hostId, title) => {
    const id = crypto.randomUUID();
    const session: TerminalSession = {
      id,
      title: title ?? "SSH",
      type: "ssh",
      hostId,
      status: "connecting",
      activePaneId: id,
    };
    await openInNewTab(set, session, { kind: "ssh", hostId }, title);
  },

  restartSession: async (id) => {
    set((state) => ({
      sessions: patchSession(state.sessions, id, {
        status: "connecting",
        exitCode: undefined,
        errorMessage: undefined,
        errorCategory: undefined,
      }),
    }));
    try {
      const result = await terminalManager.restart(id);
      set((state) => ({
        sessions: patchSession(state.sessions, id, {
          status: "connected",
          title: result.title,
        }),
      }));
    } catch (error) {
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

  closeSession: (id) => {
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
        tabs[tabIndex] = { ...tab, root: newRoot, activePaneId };
      }
      return {
        sessions,
        tabs,
        activeTabId,
        activeSessionId: computeActiveSession(tabs, activeTabId),
      };
    });
  },

  closeTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const doomed = collectLeaves(tab.root).map((l) => l.sessionId);
    for (const sessionId of doomed) terminalManager.dispose(sessionId);
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
  },

  setActiveTab: (tabId) => {
    useUiStore.getState().setTerminalSearchOpen(false);
    useUiStore.getState().openSection("terminal");
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
        status: "connecting",
        activePaneId: id,
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
    await launch(set, id, descriptor, title);
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
}));

