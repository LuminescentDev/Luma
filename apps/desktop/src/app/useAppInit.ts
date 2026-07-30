import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { terminalManager } from "../features/terminal/terminalManager";
import { startLatencyMonitor } from "../features/terminal/latencyMonitor";
import { useUiStore } from "../stores/uiStore";
import { setAutoReconnectEnabled, useSessionStore } from "../stores/sessionStore";
import { useTemplateStore } from "../stores/templateStore";
import { useTunnelStore } from "../stores/tunnelStore";
import { useWebPreviewStore } from "../stores/webPreviewStore";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { parseShellRef } from "../lib/terminal";
import { getAllSettings } from "../lib/settings";
import {
  parseSnapshot,
  startSnapshotPersistence,
} from "../features/terminal/sessionSnapshot";
import { startLiveActivitySync } from "../features/mobile/liveActivity";
import { SETTING_KEYS } from "../types";
import { useKeymapStore } from "../stores/keymapStore";
import { useTerminalStyleStore } from "../stores/terminalStyleStore";
import { resolveAction, type KeymapActionId } from "../lib/keymap";
import { useUpdaterStore } from "../stores/updaterStore";
import { useCapabilityStore } from "../stores/capabilityStore";
import { useCollabStore } from "../stores/collabStore";
import { startAgentInboxListener } from "../stores/agentInboxStore";
import {
  collabGetConfig,
  parseCollaborationError,
  parseJoinToken,
  type JoinLinkPayload,
} from "../lib/collab";
import { joinRoomByCapability } from "../features/collaboration/collabClient";
import { parseVaultJoinLink } from "../lib/vaults";
import { hasPlatformModifier } from "../lib/platform";

/**
 * Handle a `luma://join?t=…` capability deep link. Parses the token, verifies it
 * targets the configured collaboration server, and either auto-redeems it (when
 * signed in) or stashes it for the collaboration dialog to retry after sign-in.
 * The token and its embedded secret are never logged.
 */
async function handleJoinDeepLink(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "luma:" || parsed.host !== "join") return;
  const token = parsed.searchParams.get("t");
  if (!token) return;

  const ui = useUiStore.getState();

  let payload: JoinLinkPayload;
  try {
    payload = parseJoinToken(token);
  } catch (error) {
    ui.openCollab({
      mode: "join",
      error: error instanceof Error ? error.message : "This join link is invalid.",
    });
    return;
  }

  try {
    const config = await collabGetConfig();
    if (payload.serverUrl !== config.serverUrl) {
      ui.openCollab({
        mode: "join",
        error:
          "This join link is for a different collaboration server than the one you are signed in to.",
      });
      return;
    }
  } catch (error) {
    ui.openCollab({ mode: "join", error: parseCollaborationError(error).message });
    return;
  }

  await useCollabStore.getState().refreshAuthStatus();
  const signedIn = useCollabStore.getState().auth?.status === "signedIn";
  if (!signedIn) {
    ui.openCollab({ mode: "join", joinToken: token });
    return;
  }

  try {
    await joinRoomByCapability(payload);
    ui.openCollab({ mode: "join" });
  } catch (error) {
    ui.openCollab({ mode: "join", error: parseCollaborationError(error).message });
  }
}

/**
 * Handle a `luma://vault?…` vault-join deep link by opening the join dialog
 * prefilled with the remote it names. A link is not access on its own: the
 * passphrase (and any provider credentials) are still typed by hand, so nothing
 * is joined without a deliberate action.
 */
function handleVaultDeepLink(url: string): boolean {
  const ui = useUiStore.getState();
  try {
    const link = parseVaultJoinLink(url);
    if (!link) return false;
    ui.openVaultJoin(link);
  } catch {
    // Malformed vault link: open the dialog empty rather than silently ignoring
    // it, so the user can paste a corrected one.
    ui.openVaultJoin();
  }
  return true;
}

/**
 * Shared application initialization, extracted from Layout so both the desktop
 * and mobile shells run exactly the same startup wiring: terminal config, theme,
 * latency monitor, tunnel/template/keymap/style hydration, workspace restore, the
 * global keyboard-shortcut handler, and the opt-out launch update check.
 *
 * Platform-specific behavior is gated off the capability store (never a
 * user-agent check): the launch update check is skipped when the updater feature
 * is unavailable (mobile), matching the hidden Updates UI there.
 */
export function useAppInit(): void {
  // Applies the persisted theme to <html> and tracks system changes.
  useTheme();
  const { data: settings } = useSettings();
  const updaterAvailable = useCapabilityStore((s) => s.capabilities.features.updater);
  const portForwardingAvailable = useCapabilityStore(
    (s) => s.capabilities.features.portForwarding,
  );
  const isIos = useCapabilityStore((s) => s.capabilities.os === "ios");
  const liveActivityEnabled =
    isIos && !!settings && settings[SETTING_KEYS.liveActivity] !== false; // default on

  // Push persisted terminal settings into the manager (outside React state).
  useEffect(() => {
    if (!settings) return;
    terminalManager.configure({
      scrollback: Number(settings[SETTING_KEYS.scrollback] ?? 5000),
      defaultShell: parseShellRef(settings[SETTING_KEYS.defaultShell]),
    });
    setAutoReconnectEnabled(settings[SETTING_KEYS.autoReconnect] !== false);
    // Off unless explicitly enabled: while it is off the manager neither tracks
    // the input line nor records any command history.
    terminalManager.setAutocompleteEnabled(
      settings[SETTING_KEYS.terminalAutocomplete] === true,
    );
  }, [settings]);

  // Poll connection health (latency) for connected SSH sessions.
  useEffect(() => startLatencyMonitor(), []);

  // Wire the collaboration client → store observer once (no network) so a
  // share/join started from anywhere reflects into React immediately. Auth
  // status is loaded lazily when the collaboration UI is opened.
  useEffect(() => {
    useCollabStore.getState().wire();
  }, []);

  // Subscribe once to `luma://…` deep links delivered as a window event,
  // cleaning up the listener on unmount.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const un = await getCurrentWindow().listen<string>("deep-link", (event) => {
        if (handleVaultDeepLink(event.payload)) return;
        void handleJoinDeepLink(event.payload);
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Subscribe once to backend `agent-event` notifications (Agent Inbox),
  // mirroring the `deep-link`/`ssh-remote-os` listener wiring.
  useEffect(() => startAgentInboxListener(), []);

  // Reflect any tunnels the backend already has running. Skipped on platforms
  // without the port-forwarding feature (mobile): its `tunnels_list` command is
  // not registered there, so hydrating would fire a failing invoke on startup.
  useEffect(() => {
    if (!portForwardingAvailable) return;
    void useTunnelStore.getState().hydrate();
    // Preview tunnels are ordinary tunnels behind the same capability, so the
    // preview dialog can list ones opened before this reload.
    void useWebPreviewStore.getState().hydrate();
  }, [portForwardingAvailable]);

  // Load saved workspace templates once.
  useEffect(() => {
    void useTemplateStore.getState().load();
  }, []);

  // Load the persisted keymap once and push the chord set into terminalManager.
  useEffect(() => {
    void useKeymapStore.getState().load();
  }, []);

  // Load persisted terminal Appearance styling once.
  useEffect(() => {
    void useTerminalStyleStore.getState().load();
  }, []);

  // Automatic, opt-out update check on launch. Skipped entirely on platforms
  // without the updater feature (mobile: store-managed updates).
  useEffect(() => {
    if (!settings) return;
    if (!updaterAvailable) return;
    if (settings[SETTING_KEYS.checkOnLaunch] === false) return; // default on
    if (useUpdaterStore.getState().autoChecked) return;
    const timer = setTimeout(() => {
      void useUpdaterStore.getState().autoCheck();
    }, 4000);
    return () => clearTimeout(timer);
  }, [settings, updaterAvailable]);

  // Mirror open connections and transfers to the iOS Live Activity (lock screen
  // and Dynamic Island). Opt-out; nothing runs on other platforms. Keyed on the
  // resolved flag rather than `settings` so an unrelated settings write does not
  // tear the running activity down and start a new one.
  useEffect(() => {
    if (!liveActivityEnabled) return;
    return startLiveActivitySync();
  }, [liveActivityEnabled]);

  // Restore the previous workspace (if enabled) then keep the snapshot fresh.
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void (async () => {
      try {
        const restoreSettings = await getAllSettings();
        const restoreEnabled =
          restoreSettings[SETTING_KEYS.restoreSessions] !== false; // default on
        const snapshot = parseSnapshot(
          restoreSettings[SETTING_KEYS.workspaceSnapshot],
        );
        const alreadyOpen = useSessionStore.getState().tabs.length > 0;
        if (
          !cancelled &&
          !alreadyOpen &&
          restoreEnabled &&
          snapshot &&
          snapshot.tabs.length > 0
        ) {
          useSessionStore.getState().restoreFromSnapshot(snapshot);
        }
      } catch {
        // First run or unreadable snapshot: start clean.
      } finally {
        if (!cancelled) stop = startSnapshotPersistence();
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // Global keyboard shortcuts (shared: harmless on mobile where the actions
  // simply no-op without the relevant panes).
  useEffect(() => {
    const cycleTab = (direction: 1 | -1) => {
      const { tabs, activeTabId, setActiveTab } = useSessionStore.getState();
      if (tabs.length < 2) return;
      const current = tabs.findIndex((tab) => tab.id === activeTabId);
      const base = current === -1 ? 0 : current;
      const next = (base + direction + tabs.length) % tabs.length;
      setActiveTab(tabs[next].id);
    };

    const runAction = (action: KeymapActionId) => {
      const session = useSessionStore.getState();
      switch (action) {
        case "workspace.newTab":
          useUiStore.getState().openNewTab();
          break;
        case "workspace.splitRight":
          void session.splitActivePane("row");
          break;
        case "workspace.splitDown":
          void session.splitActivePane("column");
          break;
        case "workspace.closePane":
          session.closeActivePane();
          break;
        case "workspace.commandPalette":
          useUiStore.getState().togglePalette();
          break;
        case "workspace.toggleBroadcast":
          session.toggleActiveBroadcast();
          break;
        case "terminal.jumpPreviousPrompt": {
          const id = session.activeSessionId;
          if (id) terminalManager.jumpToPrompt(id, "previous");
          break;
        }
        case "terminal.jumpNextPrompt": {
          const id = session.activeSessionId;
          if (id) terminalManager.jumpToPrompt(id, "next");
          break;
        }
        default:
          break;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const mod = hasPlatformModifier(event);

      if (event.ctrlKey && event.code === "Tab") {
        event.preventDefault();
        cycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      if (mod && (event.code === "PageUp" || event.code === "PageDown")) {
        event.preventDefault();
        cycleTab(event.code === "PageUp" ? -1 : 1);
        return;
      }

      const action = resolveAction(useKeymapStore.getState().keymap, event);
      if (action) {
        event.preventDefault();
        runAction(action);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
