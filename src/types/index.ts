import type { ShellRef } from "../lib/terminal";
import type { SerialConfig } from "../lib/serial";
import type { HostKeyFingerprint } from "../lib/ssh";

export type ThemeMode = "dark" | "light" | "system";

export type SidebarSection = "hosts" | "logs" | "sftp" | "snippets";

/**
 * Everything needed to RE-SPAWN a session on restore. Metadata only — no
 * terminal bytes or scrollback are ever captured. Mirrors the manager's
 * SpawnDescriptor so a restored pane launches through the same path as a normal
 * open.
 */
export type RestoreDescriptor =
  | { kind: "local"; ref?: ShellRef }
  | {
      kind: "ssh";
      hostId: string;
      /** Persisted display name so a restored pane shows the right label
       * immediately (offline, before the backend reports a title). Optional so
       * pre-existing snapshots without it still validate and fall back to the
       * generic "SSH" label. */
      title?: string;
      /** Persisted connection target (hostname) for the connecting overlay.
       * Optional for the same backward-compatibility reason as `title`. */
      connectionTarget?: string;
      /** Per-host tab accent color ("#RRGGBB") so a restored pane shows the same
       * tab color immediately. Optional; older snapshots simply have no color. */
      tabColor?: string | null;
    }
  | { kind: "serial"; config: SerialConfig };

export type TerminalSession = {
  id: string;
  title: string;
  type: "local" | "ssh" | "serial";
  hostId?: string;
  /** Serial port path (e.g. COM3, /dev/ttyUSB0) when type is "serial". */
  serialPort?: string;
  /** Serial baud rate when type is "serial". */
  serialBaud?: number;
  connectionTarget?: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  /** SSH auto-reconnect / health state, layered on top of `status`. Undefined
   * for sessions the reconnect engine has never touched (local/serial, or an
   * SSH session that never dropped). Metadata only — no terminal bytes. */
  connectionState?: "connected" | "reconnecting" | "failed" | "disconnected";
  /** 1-based count of the current auto-reconnect run; reset to 0 on a successful
   * (re)connection. Only meaningful while `connectionState` is "reconnecting". */
  reconnectAttempt?: number;
  /** Epoch-ms timestamp of the next scheduled reconnect attempt (drives the
   * in-pane countdown). Null/undefined while an attempt is actually in flight. */
  nextRetryAt?: number | null;
  /** Latest measured round-trip latency (ms) for a connected SSH session, or
   * null when the last probe failed. A plain number is fine in React state. */
  latencyMs?: number | null;
  /** True when this session's SSH host is an unsaved quick-connect (ephemeral)
   * host, enabling the "Save host…" affordance. Cleared after saving. */
  hostEphemeral?: boolean;
  /** Per-host tab accent color ("#RRGGBB") carried from the host at spawn time,
   * or null/undefined for no accent. Drives the colored tab strip in TabBar. */
  tabColor?: string | null;
  activePaneId: string;
  exitCode?: number | null;
  errorMessage?: string;
  /** SSH failure category (e.g. host-key-changed, auth-failed) when status is
   * "error". Undefined for local shells and clean disconnects. */
  errorCategory?: string | null;
  /** True when this error came from the SSH host-key PREFLIGHT that runs before
   * the terminal is spawned (the session never started). Drives the prominent
   * centered connection-error card instead of the bottom disconnect banner.
   * Undefined/false for runtime disconnects of sessions that were live. */
  preflightError?: boolean;
  connectionPrompt?:
    | { type: "host-key"; keys: HostKeyFingerprint[] }
    | { type: "credential"; label: string };
  connectionStage?: "starting" | "network" | "host-key" | "authentication" | "ready";
  connectionIssue?: string;
  /** Host keys observed on the network during the last host-key preflight scan
   * for this session. Populated only for the blocking `host-key-changed` error
   * state so the alert can show new-vs-known fingerprints for comparison. */
  hostKeyScanned?: HostKeyFingerprint[];
  /** Previously trusted host keys, populated alongside `hostKeyScanned` for the
   * `host-key-changed` comparison view. */
  hostKeyKnown?: HostKeyFingerprint[];
  /** Remote OS id reported by the backend `ssh-remote-os` event for an
   * authenticated SSH session; absent until detected (drives the tab distro
   * logo). One of the fixed backend ids; "unknown"/unrecognized falls back to
   * the generic server icon. */
  osId?: string;
  /** PRETTY_NAME from the remote's /etc/os-release when available (display-only;
   * used as the distro icon's tooltip/label). */
  osPrettyName?: string | null;
  /** How to re-spawn this session when restoring the workspace. Metadata only;
   * carries no terminal content. */
  restore?: RestoreDescriptor;
};

export type LumaError = {
  category: string;
  message: string;
};

/*
 * Split-pane layout model. A workspace tab owns a split tree; every leaf hosts
 * exactly one terminal session (managed outside React by terminalManager). Only
 * layout + session metadata live in React state — terminal bytes never do.
 */

/** Row = side-by-side panes (vertical divider); column = stacked (horizontal). */
export type SplitDirection = "row" | "column";

export type PaneNode =
  | { kind: "leaf"; id: string; sessionId: string }
  | {
      kind: "split";
      id: string;
      direction: SplitDirection;
      children: PaneNode[];
      /** Flex-grow weights for each child; normalized to sum to 100. */
      sizes: number[];
    };

export type WorkspaceTab = {
  id: string;
  root: PaneNode;
  /** The focused leaf pane in this tab. */
  activePaneId: string;
  /** Broadcast input: when true and the tab has more than one pane, keystrokes
   * typed into the focused pane are fanned out to every non-excluded pane in the
   * tab. Transient runtime state — never persisted in the workspace snapshot.
   * Reset to false automatically when the tab drops back to a single pane. */
  broadcastEnabled?: boolean;
  /** Session ids opted OUT of this tab's broadcast (per-pane include/exclude).
   * Only meaningful while `broadcastEnabled` is true. */
  broadcastExcluded?: string[];
};

export const SETTING_KEYS = {
  theme: "appearance.theme",
  fontSize: "terminal.fontSize",
  scrollback: "terminal.scrollback",
  defaultShell: "terminal.defaultShell",
  /** Device-local serialized workspace snapshot (tabs + layout + restore
   * descriptors). Never synced. */
  workspaceSnapshot: "workspace.snapshot",
  /** Device-local saved workspace templates (named grouped-tab layouts, stored
   * as SnapshotPaneNode roots — metadata only, never terminal bytes). */
  workspaceTemplates: "workspace.templates",
  /** Device-local toggle: restore the previous workspace on launch. Never
   * synced. */
  restoreSessions: "workspace.restoreSessions",
  /** Device-local toggle: check for app updates on launch. Never synced. */
  checkOnLaunch: "updates.checkOnLaunch",
  /** Serialized keymap: actionId -> chord string. Merged with defaults on load
   * (unknown actions dropped, missing actions get their default chord). */
  keymap: "keybindings.map",
  /** Device-local toggle: automatically reconnect dropped SSH sessions
   * (transient failures only). Default on. */
  autoReconnect: "ssh.autoReconnect",
  /** Selected terminal color scheme: a bundled/custom scheme id, or "auto" to
   * follow the app light/dark mode with Luma's palette. */
  terminalScheme: "terminal.scheme",
  /** Custom (imported) terminal color schemes, serialized as a JSON array. */
  terminalCustomThemes: "terminal.customThemes",
  /** Terminal font family (CSS font stack); empty falls back to the default. */
  terminalFontFamily: "terminal.fontFamily",
} as const;
