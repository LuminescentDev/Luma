import { useEffect } from "react";
import { terminalManager } from "../features/terminal/terminalManager";
import { startLatencyMonitor } from "../features/terminal/latencyMonitor";
import { useUiStore } from "../stores/uiStore";
import { setAutoReconnectEnabled, useSessionStore } from "../stores/sessionStore";
import { useTemplateStore } from "../stores/templateStore";
import { useTunnelStore } from "../stores/tunnelStore";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { parseShellRef } from "../lib/terminal";
import { getAllSettings } from "../lib/settings";
import {
  parseSnapshot,
  startSnapshotPersistence,
} from "../features/terminal/sessionSnapshot";
import { SETTING_KEYS } from "../types";
import { useKeymapStore } from "../stores/keymapStore";
import { useTerminalStyleStore } from "../stores/terminalStyleStore";
import { resolveAction, type KeymapActionId } from "../lib/keymap";
import { useUpdaterStore } from "../stores/updaterStore";
import { useCapabilityStore } from "../stores/capabilityStore";
import { hasPlatformModifier } from "../lib/platform";

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

  // Push persisted terminal settings into the manager (outside React state).
  useEffect(() => {
    if (!settings) return;
    terminalManager.configure({
      scrollback: Number(settings[SETTING_KEYS.scrollback] ?? 5000),
      defaultShell: parseShellRef(settings[SETTING_KEYS.defaultShell]),
    });
    setAutoReconnectEnabled(settings[SETTING_KEYS.autoReconnect] !== false);
  }, [settings]);

  // Poll connection health (latency) for connected SSH sessions.
  useEffect(() => startLatencyMonitor(), []);

  // Reflect any tunnels the backend already has running. Skipped on platforms
  // without the port-forwarding feature (mobile): its `tunnels_list` command is
  // not registered there, so hydrating would fire a failing invoke on startup.
  useEffect(() => {
    if (!portForwardingAvailable) return;
    void useTunnelStore.getState().hydrate();
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
